import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  AutomaticEvaluationStatus,
  CommercialOutcomeStatus,
  CommerceVerificationStatus,
  HumanFeedbackVerdict,
  LearningAgentRole,
  LearningCandidateKind,
  LearningCandidateRisk,
  LearningCandidateStatus,
  LearningEvidencePolarity,
  LearningReviewDecision,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { ContinuousImprovementError } from "./continuous-improvement.js";

type JsonObject = Record<string, unknown>;

export type LearningMessage = {
  id?: string;
  role: string;
  content: string;
  createdAt?: Date;
};

export type LearningDiscoveryInput = {
  tenantId: string;
  conversationId: string;
  evaluationId: string;
  evaluationScore?: number | null;
  messages: LearningMessage[];
  state?: unknown;
  outcome?: {
    status: CommercialOutcomeStatus;
    confidence: number;
    source: string;
  } | null;
  verifiedCommerceLinks?: number;
  feedback?: {
    verdict: HumanFeedbackVerdict;
    score?: number | null;
  }[];
  observedAt: Date;
  identityPepper?: string;
};

export type LearningCandidateSignal = {
  key: string;
  agentRole: LearningAgentRole;
  kind: LearningCandidateKind;
  title: string;
  proposal: string;
  rationale: string;
  risk: LearningCandidateRisk;
  requiresGrounding: boolean;
  polarity: LearningEvidencePolarity;
  outcomeVerified: boolean;
  conversationId: string;
  evaluationId: string;
  customerFingerprint: string | null;
  observedAt: Date;
  summary: Prisma.InputJsonValue;
};

export type CandidateThresholds = {
  minDistinctConversations: number;
  minDistinctCustomers: number;
  minVerifiedOutcomes: number;
  minSupportingEvidence: number;
  minConfidence: number;
  maxContradictionRate: number;
};

export type CandidateAggregate = {
  evidenceCount: number;
  supportingCount: number;
  contradictingCount: number;
  distinctConversationCount: number;
  distinctCustomerCount: number;
  verifiedOutcomeCount: number;
  windowStartedAt: Date | null;
  windowEndedAt: Date | null;
};

export type GroundingReference = {
  type: "RAG_DOCUMENT" | "BUSINESS_RULE" | "TOOL_CONFIG";
  sourceId: string;
  checksum?: string;
};

type VerifiedGroundingReference = {
  type: GroundingReference["type"];
  sourceId: string;
  checksum: string;
  label: string;
};

export type CandidateReviewInput = {
  tenantId: string;
  candidateIds: string[];
  decision: LearningReviewDecision;
  reviewerId: string;
  note?: string | null;
  batchId?: string;
};

const defaultThresholds: CandidateThresholds = {
  minDistinctConversations: 8,
  minDistinctCustomers: 5,
  minVerifiedOutcomes: 3,
  minSupportingEvidence: 4,
  minConfidence: 0.72,
  maxContradictionRate: 0.25,
};

type CandidateDefinition = Omit<LearningCandidateSignal,
  "polarity" | "outcomeVerified" | "conversationId" | "evaluationId"
  | "customerFingerprint" | "observedAt" | "summary" | "agentRole"> & {
    detect: (messages: LearningMessage[]) => boolean;
  };

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ")
    .trim();
}

function assistantTexts(messages: LearningMessage[]): string[] {
  return messages
    .filter(message => message.role === "assistant")
    .map(message => normalize(message.content))
    .filter(Boolean);
}

function conversationText(messages: LearningMessage[], role: string): string {
  return messages
    .filter(message => message.role === role)
    .map(message => normalize(message.content))
    .join("\n");
}

function hasObjectionHandling(messages: LearningMessage[]): boolean {
  const objection = /\b(caro|preco alto|nao quero|nao posso|duvida|receio|medo|desconto|pensar|concorrente)\b/u;
  const acknowledgement = /\b(entendo|compreendo|faz sentido|posso explicar|vamos comparar|alternativa|opcao)\b/u;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "user" || !objection.test(normalize(message.content))) continue;
    const nextAssistant = messages.slice(index + 1).find(candidate => candidate.role === "assistant");
    if (nextAssistant && acknowledgement.test(normalize(nextAssistant.content))) return true;
  }
  return false;
}

