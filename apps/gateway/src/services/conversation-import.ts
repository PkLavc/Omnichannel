import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createGunzip } from "node:zlib";
import {
  CommerceLinkKind,
  CommerceVerificationStatus,
  CommercialOutcomeStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { assessPromptInjection } from "./prompt-security.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_CHARACTERS = 100_000;
const DEFAULT_MAX_REJECTED_LINES = 1_000;
const MAX_BATCH_MESSAGES = 5_000;
const MAX_BATCH_CHARACTERS = 32 * 1024 * 1024;
const MESSAGE_INSERT_SIZE = 2_000;
const MAX_EXTERNAL_ID_CHARACTERS = 500;
const MAX_STATUS_CHARACTERS = 80;

type JsonRecord = Record<string, unknown>;

export type CanonicalConversationMessage = {
  externalId: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
  promptControlRemoved: boolean;
};

export type VerifiedCommercialOutcome = {
  status: "WON" | "LOST";
  source: string;
  evidence: Prisma.InputJsonValue;
  fingerprint: string;
};

export type VerifiedCommerceLink = {
  kind: "ORDER" | "PAYMENT";
  source: string;
  externalId: string;
  status: string;
  verificationEvidence: Prisma.InputJsonObject;
};

export type CanonicalConversation = {
  externalId: string;
  status: string;
  state: {
    contactId?: string;
    sector?: "commercial" | "support" | "postSale";
    activeAgent?: "intake" | "sales" | "customer_care" | "technical";
    sourceChannel?: string;
    hablla?: Prisma.InputJsonObject;
  };
  messages: CanonicalConversationMessage[];
  commercialOutcome?: VerifiedCommercialOutcome;
  commerceLink?: VerifiedCommerceLink;
  rejectedMessages: number;
  rejectedOutcome: boolean;
  rejectedCommerceLink: boolean;
  duplicateMessages: number;
};

export type ConversationNormalizationResult =
  | { ok: true; conversation: CanonicalConversation }
  | { ok: false; reason: string };

export type StreamedJsonRecord =
  | { ok: true; line: number; value: unknown }
  | { ok: false; line: number; reason: "line_too_large" | "invalid_json" | "invalid_record" };

export type ConversationImportProgress = {
  linesRead: number;
  conversationsAccepted: number;
  conversationsRejected: number;
  conversationsSkipped: number;
  messagesAccepted: number;
  messagesImported: number;
  batchesCompleted: number;
};

export type ConversationImportStats = ConversationImportProgress & {
  tenantId: string;
  file: string;
  dryRun: boolean;
  fileBytes: number;
  conversationsCreated: number;
  conversationsUpdated: number;
  messagesRejected: number;
  messagesDuplicate: number;
  promptControlsRemoved: number;
  commercialOutcomesAccepted: number;
  commercialOutcomesImported: number;
  commercialOutcomesDuplicate: number;
  commercialOutcomesRejected: number;
  commerceLinksAccepted: number;
  commerceLinksImported: number;
  commerceLinksDuplicate: number;
  commerceLinksRejected: number;
  durationMs: number;
};

export type ConversationImportReject = {
  line: number;
  reason: string;
};

export type ImportConversationArchiveOptions = {
  tenantId: string;
  file: string;
  source?: string;
  dryRun?: boolean;
  batchSize?: number;
  maxLineBytes?: number;
  maxMessageCharacters?: number;
  maxRejectedLines?: number;
  progressEvery?: number;
  onProgress?: (progress: ConversationImportProgress) => void | Promise<void>;
  onReject?: (reject: ConversationImportReject) => void | Promise<void>;
  recordFilter?: (value: unknown) => boolean;
  startAfterRecords?: number;
};

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function boundedText(value: unknown, maxCharacters: number) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  if (!normalized || normalized.length > maxCharacters) return undefined;
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseDate(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  let date: Date;
  if (typeof value === "number") {
    const timestamp = value < 10_000_000_000 ? value * 1_000 : value;
    date = new Date(timestamp);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d{10,13}$/u.test(trimmed)) {
      const numeric = Number(trimmed);
      date = new Date(trimmed.length === 10 ? numeric * 1_000 : numeric);
    } else {
      date = new Date(trimmed);
    }
  } else {
    return undefined;
  }
  const futureLimit = Date.now() + 24 * 60 * 60 * 1_000;
  return Number.isFinite(date.getTime()) && date.getTime() >= 0 && date.getTime() <= futureLimit
    ? date
    : undefined;
}

function digits(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/\D+/gu, "") : "";
}

