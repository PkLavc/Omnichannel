import assert from "node:assert/strict";
import test from "node:test";
import {
  CommercialOutcomeStatus,
  CommerceLinkKind,
  CommerceVerificationStatus,
  HumanFeedbackVerdict,
  PrismaClient,
} from "@prisma/client";
import {
  ContinuousImprovementError,
  ContinuousImprovementService,
  deterministicCanaryBucket,
  evaluateConversationHeuristically,
  parseAssistantPromptBundle,
  redactDatasetText,
  serializeAssistantPromptBundle,
} from "./continuous-improvement.js";

const bundle = {
  system: "Responda com precisão.",
  commercial: "Conduza para um próximo passo.",
  support: "Colete dados técnicos.",
  postSale: "Confirme pedido e garantia.",
};

test("valida e serializa o bundle de prompts sem perder campos", () => {
  const serialized = serializeAssistantPromptBundle(bundle);
  assert.deepEqual(parseAssistantPromptBundle(serialized), bundle);
  assert.throws(
    () => parseAssistantPromptBundle('{"system":"ok"}'),
    (error: unknown) => error instanceof ContinuousImprovementError
      && error.code === "invalid_prompt_bundle",
  );
});

test("seleção de canário é determinística e fica entre zero e 99", () => {
  const first = deterministicCanaryBucket("tenant-a", "prompt-a", "conversation-42");
  const second = deterministicCanaryBucket("tenant-a", "prompt-a", "conversation-42");
  assert.equal(first, second);
  assert.ok(first >= 0 && first <= 99);
  assert.notEqual(
    deterministicCanaryBucket("tenant-a", "prompt-a", "conversation-43"),
    deterministicCanaryBucket("tenant-a", "prompt-a", "conversation-44"),
  );
});

test("anonimiza dados pessoais em todos os formatos suportados pelo dataset", () => {
  const redacted = redactDatasetText(
    "Email ana@example.com, telefone +55 (11) 99876-5432, "
    + "CPF 123.456.789-00, CNPJ 12.345.678/0001-90 e cartão 4111 1111 1111 1111.",
  );
  assert.equal(
    redacted,
    "Email <EMAIL>, telefone <PHONE>, CPF <CPF>, CNPJ <CNPJ> e cartão <CARD>.",
  );
  assert.doesNotMatch(redacted, /\d{4}/);
});

test("avaliador favorece venda verificada e feedback humano positivo", () => {
  const messages = [
    { role: "user", content: "Quero comprar." },
    { role: "assistant", content: "Posso gerar o pedido agora. Confirma o endereço?" },
    { role: "user", content: "Confirmo." },
    { role: "assistant", content: "Pedido confirmado e pagamento aprovado." },
  ];
  const won = evaluateConversationHeuristically({
    messages,
    outcome: {
      status: CommercialOutcomeStatus.WON,
      confidence: 1,
      source: "payment",
    },
    feedback: [{ verdict: HumanFeedbackVerdict.POSITIVE, score: 100 }],
    verifiedCommerceLinks: 1,
  });
  const lost = evaluateConversationHeuristically({
    messages: messages.slice(0, 1),
    outcome: {
      status: CommercialOutcomeStatus.LOST,
      confidence: 0.95,
      source: "commerce_reconciliation",
    },
    feedback: [{ verdict: HumanFeedbackVerdict.NEGATIVE, score: -100 }],
    verifiedCommerceLinks: 1,
  });
  assert.ok(won.overallScore > lost.overallScore);
  assert.equal(won.dimensions.humanSatisfaction, 1);
  assert.equal(lost.dimensions.humanSatisfaction, 0);
  assert.ok(lost.recommendations.length > 0);
});