const definitions: CandidateDefinition[] = [
  {
    key: "behavior.qualify-before-recommendation",
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    title: "Qualificar antes de recomendar",
    proposal: "Fazer uma pergunta curta de qualificação antes de recomendar uma solução.",
    rationale: "A hipótese mede condução comercial; ela não autoriza afirmar preço, estoque, prazo ou política.",
    risk: LearningCandidateRisk.LOW,
    requiresGrounding: false,
    detect: messages => assistantTexts(messages).some(text => (
      text.includes("?")
      && /\b(precisa|procura|busca|prefere|modelo|uso|orcamento|problema|prioridade|objetivo)\b/u.test(text)
    )),
  },
  {
    key: "behavior.explicit-next-step",
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    title: "Propor um próximo passo claro",
    proposal: "Encerrar a etapa com um próximo passo claro e verificável, sem pressionar o cliente.",
    rationale: "A ação proposta precisa continuar sujeita às Tools, regras e permissões disponíveis.",
    risk: LearningCandidateRisk.LOW,
    requiresGrounding: false,
    detect: messages => assistantTexts(messages).some(text => (
      /\b(posso|podemos|vamos|confirma|agendar|reservar|finalizar|quer que eu|prefere que eu|enviar o link)\b/u.test(text)
    )),
  },
  {
    key: "behavior.acknowledge-objection",
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    title: "Acolher a objeção antes de responder",
    proposal: "Reconhecer a objeção, esclarecer a necessidade e apresentar somente alternativas suportadas por fontes oficiais.",
    rationale: "A recorrência de uma objeção não prova que uma resposta ou condição comercial esteja correta.",
    risk: LearningCandidateRisk.MEDIUM,
    requiresGrounding: false,
    detect: hasObjectionHandling,
  },
  {
    key: "behavior.concise-actionable-turns",
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    title: "Responder de forma curta e acionável",
    proposal: "Priorizar a informação ou ação principal e dividir explicações longas em etapas.",
    rationale: "A hipótese considera o formato da resposta, nunca copia o conteúdo da conversa.",
    risk: LearningCandidateRisk.LOW,
    requiresGrounding: false,
    detect: messages => {
      const responses = messages.filter(message => message.role === "assistant" && message.content.trim());
      if (responses.length < 2) return false;
      const average = responses.reduce((sum, message) => sum + message.content.trim().length, 0)
        / responses.length;
      return average >= 40 && average <= 700 && responses.every(message => message.content.length <= 1_400);
    },
  },
  {
    key: "fact.recurring-business-claim",
    kind: LearningCandidateKind.BUSINESS_FACT,
    title: "Alegação comercial recorrente exige fonte oficial",
    proposal: "Consultar RAG, regra de negócio ou Tool autorizada antes de responder sobre estoque, garantia, prazo ou política.",
    rationale: "Falhas e repetições nas conversas são apenas alertas; fatos nunca são aprendidos do texto gerado.",
    risk: LearningCandidateRisk.HIGH,
    requiresGrounding: true,
    detect: messages => /\b(estoque|disponivel|garantia|prazo|entrega|troca|devolucao|politica)\b/u
      .test(conversationText(messages, "assistant")),
  },
  {
    key: "offer.recurring-commercial-condition",
    kind: LearningCandidateKind.COMMERCIAL_OFFER,
    title: "Oferta ou condição recorrente exige validação",
    proposal: "Obter preço, desconto, parcelamento, cupom e frete em fonte oficial no momento da resposta.",
    rationale: "Uma venda bem-sucedida não transforma uma condição mencionada pela IA em uma oferta válida.",
    risk: LearningCandidateRisk.CRITICAL,
    requiresGrounding: true,
    detect: messages => /(?:\br\$\s*\d|\bdesconto\b|\bcupom\b|\bpromocao\b|\bparcel(?:a|amento|amos)|\bfrete gratis\b)/u
      .test(conversationText(messages, "assistant")),
  },
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(clamp01(value) * 10_000) / 10_000;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/**
 * Keeps learned behavior scoped to the same internal specialty that produced
 * the evidence. Explicit runtime state wins; historical archives fall back to
 * a conservative intent classification and verified sales outcomes.
 */
export function deriveLearningAgentRole(input: Pick<LearningDiscoveryInput, "messages" | "state" | "outcome">) {
  const state = asObject(input.state);
  const explicit = typeof state.activeAgent === "string" ? normalize(state.activeAgent) : "";
  if (explicit === "sales") return LearningAgentRole.SALES;
  if (explicit === "customer_care") return LearningAgentRole.CUSTOMER_CARE;
  if (explicit === "technical") return LearningAgentRole.TECHNICAL;
  if (explicit === "intake") return LearningAgentRole.INTAKE;

  const sector = typeof state.sector === "string" ? normalize(state.sector) : "";
  if (sector === "commercial") return LearningAgentRole.SALES;
  if (sector === "postsale" || sector === "post_sale") return LearningAgentRole.CUSTOMER_CARE;
  if (sector === "support") return LearningAgentRole.TECHNICAL;

  // Infer the customer's requested specialty, not terms the human/AI happened
  // to mention in its answer (for example an invented warranty in a sales turn).
  const text = normalize(input.messages
    .filter(message => message.role === "user")
    .map(message => message.content)
    .join("\n")
    .slice(-30_000));
  if (/\b(sac|reclamacao|procon|ouvidoria|troca|devolucao|reembolso|meu pedido|nao chegou|cobranca|estorno|pos-venda)\b/u.test(text)) {
    return LearningAgentRole.CUSTOMER_CARE;
  }
  if (/\b(defeito|erro|falha|quebrado|quebrada|nao liga|travando|superaquece|bateria|tela|reparo|assistencia tecnica|diagnostico|consertar)\b/u.test(text)) {
    return LearningAgentRole.TECHNICAL;
  }
  if (/\b(comprar|compra|orcamento|preco|valor|produto|modelo|estoque|desconto|promocao|parcelamento)\b/u.test(text)
    || input.outcome?.status === CommercialOutcomeStatus.WON) {
    return LearningAgentRole.SALES;
  }
  return LearningAgentRole.INTAKE;
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

function requiredText(value: string, field: string, max = 500): string {
  const normalized = value.trim();
  if (!normalized) throw new ContinuousImprovementError("invalid_input", `${field} is required`);
  if (normalized.length > max) {
    throw new ContinuousImprovementError("invalid_input", `${field} exceeds ${max} characters`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new ContinuousImprovementError("invalid_input", `text exceeds ${max} characters`);
  }
  return normalized || null;
}

function firstNestedValue(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 50)) {
      const found = firstNestedValue(child, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (keys.has(normalize(key)) && (typeof child === "string" || typeof child === "number")) {
      const text = String(child).trim();
      if (text) return text;
    }
  }
  for (const child of Object.values(value as JsonObject).slice(0, 50)) {
    const found = firstNestedValue(child, keys);
    if (found) return found;
  }
  return null;
}

/**
 * Produces a tenant-scoped, non-reversible identity used only for diversity.
 * Phone/e-mail are ignored when no stable secret pepper is configured.
 */
export function deriveCustomerFingerprint(input: {
  tenantId: string;
  state: unknown;
  identityPepper?: string;
}): string | null {
  const opaqueId = firstNestedValue(input.state, new Set([
    "contactid",
    "customerid",
    "clientid",
    "chatwootcontactid",
    "senderid",
  ]));
  const pepper = input.identityPepper?.trim();
  const pii = pepper && pepper.length >= 16
    ? firstNestedValue(input.state, new Set(["email", "telefone", "phone", "phonenumber"]))
    : null;
  const source = opaqueId ? `opaque:${opaqueId}` : pii ? `pii:${normalize(pii)}` : null;
  if (!source) return null;
  const key = pepper && pepper.length >= 16 ? pepper : `tenant:${input.tenantId}`;
  return createHmac("sha256", key)
    .update(`${input.tenantId}\u0000${source}`, "utf8")
    .digest("hex");
}

function evidencePolarity(input: LearningDiscoveryInput): {
  polarity: LearningEvidencePolarity;
  outcomeVerified: boolean;
} {
  const confidence = input.outcome?.confidence ?? 0;
  const wonVerified = input.outcome?.status === CommercialOutcomeStatus.WON
    && confidence >= 0.8
    && (input.verifiedCommerceLinks ?? 0) > 0;
  const lostVerified = input.outcome?.status === CommercialOutcomeStatus.LOST
    && confidence >= 0.8
    && !/^automatic/u.test(normalize(input.outcome.source));
  const feedback = input.feedback ?? [];
  const positive = feedback.some(item => item.verdict === HumanFeedbackVerdict.POSITIVE
    || (typeof item.score === "number" && item.score >= 50));
  const negative = feedback.some(item => item.verdict === HumanFeedbackVerdict.NEGATIVE
    || (typeof item.score === "number" && item.score <= -50));
  if ((wonVerified || positive) && !(lostVerified || negative)) {
    return { polarity: LearningEvidencePolarity.SUPPORTS, outcomeVerified: wonVerified };
  }
  if ((lostVerified || negative) && !(wonVerified || positive)) {
    return { polarity: LearningEvidencePolarity.CONTRADICTS, outcomeVerified: lostVerified };
  }
  return {
    polarity: LearningEvidencePolarity.CONTEXT,
    outcomeVerified: wonVerified || lostVerified,
  };
}

/**
 * Deterministic extraction intentionally maps transcripts to a small taxonomy.
 * It never copies a customer phrase or model response into a candidate proposal.
 */
export function deriveLearningSignals(input: LearningDiscoveryInput): LearningCandidateSignal[] {
  const messages = [...input.messages]
    .filter(message => message.content.trim())
    .sort((left, right) => (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0));
  const assistantCount = messages.filter(message => message.role === "assistant").length;
  if (!assistantCount) return [];
  const evidence = evidencePolarity(input);
  const agentRole = deriveLearningAgentRole(input);
  const customerFingerprint = deriveCustomerFingerprint({
    tenantId: input.tenantId,
    state: input.state,
    identityPepper: input.identityPepper,
  });
  return definitions
    .filter(definition => definition.detect(messages))
    .map(definition => ({
      key: definition.key,
      agentRole,
      kind: definition.kind,
      title: definition.title,
      proposal: definition.proposal,
      rationale: definition.rationale,
      risk: definition.risk,
      requiresGrounding: definition.requiresGrounding,
      polarity: definition.requiresGrounding ? LearningEvidencePolarity.CONTEXT : evidence.polarity,
      outcomeVerified: evidence.outcomeVerified,
      conversationId: input.conversationId,
      evaluationId: input.evaluationId,
      customerFingerprint,
      observedAt: input.observedAt,
      summary: {
        taxonomyKey: definition.key,
        agentRole,
        messageCount: messages.length,
        assistantMessageCount: assistantCount,
        evaluationScore: typeof input.evaluationScore === "number"
          ? rounded(input.evaluationScore)
          : null,
        outcome: input.outcome ? {
          status: input.outcome.status,
          confidence: rounded(input.outcome.confidence),
          source: input.outcome.source.slice(0, 160),
        } : null,
        verifiedCommerceLinks: input.verifiedCommerceLinks ?? 0,
        feedbackVerdicts: (input.feedback ?? []).map(item => item.verdict),
        containsTranscript: false,
      } as Prisma.InputJsonValue,
    }));
}

export function assessCandidateAggregate(input: {
  kind: LearningCandidateKind;
  requiresGrounding: boolean;
  groundingVerified: boolean;
  aggregate: CandidateAggregate;
  thresholds?: Partial<CandidateThresholds>;
}): {
  confidence: number;
  status: LearningCandidateStatus;
  evidenceSummary: Prisma.InputJsonValue;
} {
  const thresholds = { ...defaultThresholds, ...input.thresholds };
  const aggregate = input.aggregate;
  const diverseConversations = aggregate.distinctConversationCount >= thresholds.minDistinctConversations;
  const diverseCustomers = aggregate.distinctCustomerCount >= thresholds.minDistinctCustomers;
  const diversity = Math.min(1, aggregate.distinctConversationCount / thresholds.minDistinctConversations)
    * Math.min(1, aggregate.distinctCustomerCount / thresholds.minDistinctCustomers);
  const classified = aggregate.supportingCount + aggregate.contradictingCount;
  const contradictionRate = classified
    ? aggregate.contradictingCount / classified
    : 0;
  const recurrence = Math.min(1, aggregate.evidenceCount / thresholds.minDistinctConversations);

  let confidence: number;
  let status: LearningCandidateStatus;
  if (input.requiresGrounding) {
    // Confidence means recurrence of the topic, never truth of the claim.
    confidence = rounded(recurrence * (0.4 + 0.6 * diversity));
    status = input.groundingVerified && diverseConversations && diverseCustomers
      ? LearningCandidateStatus.READY_FOR_REVIEW
      : LearningCandidateStatus.BLOCKED_GROUNDING;
  } else {
    const supportRate = (aggregate.supportingCount + 1) / (classified + 2);
    const verification = Math.min(1, aggregate.verifiedOutcomeCount / thresholds.minVerifiedOutcomes);
    confidence = rounded(supportRate * (0.4 + 0.6 * diversity) * (0.45 + 0.55 * verification));
    const ready = diverseConversations
      && diverseCustomers
      && aggregate.supportingCount >= thresholds.minSupportingEvidence
      && aggregate.verifiedOutcomeCount >= thresholds.minVerifiedOutcomes
      && contradictionRate <= thresholds.maxContradictionRate
      && confidence >= thresholds.minConfidence;
    status = ready ? LearningCandidateStatus.READY_FOR_REVIEW : LearningCandidateStatus.GATHERING;
  }

  return {
    confidence,
    status,
    evidenceSummary: {
      confidenceMeaning: input.requiresGrounding
        ? "recurrence_only_not_factual_truth"
        : "observational_hypothesis_not_causation",
      evidenceCount: aggregate.evidenceCount,
      supportingCount: aggregate.supportingCount,
      contradictingCount: aggregate.contradictingCount,
      contradictionRate: rounded(contradictionRate),
      distinctConversationCount: aggregate.distinctConversationCount,
      distinctCustomerCount: aggregate.distinctCustomerCount,
      verifiedOutcomeCount: aggregate.verifiedOutcomeCount,
      thresholds,
      factualClaimsMustUseRuntimeGrounding: input.kind !== LearningCandidateKind.BEHAVIORAL_TACTIC,
    } as Prisma.InputJsonValue,
  };
}

type AggregateRow = {
  evidenceCount: string;
  supportingCount: string;
  contradictingCount: string;
  distinctConversationCount: string;
  distinctCustomerCount: string;
  verifiedOutcomeCount: string;
  windowStartedAt: Date | null;
  windowEndedAt: Date | null;
};

function preservedStatus(
  current: LearningCandidateStatus,
  assessed: LearningCandidateStatus,
): LearningCandidateStatus {
  return current === LearningCandidateStatus.APPROVED
    || current === LearningCandidateStatus.REJECTED
    || current === LearningCandidateStatus.ARCHIVED
    ? current
    : assessed;
}

export class LearningCandidateService {
  private readonly identityPepper?: string;

  constructor(
    private readonly prisma: PrismaClient,
    options: { identityPepper?: string } = {},
  ) {
    const configured = options.identityPepper
      ?? process.env.LEARNING_IDENTITY_PEPPER
      ?? process.env.ENCRYPTION_KEY;
    this.identityPepper = configured && configured.trim().length >= 16
      ? configured.trim()
      : undefined;
  }

  private async aggregateEvidence(tenantId: string, candidateId: string): Promise<CandidateAggregate> {
    const rows = await this.prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::text AS "evidenceCount",
        COUNT(*) FILTER (WHERE "polarity" = 'SUPPORTS')::text AS "supportingCount",
        COUNT(*) FILTER (WHERE "polarity" = 'CONTRADICTS')::text AS "contradictingCount",
        COUNT(DISTINCT "conversationId")::text AS "distinctConversationCount",
        COUNT(DISTINCT "customerFingerprint")::text AS "distinctCustomerCount",
        COUNT(*) FILTER (WHERE "outcomeVerified" = true)::text AS "verifiedOutcomeCount",
        MIN("observedAt") AS "windowStartedAt",
        MAX("observedAt") AS "windowEndedAt"
      FROM "LearningCandidateEvidence"
      WHERE "tenantId" = ${tenantId} AND "candidateId" = ${candidateId}
    `);
    const row = rows[0];
    return {
      evidenceCount: Number(row?.evidenceCount ?? 0),
      supportingCount: Number(row?.supportingCount ?? 0),
      contradictingCount: Number(row?.contradictingCount ?? 0),
      distinctConversationCount: Number(row?.distinctConversationCount ?? 0),
      distinctCustomerCount: Number(row?.distinctCustomerCount ?? 0),
      verifiedOutcomeCount: Number(row?.verifiedOutcomeCount ?? 0),
      windowStartedAt: row?.windowStartedAt ?? null,
      windowEndedAt: row?.windowEndedAt ?? null,
    };
  }

  async discoverFromEvaluations(input: {
    tenantId: string;
    cursor?: string;
    limit?: number;
    since?: Date;
    until?: Date;
    evaluator?: string;
    evaluatorVersion?: string;
    maxCandidates?: number;
    thresholds?: Partial<CandidateThresholds>;
  }) {
    const limit = Math.max(1, Math.min(2_000, input.limit ?? 500));
    // Four customer-facing specialties x six fixed taxonomy cards. The cap
    // remains small and bounded, but it must not starve a less common role.
    const maxCandidates = Math.max(1, Math.min(40, input.maxCandidates ?? 32));
    const evaluations = await this.prisma.automaticEvaluation.findMany({
      where: {
        tenantId: input.tenantId,
        status: AutomaticEvaluationStatus.COMPLETED,
        ...(input.evaluator ? { evaluator: input.evaluator } : {}),
        ...(input.evaluatorVersion ? { evaluatorVersion: input.evaluatorVersion } : {}),
        ...(input.since || input.until ? {
          createdAt: {
            ...(input.since ? { gte: input.since } : {}),
            ...(input.until ? { lte: input.until } : {}),
          },
        } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: {
        conversation: {
          select: {
            id: true,
            state: true,
            messages: {
              orderBy: { createdAt: "desc" },
              take: 80,
              select: { id: true, role: true, content: true, createdAt: true },
            },
            commercialOutcomes: {
              orderBy: { revision: "desc" },
              take: 1,
              select: { status: true, confidence: true, source: true },
            },
            commerceLinks: {
              where: { verificationStatus: CommerceVerificationStatus.VERIFIED },
              select: { status: true },
            },
            humanFeedback: {
              orderBy: { createdAt: "desc" },
              take: 20,
              select: { verdict: true, score: true },
            },
          },
        },
      },
    });

    const byConversation = new Map<string, typeof evaluations[number]>();
    for (const evaluation of evaluations) byConversation.set(evaluation.conversationId, evaluation);
    const signals = [...byConversation.values()].flatMap(evaluation => {
      const outcome = evaluation.conversation.commercialOutcomes[0];
      const successfulVerifiedLinks = evaluation.conversation.commerceLinks.filter(link => (
        ["approved", "captured", "complete", "completed", "delivered", "fulfilled", "paid", "succeeded", "success", "won"]
          .includes(normalize(link.status))
      )).length;
      return deriveLearningSignals({
        tenantId: input.tenantId,
        conversationId: evaluation.conversationId,
        evaluationId: evaluation.id,
        evaluationScore: evaluation.overallScore === null ? null : Number(evaluation.overallScore),
        messages: evaluation.conversation.messages,
        state: evaluation.conversation.state,
        outcome: outcome ? {
          status: outcome.status,
          confidence: Number(outcome.confidence),
          source: outcome.source,
        } : null,
        verifiedCommerceLinks: successfulVerifiedLinks,
        feedback: evaluation.conversation.humanFeedback,
        observedAt: evaluation.completedAt ?? evaluation.createdAt,
        identityPepper: this.identityPepper,
      });
    });

    const grouped = new Map<string, LearningCandidateSignal[]>();
    for (const signal of signals) {
      const fingerprint = sha256(`${signal.agentRole}:${signal.kind}:${signal.key}`);
      const group = grouped.get(fingerprint) ?? [];
      group.push(signal);
      grouped.set(fingerprint, group);
    }
    const selected = [...grouped.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .slice(0, maxCandidates);

    const updatedCandidates = [];
    for (const [fingerprint, group] of selected) {
      const sample = group[0]!;
      const candidate = await this.prisma.learningCandidate.upsert({
        where: { tenantId_fingerprint: { tenantId: input.tenantId, fingerprint } },
        create: {
          tenantId: input.tenantId,
          fingerprint,
          key: sample.key,
          agentRole: sample.agentRole,
          kind: sample.kind,
          title: sample.title,
          proposal: sample.proposal,
          rationale: sample.rationale,
          risk: sample.risk,
          requiresGrounding: sample.requiresGrounding,
        },
        update: {
          title: sample.title,
          agentRole: sample.agentRole,
          proposal: sample.proposal,
          rationale: sample.rationale,
          risk: sample.risk,
          requiresGrounding: sample.requiresGrounding,
        },
      });
      for (let offset = 0; offset < group.length; offset += 50) {
        const chunk = group.slice(offset, offset + 50);
        await this.prisma.$transaction(chunk.map(signal => {
          const evidenceFingerprint = sha256(`${fingerprint}:${signal.conversationId}`);
          return this.prisma.learningCandidateEvidence.upsert({
            where: {
              candidateId_fingerprint: {
                candidateId: candidate.id,
                fingerprint: evidenceFingerprint,
              },
            },
            create: {
              tenantId: input.tenantId,
              candidateId: candidate.id,
              conversationId: signal.conversationId,
              automaticEvaluationId: signal.evaluationId,
              customerFingerprint: signal.customerFingerprint,
              polarity: signal.polarity,
              sourceType: "AUTOMATIC_EVALUATION",
              sourceId: signal.evaluationId,
              outcomeVerified: signal.outcomeVerified,
              summary: signal.summary,
              fingerprint: evidenceFingerprint,
              observedAt: signal.observedAt,
            },
            update: {
              automaticEvaluationId: signal.evaluationId,
              customerFingerprint: signal.customerFingerprint,
              polarity: signal.polarity,
              sourceId: signal.evaluationId,
              outcomeVerified: signal.outcomeVerified,
              summary: signal.summary,
              observedAt: signal.observedAt,
            },
          });
        }));
      }
      const aggregate = await this.aggregateEvidence(input.tenantId, candidate.id);
      const assessment = assessCandidateAggregate({
        kind: candidate.kind,
        requiresGrounding: candidate.requiresGrounding,
        groundingVerified: candidate.groundingVerified,
        aggregate,
        thresholds: input.thresholds,
      });
      updatedCandidates.push(await this.prisma.learningCandidate.update({
        where: { id: candidate.id },
        data: {
          confidence: assessment.confidence,
          status: preservedStatus(candidate.status, assessment.status),
          evidenceCount: aggregate.evidenceCount,
          supportingCount: aggregate.supportingCount,
          contradictingCount: aggregate.contradictingCount,
          distinctConversationCount: aggregate.distinctConversationCount,
          distinctCustomerCount: aggregate.distinctCustomerCount,
          verifiedOutcomeCount: aggregate.verifiedOutcomeCount,
          evidenceSummary: assessment.evidenceSummary,
          windowStartedAt: aggregate.windowStartedAt,
          windowEndedAt: aggregate.windowEndedAt,
        },
      }));
    }

    return {
      scannedEvaluations: evaluations.length,
      distinctConversations: byConversation.size,
      derivedSignals: signals.length,
      updatedCandidates,
      nextCursor: evaluations.length === limit ? evaluations.at(-1)?.id ?? null : null,
      hasMore: evaluations.length === limit,
    };
  }

  async listReviewQueue(input: {
    tenantId: string;
    includeBlocked?: boolean;
    limit?: number;
  }) {
    return this.prisma.learningCandidate.findMany({
      where: {
        tenantId: input.tenantId,
        status: {
          in: input.includeBlocked === false
            ? [LearningCandidateStatus.READY_FOR_REVIEW]
            : [LearningCandidateStatus.READY_FOR_REVIEW, LearningCandidateStatus.BLOCKED_GROUNDING],
        },
      },
      orderBy: [{ risk: "desc" }, { confidence: "desc" }, { updatedAt: "desc" }],
      take: Math.max(1, Math.min(100, input.limit ?? 25)),
      include: {
        evidence: {
          orderBy: { observedAt: "desc" },
          take: 5,
          select: {
            id: true,
            polarity: true,
            sourceType: true,
            outcomeVerified: true,
            summary: true,
            observedAt: true,
          },
        },
      },
    });
  }

  private async verifyGroundingReference(
    tenantId: string,
    reference: GroundingReference,
  ): Promise<VerifiedGroundingReference> {
    const sourceId = requiredText(reference.sourceId, "sourceId", 500);
    if (reference.type === "RAG_DOCUMENT") {
      const document = await this.prisma.knowledgeDocument.findFirst({
        where: { tenantId, id: sourceId },
        select: { id: true, title: true, checksum: true },
      });
      if (!document || (reference.checksum && reference.checksum !== document.checksum)) {
        throw new ContinuousImprovementError("grounding_source_not_found", "RAG document is absent, changed, or belongs to another tenant");
      }
      return { type: reference.type, sourceId: document.id, checksum: document.checksum, label: document.title };
    }
    if (reference.type === "BUSINESS_RULE") {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const settings = asObject(tenant?.settings);
      const rules = settings.businessRulesDocument;
      const checksum = rules === undefined || rules === null ? null : sha256(stableJson(rules));
      if (!tenant || settings.businessRulesEnabled !== true || !checksum
        || sourceId !== "tenant-business-rules"
        || (reference.checksum && reference.checksum !== checksum)) {
        throw new ContinuousImprovementError("grounding_source_not_found", "enabled tenant business rules were not found or changed");
      }
      return { type: reference.type, sourceId, checksum, label: "Regras de negócio do tenant" };
    }
    const tool = await this.prisma.toolConfig.findFirst({
      where: {
        tenantId,
        enabled: true,
        OR: [{ id: sourceId }, { name: sourceId }],
      },
      select: { id: true, name: true, updatedAt: true },
    });
    if (!tool) {
      throw new ContinuousImprovementError("grounding_source_not_found", "enabled Tool config was not found or belongs to another tenant");
    }
    const checksum = sha256(`${tool.id}:${tool.name}:${tool.updatedAt.toISOString()}`);
    if (reference.checksum && reference.checksum !== checksum) {
      throw new ContinuousImprovementError("grounding_source_changed", "Tool config changed after the grounding reference was selected");
    }
    return { type: reference.type, sourceId: tool.id, checksum, label: tool.name };
  }

  async groundCandidate(input: {
    tenantId: string;
    candidateId: string;
    references: GroundingReference[];
    verifiedBy: string;
    note?: string | null;
    thresholds?: Partial<CandidateThresholds>;
  }) {
    if (!input.references.length || input.references.length > 20) {
      throw new ContinuousImprovementError("invalid_grounding", "one to twenty grounding references are required");
    }
    const candidate = await this.prisma.learningCandidate.findFirst({
      where: { id: input.candidateId, tenantId: input.tenantId },
    });
    if (!candidate) throw new ContinuousImprovementError("candidate_not_found", "candidate does not belong to tenant");
    if (!candidate.requiresGrounding || candidate.kind === LearningCandidateKind.BEHAVIORAL_TACTIC) {
      throw new ContinuousImprovementError("grounding_not_required", "behavioral tactics do not accept factual grounding");
    }
    const references: VerifiedGroundingReference[] = [];
    for (const reference of input.references) {
      references.push(await this.verifyGroundingReference(input.tenantId, reference));
    }
    const aggregate: CandidateAggregate = {
      evidenceCount: candidate.evidenceCount,
      supportingCount: candidate.supportingCount,
      contradictingCount: candidate.contradictingCount,
      distinctConversationCount: candidate.distinctConversationCount,
      distinctCustomerCount: candidate.distinctCustomerCount,
      verifiedOutcomeCount: candidate.verifiedOutcomeCount,
      windowStartedAt: candidate.windowStartedAt,
      windowEndedAt: candidate.windowEndedAt,
    };
    const assessment = assessCandidateAggregate({
      kind: candidate.kind,
      requiresGrounding: true,
      groundingVerified: true,
      aggregate,
      thresholds: input.thresholds,
    });
    const reviewer = requiredText(input.verifiedBy, "verifiedBy", 200);
    return this.prisma.$transaction(async transaction => {
      const updated = await transaction.learningCandidate.update({
        where: { id: candidate.id },
        data: {
          groundingVerified: true,
          groundingSources: references as Prisma.InputJsonValue,
          status: preservedStatus(candidate.status, assessment.status),
          confidence: assessment.confidence,
          evidenceSummary: assessment.evidenceSummary,
        },
      });
      await transaction.learningCandidateReview.create({
        data: {
          tenantId: input.tenantId,
          candidateId: candidate.id,
          decision: LearningReviewDecision.REOPEN,
          reviewerId: reviewer,
          note: optionalText(input.note, 5_000) ?? "Fontes oficiais vinculadas e verificadas.",
          snapshot: {
            action: "GROUNDING_VERIFIED",
            references,
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  async reviewCandidates(input: CandidateReviewInput) {
    const candidateIds = [...new Set(input.candidateIds.map(id => id.trim()).filter(Boolean))];
    if (!candidateIds.length || candidateIds.length > 100) {
      throw new ContinuousImprovementError("invalid_candidate_batch", "one to one hundred candidate ids are required");
    }
    const reviewerId = requiredText(input.reviewerId, "reviewerId", 200);
    const note = optionalText(input.note, 5_000);
    const candidates = await this.prisma.learningCandidate.findMany({
      where: { tenantId: input.tenantId, id: { in: candidateIds } },
    });
    if (candidates.length !== candidateIds.length) {
      throw new ContinuousImprovementError("candidate_not_found", "one or more candidates do not belong to tenant");
    }
    if (input.decision === LearningReviewDecision.APPROVE) {
      const invalid = candidates.find(candidate => (
        candidate.status !== LearningCandidateStatus.READY_FOR_REVIEW
        || (candidate.requiresGrounding && !candidate.groundingVerified)
      ));
      if (invalid) {
        throw new ContinuousImprovementError(
          "candidate_not_approvable",
          "only ready candidates with required grounding can be approved",
        );
      }
    }
    const batchId = input.batchId?.trim() || randomUUID();
    return this.prisma.$transaction(async transaction => {
      const results = [];
      for (const candidate of candidates) {
        let status: LearningCandidateStatus;
        if (input.decision === LearningReviewDecision.APPROVE) status = LearningCandidateStatus.APPROVED;
        else if (input.decision === LearningReviewDecision.REJECT) status = LearningCandidateStatus.REJECTED;
        else {
          const assessment = assessCandidateAggregate({
            kind: candidate.kind,
            requiresGrounding: candidate.requiresGrounding,
            groundingVerified: candidate.groundingVerified,
            aggregate: {
              evidenceCount: candidate.evidenceCount,
              supportingCount: candidate.supportingCount,
              contradictingCount: candidate.contradictingCount,
              distinctConversationCount: candidate.distinctConversationCount,
              distinctCustomerCount: candidate.distinctCustomerCount,
              verifiedOutcomeCount: candidate.verifiedOutcomeCount,
              windowStartedAt: candidate.windowStartedAt,
              windowEndedAt: candidate.windowEndedAt,
            },
          });
          status = assessment.status;
        }
        const updated = await transaction.learningCandidate.update({
          where: { id: candidate.id },
          data: {
            status,
            approvedBy: input.decision === LearningReviewDecision.APPROVE ? reviewerId : null,
            approvedAt: input.decision === LearningReviewDecision.APPROVE ? new Date() : null,
            rejectedBy: input.decision === LearningReviewDecision.REJECT ? reviewerId : null,
            rejectedAt: input.decision === LearningReviewDecision.REJECT ? new Date() : null,
            rejectionReason: input.decision === LearningReviewDecision.REJECT
              ? note ?? "Rejeitado em revisão humana."
              : null,
          },
        });
        await transaction.learningCandidateReview.create({
          data: {
            tenantId: input.tenantId,
            candidateId: candidate.id,
            decision: input.decision,
            reviewerId,
            note,
            batchId,
            snapshot: {
              previousStatus: candidate.status,
              confidence: Number(candidate.confidence),
              evidenceCount: candidate.evidenceCount,
              distinctConversationCount: candidate.distinctConversationCount,
              distinctCustomerCount: candidate.distinctCustomerCount,
              verifiedOutcomeCount: candidate.verifiedOutcomeCount,
              groundingVerified: candidate.groundingVerified,
            } as Prisma.InputJsonValue,
          },
        });
        results.push(updated);
      }
      return { batchId, candidates: results };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Runtime consumers receive only reviewed directives. Factual values are not
   * returned: callers must resolve the attached source again at response time.
   */
  async listApprovedGuidance(tenantId: string, agentRole?: LearningAgentRole) {
    const candidates = await this.prisma.learningCandidate.findMany({
      where: {
        tenantId,
        status: LearningCandidateStatus.APPROVED,
        ...(agentRole ? { agentRole } : {}),
      },
      orderBy: [{ kind: "asc" }, { confidence: "desc" }],
      select: {
        id: true,
        key: true,
        agentRole: true,
        kind: true,
        proposal: true,
        confidence: true,
        risk: true,
        groundingVerified: true,
        groundingSources: true,
      },
    });
    return candidates.map(candidate => {
      const behavioral = candidate.kind === LearningCandidateKind.BEHAVIORAL_TACTIC;
      const safeSources = Array.isArray(candidate.groundingSources)
        ? candidate.groundingSources.flatMap(value => {
          const source = asObject(value);
          const type = typeof source.type === "string" ? source.type : "";
          const sourceId = typeof source.sourceId === "string" ? source.sourceId : "";
          const checksum = typeof source.checksum === "string" ? source.checksum : "";
          return ["RAG_DOCUMENT", "BUSINESS_RULE", "TOOL_CONFIG"].includes(type)
            && sourceId && checksum
            ? [{ type, sourceId, checksum }]
            : [];
        })
        : [];
      return {
        id: candidate.id,
        key: candidate.key,
        agentRole: candidate.agentRole,
        kind: candidate.kind,
        confidence: Number(candidate.confidence),
        risk: candidate.risk,
        directiveType: behavioral ? "BEHAVIOR" : "RUNTIME_GROUNDED_LOOKUP",
        directive: behavioral
          ? candidate.proposal
          : "Consultar exclusivamente as fontes oficiais vinculadas no momento da resposta; nunca reutilizar valores ou condições extraídos de conversas.",
        proposal: behavioral
          ? candidate.proposal
          : "Consultar exclusivamente as fontes oficiais vinculadas no momento da resposta; nunca reutilizar valores ou condições extraídos de conversas.",
        groundingVerified: behavioral ? false : candidate.groundingVerified,
        groundingSources: behavioral ? [] : safeSources,
      };
    });
  }
}

export const learningCandidateConstants = {
  thresholds: defaultThresholds,
  taxonomyKeys: definitions.map(definition => definition.key),
} as const;