function messageRole(message: JsonRecord, customerPhone?: string): "user" | "assistant" | undefined {
  const explicit = boundedText(message.role, 40)?.toLocaleLowerCase("en-US");
  if (["user", "customer", "client", "contact", "incoming"].includes(explicit ?? "")) return "user";
  if (["assistant", "agent", "bot", "outgoing"].includes(explicit ?? "")) return "assistant";
  if (explicit) return undefined;

  const messageType = firstDefined(message.message_type, message.messageType);
  if (messageType === 0 || String(messageType).toLocaleLowerCase("en-US") === "incoming") return "user";
  if (messageType === 1 || String(messageType).toLocaleLowerCase("en-US") === "outgoing") return "assistant";
  // Chatwoot activity/template messages are intentionally not treated as dialogue.
  if (messageType === 2 || String(messageType).toLocaleLowerCase("en-US") === "activity") return undefined;

  const sender = record(message.sender);
  const senderType = boundedText(firstDefined(message.sender_type, message.senderType, sender?.type), 80)
    ?.toLocaleLowerCase("en-US");
  if (senderType && /(?:contact|customer|client)/u.test(senderType)) return "user";
  if (senderType && /(?:user|agent|admin|bot)/u.test(senderType)) return "assistant";
  const customer = digits(customerPhone);
  if (customer && digits(message.from) === customer) return "user";
  if (customer && digits(message.to) === customer) return "assistant";
  if (message.isBot === true || record(message.user) || boundedText(message.user, 200)) return "assistant";
  return undefined;
}

function historicalStatus(value: unknown) {
  const status = boundedText(value, MAX_STATUS_CHARACTERS)?.toLocaleLowerCase("en-US");
  if (["active", "open", "resolved", "closed", "pending", "snoozed", "imported"].includes(status ?? "")) {
    return status!;
  }
  // Runtime control statuses (for example human_assigned) cannot be injected by
  // an archive and are deliberately collapsed to a neutral historical status.
  return "imported";
}

function normalizeMessage(
  message: unknown,
  conversationExternalId: string,
  ordinal: number,
  maxMessageCharacters: number,
  customerPhone?: string,
): CanonicalConversationMessage | undefined {
  const input = record(message);
  if (!input) return undefined;
  const role = messageRole(input, customerPhone);
  if (!role) return undefined;
  const nestedMessage = record(input.message);
  const rawContent = boundedText(
    firstDefined(
      input.content,
      input.text,
      input.body,
      nestedMessage?.body,
      nestedMessage?.text,
      nestedMessage?.caption,
      record(input.content_attributes)?.text,
    ),
    maxMessageCharacters,
  );
  if (!rawContent) return undefined;

  // Historical/customer content is always untrusted. Explicit attempts to take
  // control of the prompt are removed before they can enter a future runtime
  // history or a learning corpus. Roles such as system/developer/tool are never
  // accepted from an export.
  const assessment = assessPromptInjection(rawContent);
  const content = assessment.detected ? assessment.safeText.trim() : rawContent;
  if (!content) return undefined;

  const createdAt = parseDate(firstDefined(input.createdAt, input.created_at, input.lastUpdate, input.timestamp));
  const sourceExternalId = boundedText(
    firstDefined(input.externalId, input.external_id, input.message_id, input.messageId, input.id),
    MAX_EXTERNAL_ID_CHARACTERS,
  );
  const externalId = sourceExternalId ?? `import:${sha256([
    conversationExternalId,
    String(ordinal),
    role,
    createdAt?.toISOString() ?? "",
    content,
  ].join("\u0000"))}`;

  return {
    externalId,
    role,
    content,
    ...(createdAt ? { createdAt } : {}),
    promptControlRemoved: assessment.detected,
  };
}

function explicitOutcomeContainer(input: JsonRecord) {
  const direct = record(firstDefined(input.commercialOutcome, input.commercial_outcome));
  if (direct) return direct;

  const attributes = record(firstDefined(input.custom_attributes, input.customAttributes));
  const nested = record(firstDefined(attributes?.commercialOutcome, attributes?.commercial_outcome));
  if (nested) return nested;
  if (!attributes) return undefined;

  const status = firstDefined(attributes.commercial_outcome_status, attributes.sales_outcome_status);
  if (status === undefined) return undefined;
  return {
    status,
    verified: firstDefined(attributes.commercial_outcome_verified, attributes.sales_outcome_verified),
    verificationStatus: firstDefined(attributes.commercial_outcome_verification_status, attributes.sales_outcome_verification_status),
    source: firstDefined(attributes.commercial_outcome_source, attributes.sales_outcome_source),
    externalReference: attributes.commercial_outcome_reference,
    kind: firstDefined(attributes.commercial_outcome_kind, attributes.commerce_link_kind),
    orderId: firstDefined(attributes.order_id, attributes.orderId),
    paymentId: firstDefined(attributes.payment_id, attributes.paymentId),
    linkStatus: firstDefined(
      attributes.commerce_link_status,
      attributes.order_status,
      attributes.payment_status,
    ),
    evidence: firstDefined(attributes.commercial_outcome_evidence, attributes.sales_outcome_evidence),
  } satisfies JsonRecord;
}

