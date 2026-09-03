import { createHash } from "node:crypto";
import {
  AutomaticEvaluationStatus,
  CommercialOutcomeStatus,
  CommerceLinkKind,
  CommerceVerificationStatus,
  DatasetExampleLabel,
  DatasetVersionStatus,
  HumanFeedbackVerdict,
  Prisma,
  PrismaClient,
  PromptReleaseKind,
  PromptReleaseStatus,
  PromptVersionStatus,
} from "@prisma/client";

const ASSISTANT_PROMPT_NAME = "assistant-bundle";
const HEURISTIC_EVALUATOR = "deterministic-conversation-rubric";
const HEURISTIC_EVALUATOR_VERSION = "1.0.0";

const successfulCommerceStatuses = new Set([
  "approved",
  "captured",
  "complete",
  "completed",
  "delivered",
  "fulfilled",
  "paid",
  "succeeded",
  "success",
  "won",
]);

const terminalNegativeCommerceStatuses = new Set([
  "cancelled",
  "canceled",
  "declined",
  "expired",
  "failed",
  "lost",
  "refunded",
  "voided",
]);

type JsonObject = Record<string, unknown>;

export type AssistantPromptBundle = {
  system: string;
  commercial: string;
  support: string;
  postSale: string;
};

export type CommercialOutcomeInput = {
  tenantId: string;
  conversationId: string;
  status: CommercialOutcomeStatus;
  source: string;
  confidence: number;
  evidence?: Prisma.InputJsonValue;
  createdBy?: string;
};

export type CommerceLinkInput = {
  tenantId: string;
  conversationId: string;
  kind: CommerceLinkKind;
  source: string;
  externalId: string;
  status: string;
  value?: number | null;
  currency?: string | null;
  metadata?: Prisma.InputJsonValue;
  verificationStatus?: CommerceVerificationStatus;
  verificationEvidence?: Prisma.InputJsonValue;
  observedAt?: Date | null;
};

export type HumanFeedbackInput = {
  tenantId: string;
  conversationId: string;
  messageId?: string | null;
  verdict: HumanFeedbackVerdict;
  score?: number | null;
  comment?: string | null;
  expectedResponse?: string | null;
  reviewerId: string;
  source?: string;
  metadata?: Prisma.InputJsonValue;
};

export type EvaluationMessage = {
  id?: string;
  role: string;
  content: string;
  createdAt?: Date;
};

export type HeuristicEvaluationInput = {
  messages: EvaluationMessage[];
  outcome?: {
    status: CommercialOutcomeStatus;
    confidence: number;
    source: string;
  } | null;
  feedback?: {
    verdict: HumanFeedbackVerdict;
    score?: number | null;
  }[];
  verifiedCommerceLinks?: number;
};

export type HeuristicEvaluationResult = {
  overallScore: number;
  dimensions: {
    responseCoverage: number;
    engagement: number;
    concision: number;
    commercialOutcome: number;
    outcomeEvidence: number;
    humanSatisfaction: number;
  };
  recommendations: string[];
  evidence: string[];
};

