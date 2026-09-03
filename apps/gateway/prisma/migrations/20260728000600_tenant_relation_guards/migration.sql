-- Enforce tenant ownership at the foreign-key boundary.
--
-- The application stores tenantId on the learning/commercial child records so
-- they can be queried efficiently. A foreign key that only references the
-- parent's globally unique id does not prove that both tenantId values match.
-- These composite keys make that invariant a database guarantee.

-- Do not guess ownership when upgrading an existing database. If a historical
-- cross-tenant relation exists, abort with the affected relation names so it
-- can be reviewed rather than silently moving data between tenants.
DO $migration$
DECLARE
  violations TEXT;
BEGIN
  SELECT string_agg(issue || '=' || amount::TEXT, ', ' ORDER BY issue)
  INTO violations
  FROM (
    SELECT 'AiLog.promptVersion' AS issue, count(*) AS amount
      FROM "AiLog" child
      JOIN "PromptVersion" parent ON parent."id" = child."promptVersionId"
      WHERE child."promptVersionId" IS NOT NULL
        AND child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'AutomaticEvaluation.conversation', count(*)
      FROM "AutomaticEvaluation" child
      JOIN "Conversation" parent ON parent."id" = child."conversationId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'AutomaticEvaluation.promptVersion', count(*)
      FROM "AutomaticEvaluation" child
      JOIN "PromptVersion" parent ON parent."id" = child."promptVersionId"
      WHERE child."promptVersionId" IS NOT NULL
        AND child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'CommerceLink.conversation', count(*)
      FROM "CommerceLink" child
      JOIN "Conversation" parent ON parent."id" = child."conversationId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'CommercialOutcome.conversation', count(*)
      FROM "CommercialOutcome" child
      JOIN "Conversation" parent ON parent."id" = child."conversationId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'CommercialOutcome.supersedes', count(*)
      FROM "CommercialOutcome" child
      JOIN "CommercialOutcome" parent ON parent."id" = child."supersedesId"
      WHERE child."supersedesId" IS NOT NULL
        AND (
          child."tenantId" <> parent."tenantId"
          OR child."conversationId" <> parent."conversationId"
        )
      HAVING count(*) > 0
    UNION ALL
    SELECT 'ConversationMessage.promptVersion', count(*)
      FROM "ConversationMessage" child
      JOIN "Conversation" conversation ON conversation."id" = child."conversationId"
      JOIN "PromptVersion" prompt_version ON prompt_version."id" = child."promptVersionId"
      WHERE child."promptVersionId" IS NOT NULL
        AND conversation."tenantId" <> prompt_version."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'DatasetExample.automaticEvaluation', count(*)
      FROM "DatasetExample" child
      JOIN "AutomaticEvaluation" parent ON parent."id" = child."automaticEvaluationId"
      WHERE child."automaticEvaluationId" IS NOT NULL
        AND child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'DatasetExample.conversation', count(*)
      FROM "DatasetExample" child
      JOIN "Conversation" parent ON parent."id" = child."conversationId"
      WHERE child."conversationId" IS NOT NULL
        AND child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'DatasetExample.datasetVersion', count(*)
      FROM "DatasetExample" child
      JOIN "DatasetVersion" parent ON parent."id" = child."datasetVersionId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'DatasetExample.humanFeedback', count(*)
      FROM "DatasetExample" child
      JOIN "HumanFeedback" parent ON parent."id" = child."humanFeedbackId"
      WHERE child."humanFeedbackId" IS NOT NULL
        AND child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'DatasetVersion.basedOnVersion', count(*)
      FROM "DatasetVersion" child
      JOIN "DatasetVersion" parent ON parent."id" = child."basedOnVersionId"
      WHERE child."basedOnVersionId" IS NOT NULL
        AND (
          child."tenantId" <> parent."tenantId"
          OR child."datasetId" <> parent."datasetId"
        )
      HAVING count(*) > 0
    UNION ALL
    SELECT 'DatasetVersion.dataset', count(*)
      FROM "DatasetVersion" child
      JOIN "EvaluationDataset" parent ON parent."id" = child."datasetId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'HumanFeedback.conversation', count(*)
      FROM "HumanFeedback" child
      JOIN "Conversation" parent ON parent."id" = child."conversationId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'HumanFeedback.message', count(*)
      FROM "HumanFeedback" child
      JOIN "ConversationMessage" parent ON parent."id" = child."messageId"
      WHERE child."messageId" IS NOT NULL
        AND child."conversationId" <> parent."conversationId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptComparison.baseVersion', count(*)
      FROM "PromptComparison" child
      JOIN "PromptVersion" parent ON parent."id" = child."baseVersionId"
      WHERE child."tenantId" <> parent."tenantId"
         OR child."promptDefinitionId" <> parent."promptDefinitionId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptComparison.candidateVersion', count(*)
      FROM "PromptComparison" child
      JOIN "PromptVersion" parent ON parent."id" = child."candidateVersionId"
      WHERE child."tenantId" <> parent."tenantId"
         OR child."promptDefinitionId" <> parent."promptDefinitionId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptComparison.promptDefinition', count(*)
      FROM "PromptComparison" child
      JOIN "PromptDefinition" parent ON parent."id" = child."promptDefinitionId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptRelease.canaryVersion', count(*)
      FROM "PromptRelease" child
      JOIN "PromptVersion" parent ON parent."id" = child."canaryVersionId"
      WHERE child."canaryVersionId" IS NOT NULL
        AND (
          child."tenantId" <> parent."tenantId"
          OR child."promptDefinitionId" <> parent."promptDefinitionId"
        )
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptRelease.previousRelease', count(*)
      FROM "PromptRelease" child
      JOIN "PromptRelease" parent ON parent."id" = child."previousReleaseId"
      WHERE child."previousReleaseId" IS NOT NULL
        AND (
          child."tenantId" <> parent."tenantId"
          OR child."promptDefinitionId" <> parent."promptDefinitionId"
        )
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptRelease.primaryVersion', count(*)
      FROM "PromptRelease" child
      JOIN "PromptVersion" parent ON parent."id" = child."primaryVersionId"
      WHERE child."tenantId" <> parent."tenantId"
         OR child."promptDefinitionId" <> parent."promptDefinitionId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptRelease.promptDefinition', count(*)
      FROM "PromptRelease" child
      JOIN "PromptDefinition" parent ON parent."id" = child."promptDefinitionId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
    UNION ALL
    SELECT 'PromptVersion.promptDefinition', count(*)
      FROM "PromptVersion" child
      JOIN "PromptDefinition" parent ON parent."id" = child."promptDefinitionId"
      WHERE child."tenantId" <> parent."tenantId"
      HAVING count(*) > 0
  ) invalid_relations;

  IF violations IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot install tenant relation guards; cross-tenant data exists: %',
      violations;
  END IF;