function opaqueContactId(input: JsonRecord) {
  const meta = record(input.meta);
  const sender = record(input.sender);
  const metaSender = record(meta?.sender);
  const contact = record(input.contact);
  const service = record(input.service);
  const person = record(service?.person);
  const raw = boundedText(firstDefined(
    input.contactId,
    input.contact_id,
    input.customerId,
    input.customer_id,
    sender?.id,
    metaSender?.id,
    contact?.id,
    person?.id,
    service?.person_id,
    input.phone,
  ), MAX_EXTERNAL_ID_CHARACTERS);
  // The source identifier can be an e-mail/phone in imperfect exports. Only a
  // one-way opaque value is persisted, never the source value itself.
  return raw ? `import:${sha256(`historical-contact\u0000${raw}`)}` : undefined;
}

function normalizedLabel(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("pt-BR")
    : "";
}

function habllaRouting(service: JsonRecord) {
  const sector = record(service.sector);
  const reason = record(service.reason);
  const label = normalizedLabel([sector?.name, sector?.std_name, reason?.name, reason?.std_name].filter(Boolean).join(" "));
  if (/tecnic|manutenc|conserto|reparo|assistencia|suporte/u.test(label)) {
    return { activeAgent: "technical" as const, sector: "support" as const };
  }
  if (/garantia|pos venda|sac|reclam|cancel|financeir|status/u.test(label)) {
    return { activeAgent: "customer_care" as const, sector: "postSale" as const };
  }
  if (/comercial|venda|orcamento|compra|acessorio/u.test(label)) {
    return { activeAgent: "sales" as const, sector: "commercial" as const };
  }
  return { activeAgent: "intake" as const };
}

function explicitCommerceLink(
  raw: JsonRecord,
  outcomeStatus: "WON" | "LOST",
  source: string,
  evidence: Prisma.InputJsonValue,
): { link?: VerifiedCommerceLink; rejected: boolean } {
  const orderId = boundedText(firstDefined(raw.orderId, raw.order_id), 300);
  const paymentId = boundedText(firstDefined(raw.paymentId, raw.payment_id), 300);
  const genericReference = boundedText(
    firstDefined(raw.externalReference, raw.external_reference, raw.reference),
    300,
  );
  const explicitKind = boundedText(
    firstDefined(raw.kind, raw.referenceKind, raw.reference_kind, raw.commerceLinkKind, raw.commerce_link_kind),
    30,
  )?.toLocaleUpperCase("en-US");

  const suppliedReferences = [orderId, paymentId, genericReference].filter(Boolean);
  if (!suppliedReferences.length) return { rejected: false };
  if (suppliedReferences.length > 1) return { rejected: true };

  let kind: "ORDER" | "PAYMENT" | undefined;
  let externalId: string | undefined;
  if (orderId) {
    if (explicitKind && explicitKind !== "ORDER") return { rejected: true };
    kind = "ORDER";
    externalId = orderId;
  } else if (paymentId) {
    if (explicitKind && explicitKind !== "PAYMENT") return { rejected: true };
    kind = "PAYMENT";
    externalId = paymentId;
  } else if (genericReference) {
    if (explicitKind !== "ORDER" && explicitKind !== "PAYMENT") return { rejected: true };
    kind = explicitKind;
    externalId = genericReference;
  }
  if (!kind || !externalId) return { rejected: true };

  const explicitStatus = boundedText(firstDefined(
    raw.linkStatus,
    raw.link_status,
    raw.referenceStatus,
    raw.reference_status,
    raw.commerceStatus,
    raw.commerce_status,
    kind === "ORDER" ? firstDefined(raw.orderStatus, raw.order_status) : firstDefined(raw.paymentStatus, raw.payment_status),
  ), 100)?.toLocaleLowerCase("en-US");
  if (outcomeStatus === "LOST" && !explicitStatus) {
    // A lost conversation does not prove that an order/payment exists or what
    // happened to it. Keep the verified outcome but do not manufacture a link.
    return { rejected: false };
  }

  const verificationEvidence = {
    explicitVerification: true,
    referenceField: orderId ? "order_id" : paymentId ? "payment_id" : "externalReference",
    supplied: evidence,
  } as Prisma.InputJsonObject;
  return {
    rejected: false,
    link: {
      kind,
      source,
      externalId,
      status: outcomeStatus === "WON" ? "completed" : explicitStatus!,
      verificationEvidence,
    },
  };
}

