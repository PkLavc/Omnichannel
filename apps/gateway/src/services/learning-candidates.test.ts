import assert from "node:assert/strict";
import test from "node:test";
import {
  CommercialOutcomeStatus,
  HumanFeedbackVerdict,
  LearningAgentRole,
  LearningCandidateKind,
  LearningCandidateRisk,
  LearningCandidateStatus,
  LearningEvidencePolarity,
  PrismaClient,
} from "@prisma/client";
import {
  LearningCandidateService,
  assessCandidateAggregate,
  deriveCustomerFingerprint,
  deriveLearningAgentRole,
  deriveLearningSignals,
} from "./learning-candidates.js";

function aggregate(overrides: Partial<Parameters<typeof assessCandidateAggregate>[0]["aggregate"]> = {}) {
  return {
    evidenceCount: 12,
    supportingCount: 10,
    contradictingCount: 1,
    distinctConversationCount: 12,
    distinctCustomerCount: 8,
    verifiedOutcomeCount: 8,
    windowStartedAt: new Date("2026-01-01T00:00:00Z"),
    windowEndedAt: new Date("2026-01-31T00:00:00Z"),
    ...overrides,
  };
}

test("extrai somente táticas da taxonomia e nunca copia conversa para a proposta", () => {
  const secretCustomerPhrase = "SEGREDO-CLIENTE-9921";
  const inventedOffer = "Dou 91% de desconto e garantia de 100 anos.";
  const signals = deriveLearningSignals({
    tenantId: "tenant-a",
    conversationId: "conversation-a",
    evaluationId: "evaluation-a",
    evaluationScore: 0.95,
    messages: [
      { role: "user", content: `Meu código é ${secretCustomerPhrase}. Quero comprar.`, createdAt: new Date(1) },
      { role: "assistant", content: "Qual modelo você procura?", createdAt: new Date(2) },
      { role: "assistant", content: inventedOffer, createdAt: new Date(3) },
      { role: "assistant", content: "Posso finalizar o pedido?", createdAt: new Date(4) },
    ],
    state: { contactId: "contact-a" },
    outcome: { status: CommercialOutcomeStatus.WON, confidence: 1, source: "payment" },
    verifiedCommerceLinks: 1,
    feedback: [{ verdict: HumanFeedbackVerdict.POSITIVE, score: 100 }],
    observedAt: new Date("2026-01-10T00:00:00Z"),
  });
  assert.ok(signals.some(signal => signal.key === "behavior.qualify-before-recommendation"));
  assert.ok(signals.every(signal => signal.agentRole === LearningAgentRole.SALES));
  assert.ok(signals.some(signal => signal.key === "behavior.explicit-next-step"));
  const offer = signals.find(signal => signal.kind === LearningCandidateKind.COMMERCIAL_OFFER);
  assert.equal(offer?.risk, LearningCandidateRisk.CRITICAL);
  assert.equal(offer?.requiresGrounding, true);
  assert.equal(offer?.polarity, LearningEvidencePolarity.CONTEXT);
  const serialized = JSON.stringify(signals);
  assert.doesNotMatch(serialized, new RegExp(secretCustomerPhrase, "u"));
  assert.doesNotMatch(serialized, /91%|100 anos/u);
});

test("isola o aprendizado por especialidade interna", () => {
  assert.equal(deriveLearningAgentRole({
    state: { activeAgent: "technical" },
    messages: [{ role: "user", content: "Quero saber o preço do reparo." }],
    outcome: { status: CommercialOutcomeStatus.WON, confidence: 1, source: "erp" },
  }), LearningAgentRole.TECHNICAL);
  assert.equal(deriveLearningAgentRole({
    state: {},
    messages: [{ role: "user", content: "Quero comprar um aparelho novo." }],
    outcome: null,
  }), LearningAgentRole.SALES);
  assert.equal(deriveLearningAgentRole({
    state: {},
    messages: [{ role: "user", content: "Meu pedido não chegou e quero reclamar." }],
    outcome: null,
  }), LearningAgentRole.CUSTOMER_CARE);
});

test("repetição sem clientes diversos e resultados verificados não vira aprendizado", () => {
  const assessed = assessCandidateAggregate({
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    requiresGrounding: false,
    groundingVerified: false,
    aggregate: aggregate({
      evidenceCount: 10_000,
      supportingCount: 10_000,
      contradictingCount: 0,
      distinctConversationCount: 10_000,
      distinctCustomerCount: 1,
      verifiedOutcomeCount: 0,
    }),
  });
  assert.equal(assessed.status, LearningCandidateStatus.GATHERING);
  assert.ok(assessed.confidence < 0.72);
  assert.equal(
    (assessed.evidenceSummary as { confidenceMeaning: string }).confidenceMeaning,
    "observational_hypothesis_not_causation",
  );
});