END;
$migration$;

-- Composite candidate keys used by the guarded foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_tenantId_id_key"
  ON "Conversation"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationMessage_conversationId_id_key"
  ON "ConversationMessage"("conversationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CommercialOutcome_tenantId_conversationId_id_key"
  ON "CommercialOutcome"("tenantId", "conversationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "HumanFeedback_tenantId_id_key"
  ON "HumanFeedback"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationDataset_tenantId_id_key"
  ON "EvaluationDataset"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "DatasetVersion_tenantId_datasetId_id_key"
  ON "DatasetVersion"("tenantId", "datasetId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "DatasetVersion_tenantId_id_key"
  ON "DatasetVersion"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticEvaluation_tenantId_id_key"
  ON "AutomaticEvaluation"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PromptDefinition_tenantId_id_key"
  ON "PromptDefinition"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PromptVersion_tenantId_promptDefinitionId_id_key"
  ON "PromptVersion"("tenantId", "promptDefinitionId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PromptVersion_tenantId_id_key"
  ON "PromptVersion"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PromptRelease_tenantId_promptDefinitionId_id_key"
  ON "PromptRelease"("tenantId", "promptDefinitionId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PromptRelease_tenantId_id_key"
  ON "PromptRelease"("tenantId", "id");

-- Required relations retain CASCADE/RESTRICT behavior while now including the
-- tenant key. Optional relations use PostgreSQL's column-specific SET NULL so
-- only the nullable id is cleared; tenantId remains mandatory.
ALTER TABLE "CommercialOutcome"
  DROP CONSTRAINT IF EXISTS "CommercialOutcome_conversationId_fkey",
  ADD CONSTRAINT "CommercialOutcome_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId")
    REFERENCES "Conversation"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "CommercialOutcome_supersedesId_fkey",
  ADD CONSTRAINT "CommercialOutcome_supersedesId_fkey"
    FOREIGN KEY ("tenantId", "conversationId", "supersedesId")
    REFERENCES "CommercialOutcome"("tenantId", "conversationId", "id")
    ON DELETE SET NULL ("supersedesId") ON UPDATE CASCADE;

ALTER TABLE "CommerceLink"
  DROP CONSTRAINT IF EXISTS "CommerceLink_conversationId_fkey",
  ADD CONSTRAINT "CommerceLink_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId")
    REFERENCES "Conversation"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HumanFeedback"
  DROP CONSTRAINT IF EXISTS "HumanFeedback_conversationId_fkey",
  ADD CONSTRAINT "HumanFeedback_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId")
    REFERENCES "Conversation"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "HumanFeedback_messageId_fkey",
  ADD CONSTRAINT "HumanFeedback_messageId_fkey"
    FOREIGN KEY ("conversationId", "messageId")
    REFERENCES "ConversationMessage"("conversationId", "id")
    ON DELETE SET NULL ("messageId") ON UPDATE CASCADE;

ALTER TABLE "DatasetVersion"
  DROP CONSTRAINT IF EXISTS "DatasetVersion_datasetId_fkey",
  ADD CONSTRAINT "DatasetVersion_datasetId_fkey"
    FOREIGN KEY ("tenantId", "datasetId")
    REFERENCES "EvaluationDataset"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "DatasetVersion_basedOnVersionId_fkey",
  ADD CONSTRAINT "DatasetVersion_basedOnVersionId_fkey"
    FOREIGN KEY ("tenantId", "datasetId", "basedOnVersionId")
    REFERENCES "DatasetVersion"("tenantId", "datasetId", "id")
    ON DELETE SET NULL ("basedOnVersionId") ON UPDATE CASCADE;

ALTER TABLE "DatasetExample"
  DROP CONSTRAINT IF EXISTS "DatasetExample_datasetVersionId_fkey",
  ADD CONSTRAINT "DatasetExample_datasetVersionId_fkey"
    FOREIGN KEY ("tenantId", "datasetVersionId")
    REFERENCES "DatasetVersion"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "DatasetExample_conversationId_fkey",
  ADD CONSTRAINT "DatasetExample_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId")
    REFERENCES "Conversation"("tenantId", "id")
    ON DELETE SET NULL ("conversationId") ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "DatasetExample_humanFeedbackId_fkey",
  ADD CONSTRAINT "DatasetExample_humanFeedbackId_fkey"
    FOREIGN KEY ("tenantId", "humanFeedbackId")
    REFERENCES "HumanFeedback"("tenantId", "id")
    ON DELETE SET NULL ("humanFeedbackId") ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "DatasetExample_automaticEvaluationId_fkey",
  ADD CONSTRAINT "DatasetExample_automaticEvaluationId_fkey"
    FOREIGN KEY ("tenantId", "automaticEvaluationId")
    REFERENCES "AutomaticEvaluation"("tenantId", "id")
    ON DELETE SET NULL ("automaticEvaluationId") ON UPDATE CASCADE;

ALTER TABLE "AutomaticEvaluation"
  DROP CONSTRAINT IF EXISTS "AutomaticEvaluation_conversationId_fkey",
  ADD CONSTRAINT "AutomaticEvaluation_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId")
    REFERENCES "Conversation"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "AutomaticEvaluation_promptVersionId_fkey",
  ADD CONSTRAINT "AutomaticEvaluation_promptVersionId_fkey"
    FOREIGN KEY ("tenantId", "promptVersionId")
    REFERENCES "PromptVersion"("tenantId", "id")
    ON DELETE SET NULL ("promptVersionId") ON UPDATE CASCADE;