test("avaliação automática persiste os estados pending e completed", async () => {
  const writes: { operation: string; data: Record<string, unknown> }[] = [];
  const fakePrisma = {
    conversation: {
      findFirst: async () => ({ id: "conversation-1", externalId: "external-1" }),
    },
    promptVersion: {
      findFirst: async () => ({ id: "prompt-version-1" }),
    },
    conversationMessage: {
      findMany: async () => [
        { id: "message-1", role: "user", content: "Olá", createdAt: new Date(1) },
        { id: "message-2", role: "assistant", content: "Como posso ajudar?", createdAt: new Date(2) },
      ],
    },
    commercialOutcome: {
      findFirst: async () => ({
        status: CommercialOutcomeStatus.PENDING,
        confidence: 0.5,
        source: "manual",
        revision: 1,
      }),
    },
    humanFeedback: {
      findMany: async () => [{ verdict: HumanFeedbackVerdict.NEUTRAL, score: 0 }],
    },
    commerceLink: {
      count: async () => 0,
    },
    automaticEvaluation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ operation: "create", data });
        return { id: "evaluation-1", ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ operation: "update", data });
        return { id: "evaluation-1", ...data };
      },
    },
  } as unknown as PrismaClient;
  const service = new ContinuousImprovementService(fakePrisma);
  const result = await service.runAutomaticEvaluation({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    promptVersionId: "prompt-version-1",
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.operation, "create");
  assert.equal(writes[1]?.data.status, "COMPLETED");
  assert.equal(result.id, "evaluation-1");
  assert.equal(typeof result.overallScore, "number");
});

test("reconciliação converte pagamento verificado em outcome WON versionado", async () => {
  const created: Record<string, unknown>[] = [];
  const fakePrisma = {
    conversation: {
      findFirst: async () => ({ id: "conversation-1", externalId: "external-1" }),
    },
    commerceLink: {
      findMany: async () => [{
        id: "payment-link-1",
        kind: CommerceLinkKind.PAYMENT,
        source: "erp",
        externalId: "payment-123",
        status: "paid",
        verifiedAt: new Date("2026-07-28T12:00:00Z"),
        updatedAt: new Date("2026-07-28T12:00:00Z"),
      }],
    },
    commercialOutcome: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "outcome-1", ...data };
      },
    },
    $transaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
    ) => callback(fakePrisma),
  } as unknown as PrismaClient;
  const service = new ContinuousImprovementService(fakePrisma);
  const outcome = await service.recalculateCommercialOutcome("tenant-1", "conversation-1");
  assert.equal(outcome.status, CommercialOutcomeStatus.WON);
  assert.equal(outcome.source, "commerce_reconciliation");
  assert.equal(outcome.confidence, 1);
  assert.equal(created[0]?.revision, 1);
});

test("vínculo comercial verificado exige evidência externa", async () => {
  const fakePrisma = {
    conversation: {
      findFirst: async () => ({ id: "conversation-1", externalId: "external-1" }),
    },
  } as unknown as PrismaClient;
  const service = new ContinuousImprovementService(fakePrisma);
  await assert.rejects(
    service.upsertCommerceLink({
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      kind: CommerceLinkKind.ORDER,
      source: "erp",
      externalId: "order-1",
      status: "paid",
      verificationStatus: CommerceVerificationStatus.VERIFIED,
    }),
    (error: unknown) => error instanceof ContinuousImprovementError
      && error.code === "verification_evidence_required",
  );
});

test("feedback neutro não vira exemplo bom ou ruim no dataset", async () => {
  const fakePrisma = {
    humanFeedback: {
      findFirst: async () => ({
        id: "feedback-1",
        tenantId: "tenant-1",
        verdict: HumanFeedbackVerdict.NEUTRAL,
      }),
    },
  } as unknown as PrismaClient;
  const service = new ContinuousImprovementService(fakePrisma);
  await assert.rejects(
    service.materializeFeedbackExample({
      tenantId: "tenant-1",
      feedbackId: "feedback-1",
      datasetVersionId: "dataset-version-1",
    }),
    (error: unknown) => error instanceof ContinuousImprovementError
      && error.code === "neutral_feedback_not_trainable",
  );
});
