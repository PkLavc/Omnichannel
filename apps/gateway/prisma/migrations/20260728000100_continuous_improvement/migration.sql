-- Continuous-improvement core.
--
-- The guards make this migration safe to re-run manually while Prisma still
-- records it exactly once in normal deployments.

DO $$ BEGIN
  CREATE TYPE "CommercialOutcomeStatus" AS ENUM ('PENDING', 'WON', 'LOST');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "CommerceLinkKind" AS ENUM ('ORDER', 'PAYMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "CommerceVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "HumanFeedbackVerdict" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "DatasetVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "DatasetExampleLabel" AS ENUM ('GOOD', 'BAD');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "AutomaticEvaluationStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "PromptVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "PromptReleaseKind" AS ENUM ('ACTIVE', 'CANARY', 'ROLLBACK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "PromptReleaseStatus" AS ENUM ('ACTIVE', 'ENDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CommercialOutcome" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "status" "CommercialOutcomeStatus" NOT NULL DEFAULT 'PENDING',
  "source" TEXT NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]',
  "revision" INTEGER NOT NULL,
  "supersedesId" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialOutcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialOutcome_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "CommercialOutcome_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE IF NOT EXISTS "CommerceLink" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "kind" "CommerceLinkKind" NOT NULL,
  "source" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "value" DECIMAL(14,2),
  "currency" VARCHAR(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "verificationStatus" "CommerceVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "verificationEvidence" JSONB NOT NULL DEFAULT '{}',
  "observedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommerceLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommerceLink_value_check" CHECK ("value" IS NULL OR "value" >= 0),
  CONSTRAINT "CommerceLink_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
);

CREATE TABLE IF NOT EXISTS "HumanFeedback" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT,
  "verdict" "HumanFeedbackVerdict" NOT NULL,
  "score" INTEGER,
  "comment" TEXT,
  "expectedResponse" TEXT,
  "reviewerId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'admin',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HumanFeedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HumanFeedback_score_check" CHECK ("score" IS NULL OR ("score" >= -100 AND "score" <= 100))
);

CREATE TABLE IF NOT EXISTS "EvaluationDataset" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EvaluationDataset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DatasetVersion" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "datasetId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "DatasetVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "basedOnVersionId" TEXT,
  "checksum" TEXT NOT NULL,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "publishedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DatasetVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DatasetVersion_version_check" CHECK ("version" > 0)
);

CREATE TABLE IF NOT EXISTS "PromptDefinition" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromptDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PromptVersion" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "promptDefinitionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "variables" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "checksum" TEXT NOT NULL,
  "status" "PromptVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "createdBy" TEXT NOT NULL,
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptVersion_version_check" CHECK ("version" > 0)
);

CREATE TABLE IF NOT EXISTS "PromptComparison" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "promptDefinitionId" TEXT NOT NULL,
  "baseVersionId" TEXT NOT NULL,
  "candidateVersionId" TEXT NOT NULL,
  "diff" JSONB NOT NULL,
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "decision" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromptComparison_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptComparison_distinct_versions_check" CHECK ("baseVersionId" <> "candidateVersionId")
);

CREATE TABLE IF NOT EXISTS "PromptRelease" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "promptDefinitionId" TEXT NOT NULL,
  "primaryVersionId" TEXT NOT NULL,
  "canaryVersionId" TEXT,
  "canaryPercent" INTEGER NOT NULL DEFAULT 0,
  "kind" "PromptReleaseKind" NOT NULL,
  "status" "PromptReleaseStatus" NOT NULL DEFAULT 'ACTIVE',
  "previousReleaseId" TEXT,
  "reason" TEXT,
  "createdBy" TEXT NOT NULL,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromptRelease_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptRelease_canary_percent_check" CHECK ("canaryPercent" >= 0 AND "canaryPercent" <= 100),
  CONSTRAINT "PromptRelease_canary_shape_check" CHECK (
    (("canaryVersionId" IS NULL) AND "canaryPercent" = 0)
    OR
    (("canaryVersionId" IS NOT NULL) AND "canaryPercent" > 0 AND "primaryVersionId" <> "canaryVersionId")
  ),
  CONSTRAINT "PromptRelease_status_timestamp_check" CHECK (
    ("status" = 'ACTIVE' AND "endedAt" IS NULL)
    OR
    ("status" = 'ENDED' AND "endedAt" IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS "AutomaticEvaluation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "promptVersionId" TEXT,
  "status" "AutomaticEvaluationStatus" NOT NULL DEFAULT 'PENDING',
  "evaluator" TEXT NOT NULL,
  "evaluatorVersion" TEXT NOT NULL,
  "overallScore" DECIMAL(5,4),
  "dimensions" JSONB NOT NULL DEFAULT '{}',
  "recommendations" JSONB NOT NULL DEFAULT '[]',
  "evidence" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "inputSnapshot" JSONB NOT NULL DEFAULT '{}',
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomaticEvaluation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomaticEvaluation_score_check" CHECK ("overallScore" IS NULL OR ("overallScore" >= 0 AND "overallScore" <= 1))
);

CREATE TABLE IF NOT EXISTS "DatasetExample" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "datasetVersionId" TEXT NOT NULL,
  "conversationId" TEXT,
  "humanFeedbackId" TEXT,
  "automaticEvaluationId" TEXT,
  "label" "DatasetExampleLabel" NOT NULL,
  "input" TEXT NOT NULL,
  "response" TEXT NOT NULL,
  "expectedResponse" TEXT,
  "rationale" TEXT,
  "source" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "fingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DatasetExample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SemanticCacheEntry" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL DEFAULT 'rag',
  "corpusVersion" TEXT NOT NULL,
  "queryHash" TEXT NOT NULL,
  "embedding" vector(384) NOT NULL,
  "payload" JSONB NOT NULL,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "lastHitAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SemanticCacheEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SemanticCacheEntry_hit_count_check" CHECK ("hitCount" >= 0)
);