ALTER TABLE "PromptVersion"
  DROP CONSTRAINT IF EXISTS "PromptVersion_promptDefinitionId_fkey",
  ADD CONSTRAINT "PromptVersion_promptDefinitionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId")
    REFERENCES "PromptDefinition"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromptComparison"
  DROP CONSTRAINT IF EXISTS "PromptComparison_promptDefinitionId_fkey",
  ADD CONSTRAINT "PromptComparison_promptDefinitionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId")
    REFERENCES "PromptDefinition"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "PromptComparison_baseVersionId_fkey",
  ADD CONSTRAINT "PromptComparison_baseVersionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId", "baseVersionId")
    REFERENCES "PromptVersion"("tenantId", "promptDefinitionId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "PromptComparison_candidateVersionId_fkey",
  ADD CONSTRAINT "PromptComparison_candidateVersionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId", "candidateVersionId")
    REFERENCES "PromptVersion"("tenantId", "promptDefinitionId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromptRelease"
  DROP CONSTRAINT IF EXISTS "PromptRelease_promptDefinitionId_fkey",
  ADD CONSTRAINT "PromptRelease_promptDefinitionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId")
    REFERENCES "PromptDefinition"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "PromptRelease_primaryVersionId_fkey",
  ADD CONSTRAINT "PromptRelease_primaryVersionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId", "primaryVersionId")
    REFERENCES "PromptVersion"("tenantId", "promptDefinitionId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "PromptRelease_canaryVersionId_fkey",
  ADD CONSTRAINT "PromptRelease_canaryVersionId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId", "canaryVersionId")
    REFERENCES "PromptVersion"("tenantId", "promptDefinitionId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP CONSTRAINT IF EXISTS "PromptRelease_previousReleaseId_fkey",
  ADD CONSTRAINT "PromptRelease_previousReleaseId_fkey"
    FOREIGN KEY ("tenantId", "promptDefinitionId", "previousReleaseId")
    REFERENCES "PromptRelease"("tenantId", "promptDefinitionId", "id")
    ON DELETE SET NULL ("previousReleaseId") ON UPDATE CASCADE;

ALTER TABLE "AiLog"
  DROP CONSTRAINT IF EXISTS "AiLog_promptVersionId_fkey",
  ADD CONSTRAINT "AiLog_promptVersionId_fkey"
    FOREIGN KEY ("tenantId", "promptVersionId")
    REFERENCES "PromptVersion"("tenantId", "id")
    ON DELETE SET NULL ("promptVersionId") ON UPDATE CASCADE;

-- ConversationMessage intentionally derives its tenant through Conversation
-- instead of duplicating tenantId. A composite FK cannot span that join, so a
-- PostgreSQL constraint trigger enforces the equivalent invariant.
CREATE OR REPLACE FUNCTION "assertConversationMessagePromptTenant"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."promptVersionId" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "Conversation" conversation
    JOIN "PromptVersion" prompt_version
      ON prompt_version."id" = NEW."promptVersionId"
    WHERE conversation."id" = NEW."conversationId"
      AND conversation."tenantId" <> prompt_version."tenantId"
  ) THEN
    RAISE EXCEPTION
      'ConversationMessage % cannot reference PromptVersion % from another tenant',
      NEW."id",
      NEW."promptVersionId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "ConversationMessage_prompt_tenant_guard"
  ON "ConversationMessage";