export type DatasetExampleInput = {
  tenantId: string;
  datasetVersionId: string;
  label: DatasetExampleLabel;
  input: string;
  response: string;
  expectedResponse?: string | null;
  rationale?: string | null;
  source: string;
  conversationId?: string | null;
  humanFeedbackId?: string | null;
  automaticEvaluationId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export class ContinuousImprovementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContinuousImprovementError";
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredText(value: string, field: string, max = 500): string {
  const normalized = value.trim();
  if (!normalized) throw new ContinuousImprovementError("invalid_input", `${field} is required`);
  if (normalized.length > max) {
    throw new ContinuousImprovementError("invalid_input", `${field} exceeds ${max} characters`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new ContinuousImprovementError("invalid_input", `text exceeds ${max} characters`);
  }
  return normalized || null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rounded(value: number): number {
  return Math.round(clamp01(value) * 10_000) / 10_000;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function parseAssistantPromptBundle(content: string): AssistantPromptBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ContinuousImprovementError("invalid_prompt_bundle", "prompt content must be valid JSON");
  }
  const value = asObject(parsed);
  const limits: Record<keyof AssistantPromptBundle, number> = {
    system: 30_000,
    commercial: 20_000,
    support: 20_000,
    postSale: 20_000,
  };
  const bundle = {} as AssistantPromptBundle;
  for (const [key, limit] of Object.entries(limits) as [keyof AssistantPromptBundle, number][]) {
    if (typeof value[key] !== "string") {
      throw new ContinuousImprovementError("invalid_prompt_bundle", `${key} must be a string`);
    }
    if ((value[key] as string).length > limit) {
      throw new ContinuousImprovementError("invalid_prompt_bundle", `${key} exceeds ${limit} characters`);
    }
    bundle[key] = (value[key] as string).trim();
  }
  return bundle;
}

export function serializeAssistantPromptBundle(bundle: AssistantPromptBundle): string {
  return JSON.stringify(parseAssistantPromptBundle(JSON.stringify(bundle)));
}

/**
 * Removes common customer identifiers before a conversation becomes a reusable
 * evaluation example. Generic markers intentionally avoid retaining a reversible
 * identifier or an unsalted hash that could be brute-forced.
 */
export function redactDatasetText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<EMAIL>")
    .replace(/(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/gu, "<CNPJ>")
    .replace(/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/gu, "<CPF>")
    .replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu, "<CARD>")
    .replace(
      /(?<![\p{L}\p{N}_-])(?:\+?55[\s().-]*)?\(?\d{2}\)?[\s.-]*9?\d{4}[-\s.]?\d{4}(?![\p{L}\p{N}_-])/gu,
      "<PHONE>",
    );
}

export function deterministicCanaryBucket(
  tenantId: string,
  promptDefinitionId: string,
  conversationExternalId: string,
): number {
  const digest = createHash("sha256")
    .update(`${tenantId}:${promptDefinitionId}:${conversationExternalId}`, "utf8")
    .digest();
  return Number(digest.readBigUInt64BE(0) % 100n);
}

export function evaluateConversationHeuristically(
  input: HeuristicEvaluationInput,
): HeuristicEvaluationResult {
  const messages = input.messages.filter(message => message.content.trim());
  const userMessages = messages.filter(message => message.role === "user");
  const assistantMessages = messages.filter(message => message.role === "assistant");

  let answeredUserMessages = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user") continue;
    if (messages.slice(index + 1).some(message => message.role === "assistant")) answeredUserMessages += 1;
  }
  const responseCoverage = userMessages.length
    ? answeredUserMessages / userMessages.length
    : assistantMessages.length ? 0.5 : 0;

  const totalTurns = userMessages.length + assistantMessages.length;
  const balance = totalTurns
    ? 1 - Math.abs(userMessages.length - assistantMessages.length) / totalTurns
    : 0;
  const engagement = clamp01(balance * Math.min(1, totalTurns / 6));

  const averageAssistantLength = assistantMessages.length
    ? assistantMessages.reduce((total, message) => total + message.content.trim().length, 0) / assistantMessages.length
    : 0;
  const concision = averageAssistantLength === 0
    ? 0
    : averageAssistantLength <= 900
      ? 1
      : clamp01(1 - (averageAssistantLength - 900) / 2_100);

  const commercialOutcome = input.outcome?.status === CommercialOutcomeStatus.WON
    ? 1
    : input.outcome?.status === CommercialOutcomeStatus.LOST
      ? 0.2
      : 0.55;
  const outcomeEvidence = input.outcome
    ? clamp01(input.outcome.confidence * (input.verifiedCommerceLinks ? 1 : 0.75))
    : 0.25;

  const feedback = input.feedback ?? [];
  const humanSatisfaction = feedback.length
    ? feedback.reduce((total, item) => {
      if (typeof item.score === "number") return total + clamp01((item.score + 100) / 200);
      if (item.verdict === HumanFeedbackVerdict.POSITIVE) return total + 1;
      if (item.verdict === HumanFeedbackVerdict.NEGATIVE) return total;
      return total + 0.5;
    }, 0) / feedback.length
    : 0.5;

  const dimensions = {
    responseCoverage: rounded(responseCoverage),
    engagement: rounded(engagement),
    concision: rounded(concision),
    commercialOutcome: rounded(commercialOutcome),
    outcomeEvidence: rounded(outcomeEvidence),
    humanSatisfaction: rounded(humanSatisfaction),
  };
  const overallScore = rounded(
    dimensions.responseCoverage * 0.22
    + dimensions.engagement * 0.12
    + dimensions.concision * 0.12
    + dimensions.commercialOutcome * 0.22
    + dimensions.outcomeEvidence * 0.14
    + dimensions.humanSatisfaction * 0.18,
  );

  const recommendations: string[] = [];
  if (dimensions.responseCoverage < 0.8) {
    recommendations.push("Responder todas as solicitações do cliente antes de encerrar a conversa.");
  }
  if (dimensions.engagement < 0.5) {
    recommendations.push("Confirmar a necessidade e conduzir a conversa para um próximo passo verificável.");
  }
  if (dimensions.concision < 0.7) {
    recommendations.push("Reduzir respostas longas e apresentar primeiro a ação ou informação principal.");
  }
  if (dimensions.outcomeEvidence < 0.7) {
    recommendations.push("Registrar pedido ou pagamento verificado antes de classificar o resultado comercial.");
  }
  if (dimensions.humanSatisfaction < 0.6) {
    recommendations.push("Revisar o feedback humano e criar um exemplo corrigido no dataset de avaliação.");
  }
  if (input.outcome?.status === CommercialOutcomeStatus.LOST) {
    recommendations.push("Revisar objeções, informações ausentes e o último próximo passo oferecido.");
  }

  const evidence = [
    `${userMessages.length} mensagens do cliente e ${assistantMessages.length} respostas da IA`,
    input.outcome
      ? `resultado ${input.outcome.status.toLowerCase()} por ${input.outcome.source} com confiança ${rounded(input.outcome.confidence)}`
      : "resultado comercial ainda não registrado",
    `${input.verifiedCommerceLinks ?? 0} vínculo(s) comercial(is) verificado(s)`,
    `${feedback.length} feedback(s) humano(s) considerado(s)`,
  ];

  return {
    overallScore,
    dimensions,
    recommendations,
    evidence,
  };
}

function compareBundles(baseContent: string, candidateContent: string) {
  const base = parseAssistantPromptBundle(baseContent);
  const candidate = parseAssistantPromptBundle(candidateContent);
  const fields = (Object.keys(base) as (keyof AssistantPromptBundle)[]).map(field => ({
    field,
    changed: base[field] !== candidate[field],
    baseLength: base[field].length,
    candidateLength: candidate[field].length,
    baseHash: sha256(base[field]),
    candidateHash: sha256(candidate[field]),
  }));
  return {
    changedFields: fields.filter(field => field.changed).map(field => field.field),
    fields,
  };
}

