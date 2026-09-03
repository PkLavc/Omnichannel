CREATE TYPE "LearningCandidateKind" AS ENUM (
  'BEHAVIORAL_TACTIC',
  'BUSINESS_FACT',
  'COMMERCIAL_OFFER'
);

CREATE TYPE "LearningCandidateStatus" AS ENUM (
  'GATHERING',
  'READY_FOR_REVIEW',
  'BLOCKED_GROUNDING',
  'APPROVED',
  'REJECTED',
  'ARCHIVED'
);

CREATE TYPE "LearningCandidateRisk" AS ENUM (
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL'
);

CREATE TYPE "LearningEvidencePolarity" AS ENUM (
  'SUPPORTS',
  'CONTRADICTS',
  'CONTEXT'
);

CREATE TYPE "LearningReviewDecision" AS ENUM (
  'APPROVE',
  'REJECT',
  'REOPEN'
);

CREATE TYPE "LearningAgentRole" AS ENUM (
  'INTAKE',
  'SALES',
  'CUSTOMER_CARE',
  'TECHNICAL'
);

CREATE TABLE "LearningCandidate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "agentRole" "LearningAgentRole" NOT NULL,
  "kind" "LearningCandidateKind" NOT NULL,
  "title" TEXT NOT NULL,
  "proposal" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "status" "LearningCandidateStatus" NOT NULL DEFAULT 'GATHERING',
  "risk" "LearningCandidateRisk" NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL DEFAULT 0,
  "evidenceCount" INTEGER NOT NULL DEFAULT 0,
  "supportingCount" INTEGER NOT NULL DEFAULT 0,
  "contradictingCount" INTEGER NOT NULL DEFAULT 0,
  "distinctConversationCount" INTEGER NOT NULL DEFAULT 0,
  "distinctCustomerCount" INTEGER NOT NULL DEFAULT 0,
  "verifiedOutcomeCount" INTEGER NOT NULL DEFAULT 0,
  "requiresGrounding" BOOLEAN NOT NULL DEFAULT false,
  "groundingVerified" BOOLEAN NOT NULL DEFAULT false,
  "groundingSources" JSONB NOT NULL DEFAULT '[]',
  "evidenceSummary" JSONB NOT NULL DEFAULT '{}',
  "windowStartedAt" TIMESTAMP(3),
  "windowEndedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearningCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningCandidateEvidence" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "conversationId" TEXT,
  "automaticEvaluationId" TEXT,
  "customerFingerprint" TEXT,
  "polarity" "LearningEvidencePolarity" NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "outcomeVerified" BOOLEAN NOT NULL DEFAULT false,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "fingerprint" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearningCandidateEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningCandidateReview" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "decision" "LearningReviewDecision" NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "note" TEXT,
  "batchId" TEXT,
  "snapshot" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningCandidateReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LearningCandidate_tenantId_fingerprint_key"
  ON "LearningCandidate"("tenantId", "fingerprint");
CREATE UNIQUE INDEX "LearningCandidate_tenantId_id_key"
  ON "LearningCandidate"("tenantId", "id");
CREATE INDEX "LearningCandidate_tenantId_status_risk_updatedAt_idx"
  ON "LearningCandidate"("tenantId", "status", "risk", "updatedAt");
CREATE INDEX "LearningCandidate_tenantId_agentRole_kind_key_idx"
  ON "LearningCandidate"("tenantId", "agentRole", "kind", "key");

CREATE UNIQUE INDEX "LearningCandidateEvidence_candidateId_fingerprint_key"
  ON "LearningCandidateEvidence"("candidateId", "fingerprint");
CREATE UNIQUE INDEX "LearningCandidateEvidence_tenantId_id_key"
  ON "LearningCandidateEvidence"("tenantId", "id");
CREATE INDEX "LearningCandidateEvidence_tenantId_candidateId_observedAt_idx"
  ON "LearningCandidateEvidence"("tenantId", "candidateId", "observedAt");
CREATE INDEX "LearningCandidateEvidence_tenantId_conversationId_idx"
  ON "LearningCandidateEvidence"("tenantId", "conversationId");
CREATE INDEX "LearningCandidateEvidence_automaticEvaluationId_idx"
  ON "LearningCandidateEvidence"("automaticEvaluationId");
CREATE INDEX "LearningCandidateEvidence_tenantId_customerFingerprint_idx"
  ON "LearningCandidateEvidence"("tenantId", "customerFingerprint");

CREATE UNIQUE INDEX "LearningCandidateReview_tenantId_id_key"
  ON "LearningCandidateReview"("tenantId", "id");
CREATE INDEX "LearningCandidateReview_tenantId_candidateId_createdAt_idx"
  ON "LearningCandidateReview"("tenantId", "candidateId", "createdAt");
CREATE INDEX "LearningCandidateReview_tenantId_batchId_idx"
  ON "LearningCandidateReview"("tenantId", "batchId");

ALTER TABLE "LearningCandidate"
  ADD CONSTRAINT "LearningCandidate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningCandidateEvidence"
  ADD CONSTRAINT "LearningCandidateEvidence_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LearningCandidateEvidence_candidateId_fkey"
  FOREIGN KEY ("tenantId", "candidateId")
  REFERENCES "LearningCandidate"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LearningCandidateEvidence_conversationId_fkey"
  FOREIGN KEY ("tenantId", "conversationId")
  REFERENCES "Conversation"("tenantId", "id")
  ON DELETE SET NULL ("conversationId") ON UPDATE CASCADE,
  ADD CONSTRAINT "LearningCandidateEvidence_automaticEvaluationId_fkey"
  FOREIGN KEY ("tenantId", "automaticEvaluationId")
  REFERENCES "AutomaticEvaluation"("tenantId", "id")
  ON DELETE SET NULL ("automaticEvaluationId") ON UPDATE CASCADE;

ALTER TABLE "LearningCandidateReview"
  ADD CONSTRAINT "LearningCandidateReview_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LearningCandidateReview_candidateId_fkey"
  FOREIGN KEY ("tenantId", "candidateId")
  REFERENCES "LearningCandidate"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