CREATE CONSTRAINT TRIGGER "ConversationMessage_prompt_tenant_guard"
AFTER INSERT OR UPDATE OF "conversationId", "promptVersionId"
ON "ConversationMessage"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "assertConversationMessagePromptTenant"();

-- Keep the invariant true if ownership is changed through a parent update.
CREATE OR REPLACE FUNCTION "assertConversationPromptTenantsAfterParentUpdate"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ConversationMessage" message
    JOIN "Conversation" conversation
      ON conversation."id" = message."conversationId"
    JOIN "PromptVersion" prompt_version
      ON prompt_version."id" = message."promptVersionId"
    WHERE message."promptVersionId" IS NOT NULL
      AND (
        (TG_TABLE_NAME = 'Conversation' AND conversation."id" = NEW."id")
        OR
        (TG_TABLE_NAME = 'PromptVersion' AND prompt_version."id" = NEW."id")
      )
      AND conversation."tenantId" <> prompt_version."tenantId"
  ) THEN
    RAISE EXCEPTION
      '% % cannot change tenant while referenced by a cross-tenant ConversationMessage',
      TG_TABLE_NAME,
      NEW."id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "Conversation_prompt_tenant_parent_guard"
  ON "Conversation";
CREATE CONSTRAINT TRIGGER "Conversation_prompt_tenant_parent_guard"
AFTER UPDATE OF "tenantId"
ON "Conversation"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
EXECUTE FUNCTION "assertConversationPromptTenantsAfterParentUpdate"();

DROP TRIGGER IF EXISTS "PromptVersion_message_tenant_parent_guard"
  ON "PromptVersion";
CREATE CONSTRAINT TRIGGER "PromptVersion_message_tenant_parent_guard"
AFTER UPDATE OF "tenantId"
ON "PromptVersion"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
EXECUTE FUNCTION "assertConversationPromptTenantsAfterParentUpdate"();