function normalizeVerifiedOutcome(input: JsonRecord): {
  outcome?: VerifiedCommercialOutcome;
  commerceLink?: VerifiedCommerceLink;
  rejected: boolean;
  rejectedCommerceLink: boolean;
} {
  const raw = explicitOutcomeContainer(input);
  if (!raw) return { rejected: false, rejectedCommerceLink: false };

  const status = boundedText(raw.status, 20)?.toLocaleUpperCase("en-US");
  // PENDING is not evidence of a sale result and is never imported as learning truth.
  if (status !== "WON" && status !== "LOST") return { rejected: true, rejectedCommerceLink: false };
  const verificationStatus = boundedText(firstDefined(raw.verificationStatus, raw.verification_status), 30)
    ?.toLocaleUpperCase("en-US");
  const verified = raw.verified === true || verificationStatus === "VERIFIED";
  const source = boundedText(raw.source, 160);
  const externalReference = boundedText(
    firstDefined(raw.externalReference, raw.external_reference, raw.reference),
    300,
  );
  const orderId = boundedText(firstDefined(raw.orderId, raw.order_id), 300);
  const paymentId = boundedText(firstDefined(raw.paymentId, raw.payment_id), 300);
  const evidenceValue = firstDefined(raw.evidence, raw.verificationEvidence, raw.verification_evidence);
  const evidenceObject = record(evidenceValue);
  const evidenceArray = Array.isArray(evidenceValue) ? evidenceValue.slice(0, 100) : undefined;
  const hasEvidence = Boolean(externalReference || orderId || paymentId)
    || Boolean(evidenceObject && Object.keys(evidenceObject).length)
    || Boolean(evidenceArray?.length);
  if (!verified || !source || !hasEvidence) return { rejected: true, rejectedCommerceLink: false };

  const evidence: Prisma.InputJsonValue = {
    ...(evidenceObject ? { supplied: evidenceObject as Prisma.InputJsonObject } : {}),
    ...(evidenceArray ? { supplied: evidenceArray as Prisma.InputJsonArray } : {}),
    ...(externalReference ? { externalReference } : {}),
    ...(orderId ? { orderId } : {}),
    ...(paymentId ? { paymentId } : {}),
    verification: "explicit",
  };
  const commerce = explicitCommerceLink(raw, status, source, evidence);
  return {
    rejected: false,
    rejectedCommerceLink: commerce.rejected,
    outcome: {
      status,
      source,
      evidence,
      fingerprint: sha256(`${status}\u0000${source}\u0000${stableJson(evidence)}`),
    },
    ...(commerce.link ? { commerceLink: commerce.link } : {}),
  };
}

function conversationObject(value: JsonRecord) {
  const nested = record(value.conversation);
  if (!nested) return value;
  // Some exports wrap a conversation while leaving messages beside it.
  return {
    ...nested,
    ...(value.messages !== undefined && nested.messages === undefined ? { messages: value.messages } : {}),
    ...(value.commercialOutcome !== undefined && nested.commercialOutcome === undefined
      ? { commercialOutcome: value.commercialOutcome }
      : {}),
    ...(value.commercial_outcome !== undefined && nested.commercial_outcome === undefined
      ? { commercial_outcome: value.commercial_outcome }
      : {}),
    ...(value.sender !== undefined && nested.sender === undefined ? { sender: value.sender } : {}),
  };
}

/**
 * Maps the canonical shape and common Chatwoot conversation exports. It never
 * derives a commercial result, discount, policy, or other business fact from
 * message text.
 */
export function normalizeConversationRecord(
  value: unknown,
  options: { maxMessageCharacters?: number } = {},
): ConversationNormalizationResult {
  const root = record(value);
  if (!root) return { ok: false, reason: "record_must_be_an_object" };
  const input = conversationObject(root);
  const externalId = boundedText(
    firstDefined(input.externalId, input.external_id, input.conversation_id, input.id, input.display_id, input.displayId),
    MAX_EXTERNAL_ID_CHARACTERS,
  );
  if (!externalId) return { ok: false, reason: "conversation_external_id_required" };

  const rawMessages = Array.isArray(input.messages)
    ? input.messages
    : Array.isArray(record(input.meta)?.messages)
      ? record(input.meta)!.messages as unknown[]
      : undefined;
  if (!rawMessages) return { ok: false, reason: "conversation_messages_array_required" };

  const maxMessageCharacters = Math.max(
    1_000,
    Math.min(options.maxMessageCharacters ?? DEFAULT_MAX_MESSAGE_CHARACTERS, 1_000_000),
  );
  const messages: CanonicalConversationMessage[] = [];
  const customerPhone = boundedText(input.phone, 80);
  let rejectedMessages = 0;
  let duplicateMessages = 0;
  const seenMessageIds = new Set<string>();
  rawMessages.forEach((message, index) => {
    const normalized = normalizeMessage(message, externalId, index, maxMessageCharacters, customerPhone);
    if (!normalized) {
      rejectedMessages += 1;
      return;
    }
    if (seenMessageIds.has(normalized.externalId)) {
      duplicateMessages += 1;
      return;
    }
    seenMessageIds.add(normalized.externalId);
    messages.push(normalized);
  });
  if (!messages.length) return { ok: false, reason: "conversation_has_no_valid_messages" };

  const service = record(input.service);
  const status = historicalStatus(firstDefined(input.status, service?.status));
  const outcome = normalizeVerifiedOutcome(input);
  const contactId = opaqueContactId(input);
  const connection = record(service?.connection);
  const sectorRecord = record(service?.sector);
  const reason = record(service?.reason);
  const routing = service ? habllaRouting(service) : {};
  const cardIds = Array.isArray(service?.cards)
    ? service.cards.map(value => boundedText(value, 160)).filter((value): value is string => Boolean(value)).slice(0, 100)
    : [];
  const habllaMetadata: Prisma.InputJsonObject | undefined = service ? {
    ...(boundedText(connection?.id, 160) ? { connectionId: boundedText(connection?.id, 160)! } : {}),
    ...(boundedText(firstDefined(service.sector_id, sectorRecord?.id), 160)
      ? { sectorId: boundedText(firstDefined(service.sector_id, sectorRecord?.id), 160)! }
      : {}),
    ...(boundedText(firstDefined(service.reason_id, reason?.id), 160)
      ? { reasonId: boundedText(firstDefined(service.reason_id, reason?.id), 160)! }
      : {}),
    cardIds,
  } : undefined;
  return {
    ok: true,
    conversation: {
      externalId,
      status,
      state: {
        ...(contactId ? { contactId } : {}),
        ...routing,
        ...(boundedText(firstDefined(input.channel, connection?.type), 80)
          ? { sourceChannel: boundedText(firstDefined(input.channel, connection?.type), 80)! }
          : {}),
        ...(habllaMetadata ? { hablla: habllaMetadata } : {}),
      },
      messages,
      ...(outcome.outcome ? { commercialOutcome: outcome.outcome } : {}),
      ...(outcome.commerceLink ? { commerceLink: outcome.commerceLink } : {}),
      rejectedMessages,
      rejectedOutcome: outcome.rejected,
      rejectedCommerceLink: outcome.rejectedCommerceLink,
      duplicateMessages,
    },
  };
}