ALTER TABLE "ConversationMessage"
  ADD COLUMN IF NOT EXISTS "promptVersionId" TEXT;
ALTER TABLE "AiLog"
  ADD COLUMN IF NOT EXISTS "promptVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "ragSources" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "cacheHit" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "CommercialOutcome_conversationId_revision_key"
  ON "CommercialOutcome"("conversationId", "revision");
CREATE INDEX IF NOT EXISTS "CommercialOutcome_tenantId_status_createdAt_idx"
  ON "CommercialOutcome"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "CommercialOutcome_conversationId_createdAt_idx"
  ON "CommercialOutcome"("conversationId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "CommerceLink_tenantId_kind_source_externalId_key"
  ON "CommerceLink"("tenantId", "kind", "source", "externalId");
CREATE INDEX IF NOT EXISTS "CommerceLink_tenantId_conversationId_verificationStatus_idx"
  ON "CommerceLink"("tenantId", "conversationId", "verificationStatus");
CREATE INDEX IF NOT EXISTS "CommerceLink_tenantId_status_idx"
  ON "CommerceLink"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "HumanFeedback_tenantId_conversationId_createdAt_idx"
  ON "HumanFeedback"("tenantId", "conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "HumanFeedback_messageId_idx"
  ON "HumanFeedback"("messageId");

CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationDataset_tenantId_name_key"
  ON "EvaluationDataset"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "EvaluationDataset_tenantId_updatedAt_idx"
  ON "EvaluationDataset"("tenantId", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "DatasetVersion_datasetId_version_key"
  ON "DatasetVersion"("datasetId", "version");
CREATE INDEX IF NOT EXISTS "DatasetVersion_tenantId_status_createdAt_idx"
  ON "DatasetVersion"("tenantId", "status", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "PromptDefinition_tenantId_name_key"
  ON "PromptDefinition"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "PromptDefinition_tenantId_updatedAt_idx"
  ON "PromptDefinition"("tenantId", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "PromptVersion_promptDefinitionId_version_key"
  ON "PromptVersion"("promptDefinitionId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "PromptVersion_promptDefinitionId_checksum_key"
  ON "PromptVersion"("promptDefinitionId", "checksum");
CREATE INDEX IF NOT EXISTS "PromptVersion_tenantId_status_createdAt_idx"
  ON "PromptVersion"("tenantId", "status", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "PromptComparison_tenantId_baseVersionId_candidateVersionId_key"
  ON "PromptComparison"("tenantId", "baseVersionId", "candidateVersionId");
CREATE INDEX IF NOT EXISTS "PromptComparison_tenantId_promptDefinitionId_createdAt_idx"
  ON "PromptComparison"("tenantId", "promptDefinitionId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "PromptRelease_one_active_per_prompt_key"
  ON "PromptRelease"("promptDefinitionId") WHERE "status" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "PromptRelease_tenantId_promptDefinitionId_status_createdAt_idx"
  ON "PromptRelease"("tenantId", "promptDefinitionId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "PromptRelease_primaryVersionId_idx"
  ON "PromptRelease"("primaryVersionId");
CREATE INDEX IF NOT EXISTS "PromptRelease_canaryVersionId_idx"
  ON "PromptRelease"("canaryVersionId");

CREATE INDEX IF NOT EXISTS "AutomaticEvaluation_tenantId_conversationId_createdAt_idx"
  ON "AutomaticEvaluation"("tenantId", "conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomaticEvaluation_tenantId_status_createdAt_idx"
  ON "AutomaticEvaluation"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomaticEvaluation_promptVersionId_idx"
  ON "AutomaticEvaluation"("promptVersionId");

CREATE UNIQUE INDEX IF NOT EXISTS "DatasetExample_datasetVersionId_fingerprint_key"
  ON "DatasetExample"("datasetVersionId", "fingerprint");
CREATE INDEX IF NOT EXISTS "DatasetExample_tenantId_label_createdAt_idx"
  ON "DatasetExample"("tenantId", "label", "createdAt");
CREATE INDEX IF NOT EXISTS "DatasetExample_conversationId_idx"
  ON "DatasetExample"("conversationId");

CREATE UNIQUE INDEX IF NOT EXISTS "SemanticCacheEntry_tenantId_namespace_corpusVersion_queryHash_key"
  ON "SemanticCacheEntry"("tenantId", "namespace", "corpusVersion", "queryHash");
CREATE INDEX IF NOT EXISTS "SemanticCacheEntry_tenantId_namespace_corpusVersion_expiresAt_idx"
  ON "SemanticCacheEntry"("tenantId", "namespace", "corpusVersion", "expiresAt");

CREATE INDEX IF NOT EXISTS "ConversationMessage_promptVersionId_idx"
  ON "ConversationMessage"("promptVersionId");
CREATE INDEX IF NOT EXISTS "AiLog_promptVersionId_idx"
  ON "AiLog"("promptVersionId");

DO $$ BEGIN
  ALTER TABLE "CommercialOutcome" ADD CONSTRAINT "CommercialOutcome_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CommercialOutcome" ADD CONSTRAINT "CommercialOutcome_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CommercialOutcome" ADD CONSTRAINT "CommercialOutcome_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES "CommercialOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CommerceLink" ADD CONSTRAINT "CommerceLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CommerceLink" ADD CONSTRAINT "CommerceLink_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "HumanFeedback" ADD CONSTRAINT "HumanFeedback_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "HumanFeedback" ADD CONSTRAINT "HumanFeedback_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "HumanFeedback" ADD CONSTRAINT "HumanFeedback_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "ConversationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "EvaluationDataset" ADD CONSTRAINT "EvaluationDataset_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetVersion" ADD CONSTRAINT "DatasetVersion_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetVersion" ADD CONSTRAINT "DatasetVersion_datasetId_fkey"
    FOREIGN KEY ("datasetId") REFERENCES "EvaluationDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetVersion" ADD CONSTRAINT "DatasetVersion_basedOnVersionId_fkey"
    FOREIGN KEY ("basedOnVersionId") REFERENCES "DatasetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptDefinition" ADD CONSTRAINT "PromptDefinition_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_promptDefinitionId_fkey"
    FOREIGN KEY ("promptDefinitionId") REFERENCES "PromptDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptComparison" ADD CONSTRAINT "PromptComparison_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptComparison" ADD CONSTRAINT "PromptComparison_promptDefinitionId_fkey"
    FOREIGN KEY ("promptDefinitionId") REFERENCES "PromptDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptComparison" ADD CONSTRAINT "PromptComparison_baseVersionId_fkey"
    FOREIGN KEY ("baseVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptComparison" ADD CONSTRAINT "PromptComparison_candidateVersionId_fkey"
    FOREIGN KEY ("candidateVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptRelease" ADD CONSTRAINT "PromptRelease_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptRelease" ADD CONSTRAINT "PromptRelease_promptDefinitionId_fkey"
    FOREIGN KEY ("promptDefinitionId") REFERENCES "PromptDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptRelease" ADD CONSTRAINT "PromptRelease_primaryVersionId_fkey"
    FOREIGN KEY ("primaryVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptRelease" ADD CONSTRAINT "PromptRelease_canaryVersionId_fkey"
    FOREIGN KEY ("canaryVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PromptRelease" ADD CONSTRAINT "PromptRelease_previousReleaseId_fkey"
    FOREIGN KEY ("previousReleaseId") REFERENCES "PromptRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AutomaticEvaluation" ADD CONSTRAINT "AutomaticEvaluation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AutomaticEvaluation" ADD CONSTRAINT "AutomaticEvaluation_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AutomaticEvaluation" ADD CONSTRAINT "AutomaticEvaluation_promptVersionId_fkey"
    FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetExample" ADD CONSTRAINT "DatasetExample_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetExample" ADD CONSTRAINT "DatasetExample_datasetVersionId_fkey"
    FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetExample" ADD CONSTRAINT "DatasetExample_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetExample" ADD CONSTRAINT "DatasetExample_humanFeedbackId_fkey"
    FOREIGN KEY ("humanFeedbackId") REFERENCES "HumanFeedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DatasetExample" ADD CONSTRAINT "DatasetExample_automaticEvaluationId_fkey"
    FOREIGN KEY ("automaticEvaluationId") REFERENCES "AutomaticEvaluation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SemanticCacheEntry" ADD CONSTRAINT "SemanticCacheEntry_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_promptVersionId_fkey"
    FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AiLog" ADD CONSTRAINT "AiLog_promptVersionId_fkey"
    FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