test("tática só fica pronta com diversidade, suporte, verificação e baixa contradição", () => {
  const ready = assessCandidateAggregate({
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    requiresGrounding: false,
    groundingVerified: false,
    aggregate: aggregate(),
  });
  assert.equal(ready.status, LearningCandidateStatus.READY_FOR_REVIEW);
  assert.ok(ready.confidence >= 0.72);

  const contradicted = assessCandidateAggregate({
    kind: LearningCandidateKind.BEHAVIORAL_TACTIC,
    requiresGrounding: false,
    groundingVerified: false,
    aggregate: aggregate({ supportingCount: 6, contradictingCount: 4 }),
  });
  assert.equal(contradicted.status, LearningCandidateStatus.GATHERING);
});

test("fato ou oferta permanece bloqueado apesar da repetição até receber fonte oficial", () => {
  const repeated = aggregate({
    evidenceCount: 300_000,
    supportingCount: 0,
    contradictingCount: 0,
    distinctConversationCount: 300_000,
    distinctCustomerCount: 50_000,
    verifiedOutcomeCount: 100_000,
  });
  const blocked = assessCandidateAggregate({
    kind: LearningCandidateKind.COMMERCIAL_OFFER,
    requiresGrounding: true,
    groundingVerified: false,
    aggregate: repeated,
  });
  assert.equal(blocked.status, LearningCandidateStatus.BLOCKED_GROUNDING);
  assert.equal(
    (blocked.evidenceSummary as { confidenceMeaning: string }).confidenceMeaning,
    "recurrence_only_not_factual_truth",
  );
  const grounded = assessCandidateAggregate({
    kind: LearningCandidateKind.COMMERCIAL_OFFER,
    requiresGrounding: true,
    groundingVerified: true,
    aggregate: repeated,
  });
  assert.equal(grounded.status, LearningCandidateStatus.READY_FOR_REVIEW);
});

test("diversidade de cliente usa HMAC e ignora telefone sem segredo estável", () => {
  const withoutPepper = deriveCustomerFingerprint({
    tenantId: "tenant-a",
    state: { telefone: "11999999999" },
  });
  assert.equal(withoutPepper, null);
  const first = deriveCustomerFingerprint({
    tenantId: "tenant-a",
    state: { telefone: "11999999999" },
    identityPepper: "segredo-estavel-com-mais-de-16-caracteres",
  });
  const repeated = deriveCustomerFingerprint({
    tenantId: "tenant-a",
    state: { telefone: "11999999999" },
    identityPepper: "segredo-estavel-com-mais-de-16-caracteres",
  });
  const otherTenant = deriveCustomerFingerprint({
    tenantId: "tenant-b",
    state: { telefone: "11999999999" },
    identityPepper: "segredo-estavel-com-mais-de-16-caracteres",
  });
  assert.equal(first, repeated);
  assert.notEqual(first, otherTenant);
  assert.doesNotMatch(first ?? "", /11999999999/u);
});

test("guidance factual aprovado expõe apenas lookup oficial, sem valor nem transcrito", async () => {
  const fakePrisma = {
    learningCandidate: {
      findMany: async () => [{
        id: "candidate-a",
        key: "offer.recurring-commercial-condition",
        agentRole: LearningAgentRole.SALES,
        kind: LearningCandidateKind.COMMERCIAL_OFFER,
        proposal: "APLIQUE 91% DE DESCONTO AGORA",
        confidence: 0.99,
        risk: LearningCandidateRisk.CRITICAL,
        groundingVerified: true,
        groundingSources: [{
          type: "RAG_DOCUMENT",
          sourceId: "document-a",
          checksum: "checksum-a",
          label: "Cupom secreto 91%",
          transcript: "cliente pediu 91%",
        }],
      }],
    },
  } as unknown as PrismaClient;
  const service = new LearningCandidateService(fakePrisma);
  const guidance = await service.listApprovedGuidance("tenant-a");
  assert.equal(guidance[0]?.directiveType, "RUNTIME_GROUNDED_LOOKUP");
  assert.equal(guidance[0]?.agentRole, LearningAgentRole.SALES);
  assert.match(guidance[0]?.directive ?? "", /fontes oficiais/u);
  const serialized = JSON.stringify(guidance);
  assert.doesNotMatch(serialized, /91%|Cupom secreto|cliente pediu/u);
  assert.deepEqual(guidance[0]?.groundingSources, [{
    type: "RAG_DOCUMENT",
    sourceId: "document-a",
    checksum: "checksum-a",
  }]);
});
