import assert from "node:assert/strict";
import test from "node:test";
import {
  CommercialOutcomeStatus,
  CommerceLinkKind,
  CommerceVerificationStatus,
  HumanFeedbackVerdict,
  PrismaClient,
  PromptVersionStatus,
} from "@prisma/client";
import {
  ContinuousImprovementService,
  deterministicCanaryBucket,
} from "./continuous-improvement.js";

const databaseUrl = process.env.CONTINUOUS_IMPROVEMENT_TEST_DATABASE_URL;

test("fluxo persistente de melhoria contínua funciona ponta a ponta", {
  skip: !databaseUrl,
  timeout: 30_000,
}, async () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl! } },
  });
  const service = new ContinuousImprovementService(prisma);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenant = await prisma.tenant.create({
    data: {
      slug: `learning-test-${suffix}`,
      name: "Learning integration test",
    },
  });
  try {
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: tenant.id,
        externalId: `conversation-${suffix}`,
        messages: {
          create: [
            {
              externalId: `message-user-${suffix}`,
              role: "user",
              content: "Meu CPF é 123.456.789-00 e quero comprar.",
            },
            {
              externalId: `message-assistant-${suffix}`,
              role: "assistant",
              content: "Criei seu pedido. Pague com o cartão 4111 1111 1111 1111.",
              provider: "integration-test",
            },
          ],
        },
      },
      include: { messages: true },
    });

    await service.upsertCommerceLink({
      tenantId: tenant.id,
      conversationId: conversation.id,
      kind: CommerceLinkKind.PAYMENT,
      source: "integration-erp",
      externalId: `payment-${suffix}`,
      status: "paid",
      value: 199.9,
      currency: "brl",
      verificationStatus: CommerceVerificationStatus.VERIFIED,
      verificationEvidence: {
        receiptId: `receipt-${suffix}`,
        verifiedBy: "integration-test",
      },
    });
    const outcome = await service.recalculateCommercialOutcome(tenant.id, conversation.id);
    assert.equal(outcome.status, CommercialOutcomeStatus.WON);
    assert.equal(outcome.revision, 1);

    const assistantMessage = conversation.messages.find(message => message.role === "assistant");
    const feedback = await service.recordHumanFeedback({
      tenantId: tenant.id,
      conversationId: conversation.id,
      messageId: assistantMessage!.id,
      verdict: HumanFeedbackVerdict.NEGATIVE,
      score: -60,
      comment: "Não deve repetir o CPF 123.456.789-00.",
      expectedResponse: "Pedido confirmado para cliente@example.com.",
      reviewerId: "reviewer@test",
    });

    const base = await service.createPromptVersion({
      tenantId: tenant.id,
      content: {
        system: "Ajude o cliente.",
        commercial: "Confirme o pedido.",
        support: "Colete o defeito.",
        postSale: "Confirme a garantia.",
      },
      createdBy: "integration-test",
    });
    const candidate = await service.createPromptVersion({
      tenantId: tenant.id,
      content: {
        system: "Ajude o cliente e não exponha dados pessoais.",
        commercial: "Confirme pedido e pagamento.",
        support: "Colete apenas dados técnicos necessários.",
        postSale: "Confirme garantia e número do pedido.",
      },
      createdBy: "integration-test",
    });
    await service.approvePromptVersion({
      tenantId: tenant.id,
      promptVersionId: base.id,
      approvedBy: "approver@test",
    });
    await service.approvePromptVersion({
      tenantId: tenant.id,
      promptVersionId: candidate.id,
      approvedBy: "approver@test",
    });
    const comparison = await service.comparePromptVersions({
      tenantId: tenant.id,
      baseVersionId: base.id,
      candidateVersionId: candidate.id,
      createdBy: "reviewer@test",
    });
    assert.deepEqual(
      (comparison.diff as { changedFields: string[] }).changedFields.sort(),
      ["commercial", "postSale", "support", "system"],
    );
    const release = await service.deployPrompt({
      tenantId: tenant.id,
      primaryVersionId: base.id,
      canaryVersionId: candidate.id,
      canaryPercent: 50,
      createdBy: "deployer@test",
    });
    let canaryConversationId = "canary-0";
    for (let index = 0; index < 1_000; index += 1) {
      const candidateId = `canary-${index}`;
      if (deterministicCanaryBucket(tenant.id, release.promptDefinitionId, candidateId) < 50) {
        canaryConversationId = candidateId;
        break;
      }
    }
    const selected = await service.selectPromptVersion({
      tenantId: tenant.id,
      conversationExternalId: canaryConversationId,
    });
    assert.equal(selected?.versionId, candidate.id);
    assert.equal(selected?.isCanary, true);

    const evaluation = await service.runAutomaticEvaluation({
      tenantId: tenant.id,
      conversationId: conversation.id,
      promptVersionId: selected!.versionId,
    });
    assert.equal(evaluation.status, "COMPLETED");

    const dataset = await service.ensureDataset(
      tenant.id,
      "atendimentos-avaliados",
      "Exemplos aprovados para regressão",
    );
    const draft = await service.createDatasetDraft({
      tenantId: tenant.id,
      datasetId: dataset.id,
      createdBy: "reviewer@test",
    });
    const feedbackExample = await service.materializeFeedbackExample({
      tenantId: tenant.id,
      feedbackId: feedback.id,
      datasetVersionId: draft.id,
    });
    assert.doesNotMatch(feedbackExample.input, /123\.456\.789-00/);
    assert.doesNotMatch(feedbackExample.response, /4111 1111 1111 1111/);
    assert.equal(feedbackExample.expectedResponse, "Pedido confirmado para <EMAIL>.");
    await service.materializeEvaluationExample({
      tenantId: tenant.id,
      evaluationId: evaluation.id,
      datasetVersionId: draft.id,
    });
    const published = await service.publishDatasetVersion({
      tenantId: tenant.id,
      datasetVersionId: draft.id,
      publishedBy: "approver@test",
    });
    assert.equal(published.status, "PUBLISHED");

    const promoted = await service.promoteCanary({
      tenantId: tenant.id,
      createdBy: "deployer@test",
    });
    assert.equal(promoted.primaryVersionId, candidate.id);
    const rolledBack = await service.rollbackPrompt({
      tenantId: tenant.id,
      targetVersionId: base.id,
      createdBy: "deployer@test",
      reason: "integration rollback test",
    });
    assert.equal(rolledBack.primaryVersionId, base.id);
    const approvedCount = await prisma.promptVersion.count({
      where: { tenantId: tenant.id, status: PromptVersionStatus.APPROVED },
    });
    assert.equal(approvedCount, 2);
    assert.equal(await prisma.datasetExample.count({
      where: { tenantId: tenant.id, datasetVersionId: draft.id },
    }), 2);
  } finally {
    await prisma.tenant.delete({ where: { id: tenant.id } });
    await prisma.$disconnect();
  }
});