function parseLine(buffer: Buffer, line: number): StreamedJsonRecord | undefined {
  let text = buffer.toString("utf8").replace(/\r$/u, "");
  if (line === 1) text = text.replace(/^\uFEFF/u, "");
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value)) return { ok: false, line, reason: "invalid_record" };
    return { ok: true, line, value };
  } catch {
    return { ok: false, line, reason: "invalid_json" };
  }
}

/** Streams .jsonl/.ndjson, optionally gzip-compressed, with a hard line limit. */
export async function* streamConversationRecords(
  file: string,
  options: { maxLineBytes?: number; startAfterRecords?: number } = {},
): AsyncGenerator<StreamedJsonRecord> {
  const maxLineBytes = Math.max(1_024, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  const startAfterRecords = Math.max(0, options.startAfterRecords ?? 0);
  const sourceStat = await stat(file);
  if (sourceStat.isDirectory()) {
    let line = 0;
    async function* files(directory: string): AsyncGenerator<string> {
      const entries = [];
      const handle = await opendir(directory);
      for await (const entry of handle) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) yield* files(path);
        else if (entry.isFile() && extname(entry.name).toLocaleLowerCase("en-US") === ".json") yield path;
      }
    }
    for await (const path of files(file)) {
      line += 1;
      if (line <= startAfterRecords) continue;
      const info = await stat(path);
      if (info.size > maxLineBytes) {
        yield { ok: false, line, reason: "line_too_large" };
        continue;
      }
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!record(value)) yield { ok: false, line, reason: "invalid_record" };
        else yield { ok: true, line, value };
      } catch {
        yield { ok: false, line, reason: "invalid_json" };
      }
    }
    return;
  }
  const extension = extname(file).toLocaleLowerCase("en-US");
  const fileStream = createReadStream(file);
  const input = extension === ".gz" ? fileStream.pipe(createGunzip()) : fileStream;
  let line = 0;
  let pieces: Buffer[] = [];
  let length = 0;
  let oversized = false;

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (!oversized) {
        length += piece.length;
        if (length > maxLineBytes) {
          pieces = [];
          length = 0;
          oversized = true;
        } else if (piece.length) {
          pieces.push(piece);
        }
      }

      if (newline === -1) break;
      line += 1;
      if (oversized) {
        yield { ok: false, line, reason: "line_too_large" };
      } else {
        const parsed = parseLine(Buffer.concat(pieces, length), line);
        if (parsed) yield parsed;
      }
      pieces = [];
      length = 0;
      oversized = false;
      offset = newline + 1;
    }
  }

  if (pieces.length || oversized) {
    line += 1;
    if (oversized) yield { ok: false, line, reason: "line_too_large" };
    else {
      const parsed = parseLine(Buffer.concat(pieces, length), line);
      if (parsed) yield parsed;
    }
  }
}