export class ContinuousImprovementService {
  constructor(private readonly prisma: PrismaClient) {}

  private async requireConversation(tenantId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true, externalId: true },
    });
    if (!conversation) {
      throw new ContinuousImprovementError("conversation_not_found", "conversation does not belong to tenant");
    }
    return conversation;
  }

  async recordCommercialOutcome(input: CommercialOutcomeInput) {
    await this.requireConversation(input.tenantId, input.conversationId);
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new ContinuousImprovementError("invalid_confidence", "confidence must be between 0 and 1");
    }
    const source = requiredText(input.source, "source", 160);
    const createdBy = optionalText(input.createdBy, 200);

    return this.prisma.$transaction(async transaction => {
      const previous = await transaction.commercialOutcome.findFirst({
        where: { tenantId: input.tenantId, conversationId: input.conversationId },
        orderBy: { revision: "desc" },
      });
      return transaction.commercialOutcome.create({
        data: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          status: input.status,
          source,
          confidence: input.confidence,
          evidence: input.evidence ?? [],
          revision: (previous?.revision ?? 0) + 1,
          supersedesId: previous?.id,
          createdBy,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async upsertCommerceLink(input: CommerceLinkInput) {
    await this.requireConversation(input.tenantId, input.conversationId);
    const source = requiredText(input.source, "source", 160);
    const externalId = requiredText(input.externalId, "externalId", 300);
    const status = requiredText(input.status, "status", 100).toLowerCase();
    const currency = input.currency ? input.currency.trim().toUpperCase() : null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      throw new ContinuousImprovementError("invalid_currency", "currency must be a three-letter ISO code");
    }
    if (input.value !== null && input.value !== undefined && (!Number.isFinite(input.value) || input.value < 0)) {
      throw new ContinuousImprovementError("invalid_value", "value must be zero or greater");
    }
    const verificationStatus = input.verificationStatus ?? CommerceVerificationStatus.UNVERIFIED;
    const verificationEvidence = asObject(input.verificationEvidence);
    if (
      verificationStatus !== CommerceVerificationStatus.UNVERIFIED
      && Object.keys(verificationEvidence).length === 0
    ) {
      throw new ContinuousImprovementError(
        "verification_evidence_required",
        "verified or rejected commerce links require verification evidence",
      );
    }

    const unique = {
      tenantId_kind_source_externalId: {
        tenantId: input.tenantId,
        kind: input.kind,
        source,
        externalId,
      },
    };
    const existing = await this.prisma.commerceLink.findUnique({
      where: unique,
      select: { conversationId: true },
    });
    if (existing && existing.conversationId !== input.conversationId) {
      throw new ContinuousImprovementError(
        "commerce_link_conflict",
        "the external order or payment is already linked to another conversation",
      );
    }

    return this.prisma.commerceLink.upsert({
      where: unique,
      create: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        kind: input.kind,
        source,
        externalId,
        status,
        value: input.value,
        currency,
        metadata: input.metadata ?? {},
        verificationStatus,
        verificationEvidence: json(verificationEvidence),
        verifiedAt: verificationStatus === CommerceVerificationStatus.VERIFIED ? new Date() : null,
        observedAt: input.observedAt,
      },
      update: {
        status,
        value: input.value,
        currency,
        metadata: input.metadata ?? {},
        verificationStatus,
        verificationEvidence: json(verificationEvidence),
        verifiedAt: verificationStatus === CommerceVerificationStatus.VERIFIED ? new Date() : null,
        observedAt: input.observedAt,
      },
    });
  }

  async recalculateCommercialOutcome(tenantId: string, conversationId: string) {
    await this.requireConversation(tenantId, conversationId);
    const links = await this.prisma.commerceLink.findMany({
      where: {
        tenantId,
        conversationId,
        verificationStatus: CommerceVerificationStatus.VERIFIED,
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });
    const normalized = links.map(link => link.status.trim().toLowerCase());
    const hasSuccess = normalized.some(status => successfulCommerceStatuses.has(status));
    const allTerminalNegative = normalized.length > 0
      && normalized.every(status => terminalNegativeCommerceStatuses.has(status));
    const status = hasSuccess
      ? CommercialOutcomeStatus.WON
      : allTerminalNegative
        ? CommercialOutcomeStatus.LOST
        : CommercialOutcomeStatus.PENDING;
    const confidence = hasSuccess ? 1 : allTerminalNegative ? 0.95 : links.length ? 0.6 : 0.25;
    const evidence = links.map(link => ({
      commerceLinkId: link.id,
      kind: link.kind,
      source: link.source,
      externalId: link.externalId,
      status: link.status,
      verifiedAt: link.verifiedAt?.toISOString() ?? null,
    }));
    const previous = await this.prisma.commercialOutcome.findFirst({
      where: { tenantId, conversationId },
      orderBy: { revision: "desc" },
    });
    if (
      previous?.source === "commerce_reconciliation"
      && previous.status === status
      && stableJson(previous.evidence) === stableJson(evidence)
    ) {
      return previous;
    }
    return this.recordCommercialOutcome({
      tenantId,
      conversationId,
      status,
      source: "commerce_reconciliation",
      confidence,
      evidence: json(evidence),
      createdBy: "system",
    });
  }

  async recordHumanFeedback(input: HumanFeedbackInput) {
    await this.requireConversation(input.tenantId, input.conversationId);
    if (
      input.score !== null
      && input.score !== undefined
      && (!Number.isInteger(input.score) || input.score < -100 || input.score > 100)
    ) {
      throw new ContinuousImprovementError("invalid_score", "feedback score must be an integer from -100 to 100");
    }
    if (input.messageId) {
      const message = await this.prisma.conversationMessage.findFirst({
        where: {
          id: input.messageId,
          conversationId: input.conversationId,
          conversation: { tenantId: input.tenantId },
        },
        select: { id: true },
      });
      if (!message) {
        throw new ContinuousImprovementError("message_not_found", "message does not belong to conversation and tenant");
      }
    }
    return this.prisma.humanFeedback.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        verdict: input.verdict,
        score: input.score,
        comment: optionalText(input.comment, 10_000),
        expectedResponse: optionalText(input.expectedResponse, 30_000),
        reviewerId: requiredText(input.reviewerId, "reviewerId", 200),
        source: requiredText(input.source ?? "admin", "source", 160),
        metadata: input.metadata ?? {},
      },
    });
  }

  async ensureDataset(
    tenantId: string,
    name: string,
    description?: string | null,
  ) {
    const normalizedName = requiredText(name, "name", 160);
    return this.prisma.evaluationDataset.upsert({
      where: { tenantId_name: { tenantId, name: normalizedName } },
      create: {
        tenantId,
        name: normalizedName,
        description: optionalText(description, 2_000),
      },
      update: {
        ...(description !== undefined ? { description: optionalText(description, 2_000) } : {}),
      },
    });
  }

  async createDatasetDraft(input: {
    tenantId: string;
    datasetId: string;
    createdBy: string;
    notes?: string | null;
    basedOnVersionId?: string | null;
    copyExamples?: boolean;
  }) {
    return this.prisma.$transaction(async transaction => {
      const dataset = await transaction.evaluationDataset.findFirst({
        where: { id: input.datasetId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!dataset) throw new ContinuousImprovementError("dataset_not_found", "dataset does not belong to tenant");
      const latest = await transaction.datasetVersion.findFirst({
        where: { tenantId: input.tenantId, datasetId: input.datasetId },
        orderBy: { version: "desc" },
      });
      const basedOnVersionId = input.basedOnVersionId ?? latest?.id ?? null;
      if (basedOnVersionId) {
        const base = await transaction.datasetVersion.findFirst({
          where: {
            id: basedOnVersionId,
            tenantId: input.tenantId,
            datasetId: input.datasetId,
          },
          select: { id: true },
        });
        if (!base) {
          throw new ContinuousImprovementError("dataset_version_not_found", "base version does not belong to dataset");
        }
      }
      const version = await transaction.datasetVersion.create({
        data: {
          tenantId: input.tenantId,
          datasetId: input.datasetId,
          version: (latest?.version ?? 0) + 1,
          basedOnVersionId,
          checksum: sha256(`${input.datasetId}:${(latest?.version ?? 0) + 1}:empty`),
          notes: optionalText(input.notes, 5_000),
          createdBy: requiredText(input.createdBy, "createdBy", 200),
        },
      });
      if (basedOnVersionId && input.copyExamples !== false) {
        const examples = await transaction.datasetExample.findMany({
          where: { tenantId: input.tenantId, datasetVersionId: basedOnVersionId },
        });
        if (examples.length) {
          await transaction.datasetExample.createMany({
            data: examples.map(example => ({
              tenantId: input.tenantId,
              datasetVersionId: version.id,
              conversationId: example.conversationId,
              humanFeedbackId: example.humanFeedbackId,
              automaticEvaluationId: example.automaticEvaluationId,
              label: example.label,
              input: example.input,
              response: example.response,
              expectedResponse: example.expectedResponse,
              rationale: example.rationale,
              source: example.source,
              metadata: example.metadata as Prisma.InputJsonValue,
              fingerprint: example.fingerprint,
            })),
          });
        }
      }
      return this.refreshDatasetChecksum(transaction, input.tenantId, version.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async refreshDatasetChecksum(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    datasetVersionId: string,
  ) {
    const examples = await transaction.datasetExample.findMany({
      where: { tenantId, datasetVersionId },
      orderBy: [{ fingerprint: "asc" }, { id: "asc" }],
      select: { fingerprint: true },
    });
    const checksum = sha256(examples.map(example => example.fingerprint).join(":"));
    return transaction.datasetVersion.update({
      where: { id: datasetVersionId },
      data: { checksum },
    });
  }

  async addDatasetExample(input: DatasetExampleInput) {
    return this.prisma.$transaction(async transaction => {
      const version = await transaction.datasetVersion.findFirst({
        where: {
          id: input.datasetVersionId,
          tenantId: input.tenantId,
          status: DatasetVersionStatus.DRAFT,
        },
        select: { id: true },
      });
      if (!version) {
        throw new ContinuousImprovementError("dataset_version_not_editable", "only a tenant-owned draft can be edited");
      }
      if (input.conversationId) {
        const conversation = await transaction.conversation.findFirst({
          where: { id: input.conversationId, tenantId: input.tenantId },
          select: { id: true },
        });
        if (!conversation) {
          throw new ContinuousImprovementError("conversation_not_found", "conversation does not belong to tenant");
        }
      }
      const normalized = {
        input: requiredText(redactDatasetText(input.input), "input", 100_000),
        response: requiredText(redactDatasetText(input.response), "response", 100_000),
        expectedResponse: optionalText(
          input.expectedResponse === null || input.expectedResponse === undefined
            ? input.expectedResponse
            : redactDatasetText(input.expectedResponse),
          100_000,
        ),
        rationale: optionalText(
          input.rationale === null || input.rationale === undefined
            ? input.rationale
            : redactDatasetText(input.rationale),
          20_000,
        ),
        source: requiredText(input.source, "source", 160),
      };
      const fingerprint = sha256(stableJson({
        label: input.label,
        input: normalized.input,
        response: normalized.response,
        expectedResponse: normalized.expectedResponse,
        source: normalized.source,
      }));
      const example = await transaction.datasetExample.upsert({
        where: {
          datasetVersionId_fingerprint: {
            datasetVersionId: input.datasetVersionId,
            fingerprint,
          },
        },
        create: {
          tenantId: input.tenantId,
          datasetVersionId: input.datasetVersionId,
          conversationId: input.conversationId,
          humanFeedbackId: input.humanFeedbackId,
          automaticEvaluationId: input.automaticEvaluationId,
          label: input.label,
          ...normalized,
          metadata: input.metadata ?? {},
          fingerprint,
        },
        update: {
          rationale: normalized.rationale,
          expectedResponse: normalized.expectedResponse,
          metadata: input.metadata ?? {},
        },
      });
      await this.refreshDatasetChecksum(transaction, input.tenantId, input.datasetVersionId);
      return example;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async publishDatasetVersion(input: {
    tenantId: string;
    datasetVersionId: string;
    publishedBy: string;
  }) {
    return this.prisma.$transaction(async transaction => {
      const version = await transaction.datasetVersion.findFirst({
        where: {
          id: input.datasetVersionId,
          tenantId: input.tenantId,
          status: DatasetVersionStatus.DRAFT,
        },
      });
      if (!version) {
        throw new ContinuousImprovementError("dataset_version_not_publishable", "only a tenant-owned draft can be published");
      }
      const exampleCount = await transaction.datasetExample.count({
        where: { tenantId: input.tenantId, datasetVersionId: input.datasetVersionId },
      });
      if (!exampleCount) {
        throw new ContinuousImprovementError("empty_dataset", "a dataset version needs at least one example");
      }
      await transaction.datasetVersion.updateMany({
        where: {
          tenantId: input.tenantId,
          datasetId: version.datasetId,
          status: DatasetVersionStatus.PUBLISHED,
        },
        data: { status: DatasetVersionStatus.ARCHIVED },
      });
      return transaction.datasetVersion.update({
        where: { id: input.datasetVersionId },
        data: {
          status: DatasetVersionStatus.PUBLISHED,
          publishedBy: requiredText(input.publishedBy, "publishedBy", 200),
          publishedAt: new Date(),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async runAutomaticEvaluation(input: {
    tenantId: string;
    conversationId: string;
    promptVersionId?: string | null;
  }) {
    await this.requireConversation(input.tenantId, input.conversationId);
    if (input.promptVersionId) {
      const prompt = await this.prisma.promptVersion.findFirst({
        where: { id: input.promptVersionId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!prompt) throw new ContinuousImprovementError("prompt_version_not_found", "prompt version does not belong to tenant");
    }
    const [messages, outcome, feedback, verifiedCommerceLinks] = await Promise.all([
      this.prisma.conversationMessage.findMany({
        where: {
          conversationId: input.conversationId,
          conversation: { tenantId: input.tenantId },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, createdAt: true },
      }),
      this.prisma.commercialOutcome.findFirst({
        where: { tenantId: input.tenantId, conversationId: input.conversationId },
        orderBy: { revision: "desc" },
      }),
      this.prisma.humanFeedback.findMany({
        where: { tenantId: input.tenantId, conversationId: input.conversationId },
        orderBy: { createdAt: "asc" },
        select: { verdict: true, score: true },
      }),
      this.prisma.commerceLink.count({
        where: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          verificationStatus: CommerceVerificationStatus.VERIFIED,
        },
      }),
    ]);
    const inputSnapshot = {
      messageIds: messages.map(message => message.id),
      outcomeRevision: outcome?.revision ?? null,
      feedbackCount: feedback.length,
      verifiedCommerceLinks,
    };
    const pending = await this.prisma.automaticEvaluation.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        promptVersionId: input.promptVersionId,
        evaluator: HEURISTIC_EVALUATOR,
        evaluatorVersion: HEURISTIC_EVALUATOR_VERSION,
        inputSnapshot: json(inputSnapshot),
      },
    });
    try {
      const result = evaluateConversationHeuristically({
        messages,
        outcome: outcome ? {
          status: outcome.status,
          confidence: Number(outcome.confidence),
          source: outcome.source,
        } : null,
        feedback,
        verifiedCommerceLinks,
      });
      return await this.prisma.automaticEvaluation.update({
        where: { id: pending.id },
        data: {
          status: AutomaticEvaluationStatus.COMPLETED,
          overallScore: result.overallScore,
          dimensions: json(result.dimensions),
          recommendations: json(result.recommendations),
          evidence: json(result.evidence),
          completedAt: new Date(),
        },
      });
    } catch (error) {
      await this.prisma.automaticEvaluation.update({
        where: { id: pending.id },
        data: {
          status: AutomaticEvaluationStatus.FAILED,
          error: error instanceof Error ? error.message.slice(0, 4_000) : "unknown evaluation error",
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async materializeEvaluationExample(input: {
    tenantId: string;
    evaluationId: string;
    datasetVersionId: string;
    goodThreshold?: number;
  }) {
    const evaluation = await this.prisma.automaticEvaluation.findFirst({
      where: {
        id: input.evaluationId,
        tenantId: input.tenantId,
        status: AutomaticEvaluationStatus.COMPLETED,
      },
    });
    if (!evaluation || evaluation.overallScore === null) {
      throw new ContinuousImprovementError("evaluation_not_ready", "completed evaluation not found");
    }
    const snapshot = asObject(evaluation.inputSnapshot);
    const snapshotMessageIds = Array.isArray(snapshot.messageIds)
      ? snapshot.messageIds.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    const messages = await this.prisma.conversationMessage.findMany({
      where: {
        conversationId: evaluation.conversationId,
        conversation: { tenantId: input.tenantId },
        ...(snapshotMessageIds.length ? { id: { in: snapshotMessageIds } } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });
    const lastAssistant = [...messages].reverse().find(message => message.role === "assistant");
    if (!lastAssistant) {
      throw new ContinuousImprovementError("assistant_response_not_found", "conversation has no assistant response");
    }
    const threshold = input.goodThreshold ?? 0.7;
    const score = Number(evaluation.overallScore);
    return this.addDatasetExample({
      tenantId: input.tenantId,
      datasetVersionId: input.datasetVersionId,
      conversationId: evaluation.conversationId,
      automaticEvaluationId: evaluation.id,
      label: score >= threshold ? DatasetExampleLabel.GOOD : DatasetExampleLabel.BAD,
      input: messages.map(message => `${message.role}: ${message.content}`).join("\n"),
      response: lastAssistant.content,
      rationale: (evaluation.recommendations as string[]).join("\n"),
      source: "automatic_evaluation",
      metadata: json({ score, evaluatorVersion: evaluation.evaluatorVersion }),
    });
  }

  async materializeFeedbackExample(input: {
    tenantId: string;
    feedbackId: string;
    datasetVersionId: string;
  }) {
    const feedback = await this.prisma.humanFeedback.findFirst({
      where: { id: input.feedbackId, tenantId: input.tenantId },
    });
    if (!feedback) throw new ContinuousImprovementError("feedback_not_found", "feedback does not belong to tenant");
    if (feedback.verdict === HumanFeedbackVerdict.NEUTRAL) {
      throw new ContinuousImprovementError(
        "neutral_feedback_not_trainable",
        "neutral feedback cannot be labeled as a good or bad dataset example",
      );
    }
    const messages = await this.prisma.conversationMessage.findMany({
      where: {
        conversationId: feedback.conversationId,
        conversation: { tenantId: input.tenantId },
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });
    const target = feedback.messageId
      ? await this.prisma.conversationMessage.findFirst({
        where: {
          id: feedback.messageId,
          conversationId: feedback.conversationId,
          conversation: { tenantId: input.tenantId },
        },
      })
      : [...messages].reverse().find(message => message.role === "assistant");
    if (!target) throw new ContinuousImprovementError("assistant_response_not_found", "feedback has no assistant response");
    return this.addDatasetExample({
      tenantId: input.tenantId,
      datasetVersionId: input.datasetVersionId,
      conversationId: feedback.conversationId,
      humanFeedbackId: feedback.id,
      label: feedback.verdict === HumanFeedbackVerdict.NEGATIVE
        ? DatasetExampleLabel.BAD
        : DatasetExampleLabel.GOOD,
      input: messages.map(message => `${message.role}: ${message.content}`).join("\n"),
      response: target.content,
      expectedResponse: feedback.expectedResponse,
      rationale: feedback.comment,
      source: "human_feedback",
      metadata: json({ verdict: feedback.verdict, score: feedback.score }),
    });
  }

  async createPromptVersion(input: {
    tenantId: string;
    promptName?: string;
    description?: string | null;
    content: string | AssistantPromptBundle;
    variables?: Prisma.InputJsonValue;
    metadata?: Prisma.InputJsonValue;
    createdBy: string;
  }) {
    const promptName = requiredText(input.promptName ?? ASSISTANT_PROMPT_NAME, "promptName", 160);
    const content = typeof input.content === "string"
      ? input.content
      : serializeAssistantPromptBundle(input.content);
    if (promptName === ASSISTANT_PROMPT_NAME) parseAssistantPromptBundle(content);
    const checksum = sha256(content);
    return this.prisma.$transaction(async transaction => {
      const definition = await transaction.promptDefinition.upsert({
        where: { tenantId_name: { tenantId: input.tenantId, name: promptName } },
        create: {
          tenantId: input.tenantId,
          name: promptName,
          description: optionalText(input.description, 2_000),
        },
        update: {
          ...(input.description !== undefined ? { description: optionalText(input.description, 2_000) } : {}),
        },
      });
      const duplicate = await transaction.promptVersion.findUnique({
        where: {
          promptDefinitionId_checksum: {
            promptDefinitionId: definition.id,
            checksum,
          },
        },
      });
      if (duplicate) return duplicate;
      const latest = await transaction.promptVersion.findFirst({
        where: { tenantId: input.tenantId, promptDefinitionId: definition.id },
        orderBy: { version: "desc" },
      });
      return transaction.promptVersion.create({
        data: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          version: (latest?.version ?? 0) + 1,
          content,
          variables: input.variables ?? [],
          metadata: input.metadata ?? {},
          checksum,
          createdBy: requiredText(input.createdBy, "createdBy", 200),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async approvePromptVersion(input: {
    tenantId: string;
    promptVersionId: string;
    approvedBy: string;
  }) {
    const version = await this.prisma.promptVersion.findFirst({
      where: { id: input.promptVersionId, tenantId: input.tenantId },
      include: { promptDefinition: { select: { name: true } } },
    });
    if (!version) throw new ContinuousImprovementError("prompt_version_not_found", "prompt version does not belong to tenant");
    if (version.promptDefinition.name === ASSISTANT_PROMPT_NAME) parseAssistantPromptBundle(version.content);
    if (version.status === PromptVersionStatus.RETIRED) {
      throw new ContinuousImprovementError("prompt_version_retired", "retired prompt versions cannot be approved");
    }
    if (version.status === PromptVersionStatus.APPROVED) return version;
    return this.prisma.promptVersion.update({
      where: { id: version.id },
      data: {
        status: PromptVersionStatus.APPROVED,
        approvedBy: requiredText(input.approvedBy, "approvedBy", 200),
        approvedAt: new Date(),
      },
    });
  }

  async comparePromptVersions(input: {
    tenantId: string;
    baseVersionId: string;
    candidateVersionId: string;
    createdBy: string;
  }) {
    if (input.baseVersionId === input.candidateVersionId) {
      throw new ContinuousImprovementError("same_prompt_version", "comparison requires two different versions");
    }
    const versions = await this.prisma.promptVersion.findMany({
      where: {
        tenantId: input.tenantId,
        id: { in: [input.baseVersionId, input.candidateVersionId] },
      },
      include: { promptDefinition: { select: { name: true } } },
    });
    const base = versions.find(version => version.id === input.baseVersionId);
    const candidate = versions.find(version => version.id === input.candidateVersionId);
    if (!base || !candidate || base.promptDefinitionId !== candidate.promptDefinitionId) {
      throw new ContinuousImprovementError(
        "prompt_comparison_invalid",
        "versions must belong to the same tenant and prompt definition",
      );
    }
    const diff = base.promptDefinition.name === ASSISTANT_PROMPT_NAME
      ? compareBundles(base.content, candidate.content)
      : {
        changed: base.content !== candidate.content,
        baseLength: base.content.length,
        candidateLength: candidate.content.length,
        baseHash: base.checksum,
        candidateHash: candidate.checksum,
      };
    return this.prisma.promptComparison.upsert({
      where: {
        tenantId_baseVersionId_candidateVersionId: {
          tenantId: input.tenantId,
          baseVersionId: base.id,
          candidateVersionId: candidate.id,
        },
      },
      create: {
        tenantId: input.tenantId,
        promptDefinitionId: base.promptDefinitionId,
        baseVersionId: base.id,
        candidateVersionId: candidate.id,
        diff: json(diff),
        createdBy: requiredText(input.createdBy, "createdBy", 200),
      },
      update: {
        diff: json(diff),
        createdBy: requiredText(input.createdBy, "createdBy", 200),
      },
    });
  }

  private async requireApprovedPromptVersion(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    promptDefinitionId: string,
    promptVersionId: string,
  ) {
    const version = await transaction.promptVersion.findFirst({
      where: {
        id: promptVersionId,
        tenantId,
        promptDefinitionId,
        status: PromptVersionStatus.APPROVED,
      },
    });
    if (!version) {
      throw new ContinuousImprovementError(
        "prompt_version_not_approved",
        "release versions must be approved and belong to the same tenant and prompt",
      );
    }
    return version;
  }

  async deployPrompt(input: {
    tenantId: string;
    promptName?: string;
    primaryVersionId: string;
    canaryVersionId?: string | null;
    canaryPercent?: number;
    createdBy: string;
    reason?: string | null;
  }) {
    const promptName = requiredText(input.promptName ?? ASSISTANT_PROMPT_NAME, "promptName", 160);
    const canaryPercent = input.canaryVersionId ? input.canaryPercent ?? 10 : 0;
    if (
      !Number.isInteger(canaryPercent)
      || canaryPercent < 0
      || canaryPercent > 99
      || (!input.canaryVersionId && canaryPercent !== 0)
    ) {
      throw new ContinuousImprovementError("invalid_canary_percent", "canary percentage must be 1-99, or zero without a canary");
    }
    if (input.canaryVersionId === input.primaryVersionId) {
      throw new ContinuousImprovementError("invalid_canary_version", "primary and canary versions must differ");
    }
    return this.prisma.$transaction(async transaction => {
      const definition = await transaction.promptDefinition.findUnique({
        where: { tenantId_name: { tenantId: input.tenantId, name: promptName } },
      });
      if (!definition) throw new ContinuousImprovementError("prompt_not_found", "prompt definition does not belong to tenant");
      await this.requireApprovedPromptVersion(
        transaction,
        input.tenantId,
        definition.id,
        input.primaryVersionId,
      );
      if (input.canaryVersionId) {
        await this.requireApprovedPromptVersion(
          transaction,
          input.tenantId,
          definition.id,
          input.canaryVersionId,
        );
      }
      const current = await transaction.promptRelease.findFirst({
        where: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          status: PromptReleaseStatus.ACTIVE,
        },
      });
      if (current) {
        await transaction.promptRelease.update({
          where: { id: current.id },
          data: { status: PromptReleaseStatus.ENDED, endedAt: new Date() },
        });
      }
      return transaction.promptRelease.create({
        data: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          primaryVersionId: input.primaryVersionId,
          canaryVersionId: input.canaryVersionId,
          canaryPercent,
          kind: input.canaryVersionId ? PromptReleaseKind.CANARY : PromptReleaseKind.ACTIVE,
          previousReleaseId: current?.id,
          reason: optionalText(input.reason, 5_000),
          createdBy: requiredText(input.createdBy, "createdBy", 200),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async selectPromptVersion(input: {
    tenantId: string;
    conversationExternalId: string;
    promptName?: string;
  }) {
    const promptName = requiredText(input.promptName ?? ASSISTANT_PROMPT_NAME, "promptName", 160);
    const definition = await this.prisma.promptDefinition.findUnique({
      where: { tenantId_name: { tenantId: input.tenantId, name: promptName } },
      select: { id: true, name: true },
    });
    if (!definition) return null;
    const release = await this.prisma.promptRelease.findFirst({
      where: {
        tenantId: input.tenantId,
        promptDefinitionId: definition.id,
        status: PromptReleaseStatus.ACTIVE,
      },
      include: {
        primaryVersion: true,
        canaryVersion: true,
      },
    });
    if (!release) return null;
    const bucket = deterministicCanaryBucket(
      input.tenantId,
      definition.id,
      requiredText(input.conversationExternalId, "conversationExternalId", 500),
    );
    const useCanary = Boolean(
      release.canaryVersion
      && release.canaryPercent > 0
      && bucket < release.canaryPercent,
    );
    const version = useCanary ? release.canaryVersion! : release.primaryVersion;
    return {
      releaseId: release.id,
      versionId: version.id,
      version: version.version,
      content: version.content,
      bundle: definition.name === ASSISTANT_PROMPT_NAME
        ? parseAssistantPromptBundle(version.content)
        : null,
      isCanary: useCanary,
      bucket,
    };
  }

  async promoteCanary(input: {
    tenantId: string;
    promptName?: string;
    createdBy: string;
    reason?: string | null;
  }) {
    const promptName = requiredText(input.promptName ?? ASSISTANT_PROMPT_NAME, "promptName", 160);
    return this.prisma.$transaction(async transaction => {
      const definition = await transaction.promptDefinition.findUnique({
        where: { tenantId_name: { tenantId: input.tenantId, name: promptName } },
      });
      if (!definition) throw new ContinuousImprovementError("prompt_not_found", "prompt definition does not belong to tenant");
      const current = await transaction.promptRelease.findFirst({
        where: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          status: PromptReleaseStatus.ACTIVE,
          kind: PromptReleaseKind.CANARY,
        },
      });
      if (!current?.canaryVersionId) {
        throw new ContinuousImprovementError("canary_not_found", "there is no active canary to promote");
      }
      await transaction.promptRelease.update({
        where: { id: current.id },
        data: { status: PromptReleaseStatus.ENDED, endedAt: new Date() },
      });
      return transaction.promptRelease.create({
        data: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          primaryVersionId: current.canaryVersionId,
          canaryPercent: 0,
          kind: PromptReleaseKind.ACTIVE,
          previousReleaseId: current.id,
          reason: optionalText(input.reason, 5_000) ?? "canary promoted",
          createdBy: requiredText(input.createdBy, "createdBy", 200),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async rollbackPrompt(input: {
    tenantId: string;
    promptName?: string;
    targetVersionId?: string | null;
    createdBy: string;
    reason: string;
  }) {
    const promptName = requiredText(input.promptName ?? ASSISTANT_PROMPT_NAME, "promptName", 160);
    return this.prisma.$transaction(async transaction => {
      const definition = await transaction.promptDefinition.findUnique({
        where: { tenantId_name: { tenantId: input.tenantId, name: promptName } },
      });
      if (!definition) throw new ContinuousImprovementError("prompt_not_found", "prompt definition does not belong to tenant");
      const current = await transaction.promptRelease.findFirst({
        where: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          status: PromptReleaseStatus.ACTIVE,
        },
      });
      if (!current) throw new ContinuousImprovementError("prompt_release_not_found", "there is no active prompt release");
      const previous = current.previousReleaseId
        ? await transaction.promptRelease.findFirst({
          where: {
            id: current.previousReleaseId,
            tenantId: input.tenantId,
            promptDefinitionId: definition.id,
          },
        })
        : null;
      const targetVersionId = input.targetVersionId ?? previous?.primaryVersionId;
      if (!targetVersionId) {
        throw new ContinuousImprovementError("rollback_target_not_found", "there is no previous release to restore");
      }
      await this.requireApprovedPromptVersion(
        transaction,
        input.tenantId,
        definition.id,
        targetVersionId,
      );
      await transaction.promptRelease.update({
        where: { id: current.id },
        data: { status: PromptReleaseStatus.ENDED, endedAt: new Date() },
      });
      return transaction.promptRelease.create({
        data: {
          tenantId: input.tenantId,
          promptDefinitionId: definition.id,
          primaryVersionId: targetVersionId,
          canaryPercent: 0,
          kind: PromptReleaseKind.ROLLBACK,
          previousReleaseId: current.id,
          reason: requiredText(input.reason, "reason", 5_000),
          createdBy: requiredText(input.createdBy, "createdBy", 200),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

export const continuousImprovementConstants = {
  assistantPromptName: ASSISTANT_PROMPT_NAME,
  evaluator: HEURISTIC_EVALUATOR,
  evaluatorVersion: HEURISTIC_EVALUATOR_VERSION,
} as const;
