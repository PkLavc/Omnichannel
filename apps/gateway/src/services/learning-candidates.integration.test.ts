import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomaticEvaluationStatus,
  CommercialOutcomeStatus,
  CommerceLinkKind,
  CommerceVerificationStatus,
  LearningAgentRole,
  LearningCandidateStatus,
  LearningReviewDecision,
  PrismaClient,
} from "@prisma/client";
import { LearningCandidateService } from "./learning-candidates.js";

const databaseUrl = process.env.LEARNING_CANDIDATES_TEST_DATABASE_URL;

test("pipeline consolidado exige evidência real, aprovação humana e isolamento por agente", {
  skip: !databaseUrl,
  timeout: 30_000,
}, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenant = await prisma.tenant.create({
    data: { slug: `learning-candidate-test-${suffix}`, name: "Learning candidate integration" },
  });
  try {
    for (let index = 0; index < 8; index += 1) {
      const conversation = await prisma.conversation.create({
        data: {
          tenantId: tenant.id,
          externalId: `conversation-${suffix}-${index}`,
          state: { contactId: `customer-${suffix}-${index}`, activeAgent: "sales" },
          messages: {
            create: [
              { role: "user", content: `Quero comprar o produto ${index}.` },
              { role: "assistant", content: "Qual modelo você procura?" },
              { role: "user", content: "Este modelo atende." },
              {
                role: "assistant",
                content: "Posso finalizar o pedido? Também consigo aplicar 91% de desconto.",
              },
            ],
          },
        },
      });
      await prisma.commercialOutcome.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          status: CommercialOutcomeStatus.WON,
          source: "integration-erp",
          confidence: 1,
          evidence: { orderId: `order-${suffix}-${index}` },
          revision: 1,
          createdBy: "integration-test",
        },
      });
      await prisma.commerceLink.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          kind: CommerceLinkKind.ORDER,
          source: "integration-erp",
          externalId: `order-${suffix}-${index}`,
          status: "paid",
          verificationStatus: CommerceVerificationStatus.VERIFIED,
          verificationEvidence: { verifiedBy: "integration-test" },
          verifiedAt: new Date(),
        },
      });
      await prisma.automaticEvaluation.create({
        data: {
          tenantId: tenant.id,
          conversationId: conversation.id,
          status: AutomaticEvaluationStatus.COMPLETED,
          evaluator: "deterministic-conversation-rubric",
          evaluatorVersion: "1.0.0",
          overallScore: 0.9,
          completedAt: new Date(),
        },
      });
    }

    const service = new LearningCandidateService(prisma, {
      identityPepper: "integration-learning-pepper-12345",
    });
    const discovery = await service.discoverFromEvaluations({
      tenantId: tenant.id,
      limit: 100,
      maxCandidates: 32,
    });
    const behavior = discovery.updatedCandidates.find(candidate => (
      candidate.agentRole === LearningAgentRole.SALES
      && candidate.key === "behavior.qualify-before-recommendation"
    ));
    const unsafeOffer = discovery.updatedCandidates.find(candidate => (
      candidate.key === "offer.recurring-commercial-condition"
    ));
    assert.equal(behavior?.status, LearningCandidateStatus.READY_FOR_REVIEW);
    assert.equal(behavior?.distinctConversationCount, 8);
    assert.equal(behavior?.distinctCustomerCount, 8);
    assert.equal(behavior?.verifiedOutcomeCount, 8);
    assert.equal(unsafeOffer?.status, LearningCandidateStatus.BLOCKED_GROUNDING);

    await assert.rejects(
      service.reviewCandidates({
        tenantId: tenant.id,
        candidateIds: [unsafeOffer!.id],
        decision: LearningReviewDecision.APPROVE,
        reviewerId: "integration-reviewer",
      }),
      /only ready candidates/u,
    );
    await service.reviewCandidates({
      tenantId: tenant.id,
      candidateIds: [behavior!.id],
      decision: LearningReviewDecision.APPROVE,
      reviewerId: "integration-reviewer",
      note: "Tática revisada no teste de integração.",
    });

    const salesGuidance = await service.listApprovedGuidance(tenant.id, LearningAgentRole.SALES);
    const technicalGuidance = await service.listApprovedGuidance(tenant.id, LearningAgentRole.TECHNICAL);
    assert.equal(salesGuidance.some(item => item.id === behavior!.id), true);
    assert.equal(technicalGuidance.some(item => item.id === behavior!.id), false);
    assert.doesNotMatch(JSON.stringify(salesGuidance), /91%/u);

    const reviews = await prisma.learningCandidateReview.findMany({
      where: { tenantId: tenant.id, candidateId: behavior!.id },
    });
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.decision, LearningReviewDecision.APPROVE);
    assert.equal(reviews[0]?.reviewerId, "integration-reviewer");
  } finally {
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