function mergeBatch(conversations: CanonicalConversation[]) {
  const merged = new Map<string, CanonicalConversation>();
  let duplicateMessages = 0;
  for (const conversation of conversations) {
    const existing = merged.get(conversation.externalId);
    if (!existing) {
      merged.set(conversation.externalId, conversation);
      continue;
    }
    const known = new Set(existing.messages.map((message) => message.externalId));
    for (const message of conversation.messages) {
      if (known.has(message.externalId)) duplicateMessages += 1;
      else {
        known.add(message.externalId);
        existing.messages.push(message);
      }
    }
    existing.rejectedMessages += conversation.rejectedMessages;
    existing.rejectedOutcome ||= conversation.rejectedOutcome;
    existing.rejectedCommerceLink ||= conversation.rejectedCommerceLink;
    if (!existing.rejectedOutcome && !existing.commercialOutcome && conversation.commercialOutcome) {
      existing.commercialOutcome = conversation.commercialOutcome;
    } else if (
      existing.commercialOutcome
      && conversation.commercialOutcome
      && existing.commercialOutcome.fingerprint !== conversation.commercialOutcome.fingerprint
    ) {
      // Conflicting explicit outcomes in the same batch are not guessed or selected.
      existing.commercialOutcome = undefined;
      existing.rejectedOutcome = true;
    }
    if (!existing.rejectedCommerceLink && !existing.commerceLink && conversation.commerceLink) {
      existing.commerceLink = conversation.commerceLink;
    } else if (
      existing.commerceLink
      && conversation.commerceLink
      && stableJson(existing.commerceLink) !== stableJson(conversation.commerceLink)
    ) {
      existing.commerceLink = undefined;
      existing.rejectedCommerceLink = true;
    }
    if (!existing.state.contactId && conversation.state.contactId) {
      existing.state.contactId = conversation.state.contactId;
    }
  }
  return { conversations: [...merged.values()], duplicateMessages };
}

async function persistBatch(
  prisma: PrismaClient,
  tenantId: string,
  source: string,
  input: CanonicalConversation[],
) {
  const conversations = input;
  const ids = conversations.map((conversation) => conversation.externalId);
  const existing = await prisma.conversation.findMany({
    where: { tenantId, externalId: { in: ids } },
    select: { externalId: true },
  });
  const existingIds = new Set(existing.map((conversation) => conversation.externalId));
  let messagesImported = 0;
  let outcomesImported = 0;
  let outcomesDuplicate = 0;
  let commerceLinksImported = 0;
  let commerceLinksDuplicate = 0;
  let commerceLinksRejected = 0;

  await prisma.$transaction(async transaction => {
    await transaction.conversation.createMany({
      data: conversations.map((item) => ({
        tenantId,
        externalId: item.externalId,
        status: item.status,
        state: {
          ...item.state,
          historicalImport: {
            source,
            untrustedContent: true,
            operationalInstructionsAllowed: false,
          },
        },
      })),
      skipDuplicates: true,
    });

    const stateRows = conversations.map((item) => {
      const importedState = {
        ...item.state,
        historicalImport: {
          source,
          untrustedContent: true,
          operationalInstructionsAllowed: false,
        },
      };
      return Prisma.sql`(${item.externalId}, ${JSON.stringify(importedState)}::jsonb)`;
    });
    if (stateRows.length) {
      // Existing operational state wins on key collisions; imported metadata is
      // added atomically to every conversation in the batch.
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "Conversation" AS conversation
        SET state = imported.state || conversation.state
        FROM (VALUES ${Prisma.join(stateRows)}) AS imported("externalId", state)
        WHERE conversation."tenantId" = ${tenantId}
          AND conversation."externalId" = imported."externalId"
      `);
    }

    const persistedConversations = await transaction.conversation.findMany({
      where: { tenantId, externalId: { in: ids } },
      select: { id: true, externalId: true },
    });
    const internalIds = new Map(persistedConversations.map((conversation) => [conversation.externalId, conversation.id]));
    const messageRows = conversations.flatMap((item) => {
      const conversationId = internalIds.get(item.externalId);
      if (!conversationId) throw new Error(`failed to resolve imported conversation ${item.externalId}`);
      return item.messages.map((message) => ({
        conversationId,
        externalId: message.externalId,
        role: message.role,
        content: message.content,
        ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      }));
    });
    for (let offset = 0; offset < messageRows.length; offset += MESSAGE_INSERT_SIZE) {
      const inserted = await transaction.conversationMessage.createMany({
        data: messageRows.slice(offset, offset + MESSAGE_INSERT_SIZE),
        skipDuplicates: true,
      });
      messagesImported += inserted.count;
    }

    const outcomeRows = conversations.flatMap((item) => {
      if (!item.commercialOutcome) return [];
      const conversationId = internalIds.get(item.externalId);
      if (!conversationId) throw new Error(`failed to resolve imported conversation ${item.externalId}`);
      return [{
        conversationId,
        outcome: item.commercialOutcome,
        createdBy: `conversation-import:${item.commercialOutcome.fingerprint.slice(0, 64)}`,
      }];
    });
    if (outcomeRows.length) {
      const importedBefore = await transaction.commercialOutcome.findMany({
        where: {
          tenantId,
          conversationId: { in: outcomeRows.map((item) => item.conversationId) },
          createdBy: { in: outcomeRows.map((item) => item.createdBy) },
        },
        select: { conversationId: true, createdBy: true },
      });
      const known = new Set(importedBefore.map((item) => `${item.conversationId}\u0000${item.createdBy}`));
      const pending = outcomeRows.filter((item) => !known.has(`${item.conversationId}\u0000${item.createdBy}`));
      outcomesDuplicate += outcomeRows.length - pending.length;
      const revisions = pending.length
        ? await transaction.commercialOutcome.groupBy({
          by: ["conversationId"],
          where: { tenantId, conversationId: { in: pending.map((item) => item.conversationId) } },
          _max: { revision: true },
        })
        : [];
      const revisionsByConversation = new Map(revisions.map((item) => [item.conversationId, item._max.revision ?? 0]));
      const inserted = pending.length ? await transaction.commercialOutcome.createMany({
        data: pending.map((item) => ({
          tenantId,
          conversationId: item.conversationId,
          status: item.outcome.status === "WON"
            ? CommercialOutcomeStatus.WON
            : CommercialOutcomeStatus.LOST,
          source: item.outcome.source,
          confidence: 1,
          evidence: item.outcome.evidence,
          revision: (revisionsByConversation.get(item.conversationId) ?? 0) + 1,
          createdBy: item.createdBy,
        })),
        skipDuplicates: true,
      }) : { count: 0 };
      outcomesImported += inserted.count;
      outcomesDuplicate += pending.length - inserted.count;
    }

    const commerceRows = conversations.flatMap((item) => {
      if (!item.commerceLink) return [];
      const conversationId = internalIds.get(item.externalId);
      if (!conversationId) throw new Error(`failed to resolve imported conversation ${item.externalId}`);
      return [{ conversationId, link: item.commerceLink }];
    });
    if (commerceRows.length) {
      const linkKey = (item: { kind: string; source: string; externalId: string }) => (
        `${item.kind}\u0000${item.source}\u0000${item.externalId}`
      );
      const batchClaims = new Map<string, string>();
      const ambiguousKeys = new Set<string>();
      for (const item of commerceRows) {
        const key = linkKey(item.link);
        const claimedBy = batchClaims.get(key);
        if (claimedBy && claimedBy !== item.conversationId) ambiguousKeys.add(key);
        else batchClaims.set(key, item.conversationId);
      }
      const unambiguousRows = commerceRows.filter((item) => !ambiguousKeys.has(linkKey(item.link)));
      commerceLinksRejected += commerceRows.length - unambiguousRows.length;
      const existingLinks = await transaction.commerceLink.findMany({
        where: {
          tenantId,
          externalId: { in: unambiguousRows.map((item) => item.link.externalId) },
          source: { in: unambiguousRows.map((item) => item.link.source) },
          kind: {
            in: unambiguousRows.map((item) => item.link.kind === "ORDER"
              ? CommerceLinkKind.ORDER
              : CommerceLinkKind.PAYMENT),
          },
        },
        select: {
          conversationId: true,
          kind: true,
          source: true,
          externalId: true,
        },
      });
      const knownLinks = new Map(existingLinks.map((item) => [linkKey(item), item.conversationId]));
      const pendingLinks = unambiguousRows.filter((item) => {
        const key = linkKey(item.link);
        const linkedConversation = knownLinks.get(key);
        if (!linkedConversation) return true;
        if (linkedConversation === item.conversationId) commerceLinksDuplicate += 1;
        else commerceLinksRejected += 1;
        return false;
      });
      const verifiedAt = new Date();
      const insertedLinks = pendingLinks.length ? await transaction.commerceLink.createMany({
        data: pendingLinks.map((item) => ({
          tenantId,
          conversationId: item.conversationId,
          kind: item.link.kind === "ORDER" ? CommerceLinkKind.ORDER : CommerceLinkKind.PAYMENT,
          source: item.link.source,
          externalId: item.link.externalId,
          status: item.link.status,
          metadata: { historicalImport: true },
          verificationStatus: CommerceVerificationStatus.VERIFIED,
          verificationEvidence: item.link.verificationEvidence,
          verifiedAt,
        })),
        skipDuplicates: true,
      }) : { count: 0 };
      commerceLinksImported += insertedLinks.count;
      commerceLinksDuplicate += pendingLinks.length - insertedLinks.count;
    }
  }, { timeout: 120_000 });

  return {
    conversationsCreated: conversations.filter((conversation) => !existingIds.has(conversation.externalId)).length,
    conversationsUpdated: conversations.filter((conversation) => existingIds.has(conversation.externalId)).length,
    messagesImported,
    messagesDuplicate: conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0) - messagesImported,
    outcomesImported,
    outcomesDuplicate,
    commerceLinksImported,
    commerceLinksDuplicate,
    commerceLinksRejected,
  };
}

export async function importConversationArchive(
  prisma: PrismaClient,
  options: ImportConversationArchiveOptions,
): Promise<ConversationImportStats> {
  const startedAt = Date.now();
  const tenantId = boundedText(options.tenantId, 200);
  if (!tenantId) throw new Error("tenantId is required");
  const fileInfo = await stat(options.file);
  if (!fileInfo.isFile() && !fileInfo.isDirectory()) {
    throw new Error("conversation import path must be a file or directory");
  }
  if (fileInfo.isFile() && fileInfo.size === 0) throw new Error("conversation import file must be non-empty");
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1_000));
  const maxRejectedLines = Math.max(0, options.maxRejectedLines ?? DEFAULT_MAX_REJECTED_LINES);
  const progressEvery = Math.max(1, options.progressEvery ?? 1_000);
  const source = boundedText(options.source ?? "conversation_archive", 160) ?? "conversation_archive";
  const stats: ConversationImportStats = {
    tenantId,
    file: options.file,
    dryRun: options.dryRun === true,
    fileBytes: fileInfo.isFile() ? fileInfo.size : 0,
    linesRead: 0,
    conversationsAccepted: 0,
    conversationsRejected: 0,
    conversationsSkipped: 0,
    conversationsCreated: 0,
    conversationsUpdated: 0,
    messagesAccepted: 0,
    messagesImported: 0,
    messagesRejected: 0,
    messagesDuplicate: 0,
    promptControlsRemoved: 0,
    commercialOutcomesAccepted: 0,
    commercialOutcomesImported: 0,
    commercialOutcomesDuplicate: 0,
    commercialOutcomesRejected: 0,
    commerceLinksAccepted: 0,
    commerceLinksImported: 0,
    commerceLinksDuplicate: 0,
    commerceLinksRejected: 0,
    batchesCompleted: 0,
    durationMs: 0,
  };
  let batch: CanonicalConversation[] = [];
  let batchMessages = 0;
  let batchCharacters = 0;

  const progress = async () => {
    await options.onProgress?.({
      linesRead: stats.linesRead,
      conversationsAccepted: stats.conversationsAccepted,
      conversationsRejected: stats.conversationsRejected,
      conversationsSkipped: stats.conversationsSkipped,
      messagesAccepted: stats.messagesAccepted,
      messagesImported: stats.messagesImported,
      batchesCompleted: stats.batchesCompleted,
    });
  };

  const flush = async () => {
    if (!batch.length) return;
    const merged = mergeBatch(batch);
    stats.messagesDuplicate += merged.duplicateMessages;
    if (!stats.dryRun) {
      const persisted = await persistBatch(prisma, tenantId, source, merged.conversations);
      stats.conversationsCreated += persisted.conversationsCreated;
      stats.conversationsUpdated += persisted.conversationsUpdated;
      stats.messagesImported += persisted.messagesImported;
      stats.messagesDuplicate += persisted.messagesDuplicate;
      stats.commercialOutcomesImported += persisted.outcomesImported;
      stats.commercialOutcomesDuplicate += persisted.outcomesDuplicate;
      stats.commerceLinksImported += persisted.commerceLinksImported;
      stats.commerceLinksDuplicate += persisted.commerceLinksDuplicate;
      stats.commerceLinksRejected += persisted.commerceLinksRejected;
    }
    batch = [];
    batchMessages = 0;
    batchCharacters = 0;
    stats.batchesCompleted += 1;
    await progress();
  };

  stats.linesRead = Math.max(0, options.startAfterRecords ?? 0);
  for await (const streamed of streamConversationRecords(options.file, {
    maxLineBytes: options.maxLineBytes,
    startAfterRecords: options.startAfterRecords,
  })) {
    stats.linesRead = streamed.line;
    if (!streamed.ok) {
      stats.conversationsRejected += 1;
      await options.onReject?.({ line: streamed.line, reason: streamed.reason });
    } else {
      if (options.recordFilter && !options.recordFilter(streamed.value)) {
        stats.conversationsSkipped += 1;
        if (stats.linesRead % progressEvery === 0 && batch.length) await progress();
        continue;
      }
      const normalized = normalizeConversationRecord(streamed.value, {
        maxMessageCharacters: options.maxMessageCharacters,
      });
      if (!normalized.ok) {
        stats.conversationsRejected += 1;
        await options.onReject?.({ line: streamed.line, reason: normalized.reason });
      } else {
        const conversation = normalized.conversation;
        stats.conversationsAccepted += 1;
        stats.messagesAccepted += conversation.messages.length;
        stats.messagesRejected += conversation.rejectedMessages;
        stats.messagesDuplicate += conversation.duplicateMessages;
        stats.promptControlsRemoved += conversation.messages.filter((message) => message.promptControlRemoved).length;
        if (conversation.commercialOutcome) stats.commercialOutcomesAccepted += 1;
        if (conversation.rejectedOutcome) stats.commercialOutcomesRejected += 1;
        if (conversation.commerceLink) stats.commerceLinksAccepted += 1;
        if (conversation.rejectedCommerceLink) stats.commerceLinksRejected += 1;
        batch.push(conversation);
        batchMessages += conversation.messages.length;
        batchCharacters += conversation.messages.reduce((sum, message) => sum + message.content.length, 0);
        if (
          batch.length >= batchSize
          || batchMessages >= MAX_BATCH_MESSAGES
          || batchCharacters >= MAX_BATCH_CHARACTERS
        ) await flush();
      }
    }

    if (stats.conversationsRejected > maxRejectedLines) {
      throw new Error(`maximum rejected lines exceeded (${maxRejectedLines})`);
    }
    if (stats.linesRead % progressEvery === 0 && batch.length) await progress();
  }
  await flush();
  stats.durationMs = Date.now() - startedAt;
  return stats;
}
