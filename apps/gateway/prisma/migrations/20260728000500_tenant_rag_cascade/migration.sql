-- Tenant deletion cascades to KnowledgeDocument. The document DELETE trigger
-- must not recreate RagCorpusState after the parent Tenant has been removed.
CREATE OR REPLACE FUNCTION "bumpRagCorpusVersion"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    affected_tenant TEXT;
BEGIN
    affected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;

    IF EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = affected_tenant) THEN
        INSERT INTO "RagCorpusState" ("tenantId", "version", "updatedAt")
        VALUES (affected_tenant, 1, CURRENT_TIMESTAMP)
        ON CONFLICT ("tenantId") DO UPDATE
        SET "version" = "RagCorpusState"."version" + 1,
            "updatedAt" = CURRENT_TIMESTAMP;
    END IF;

    IF (
        TG_OP = 'UPDATE'
        AND OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
        AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = OLD."tenantId")
    ) THEN
        INSERT INTO "RagCorpusState" ("tenantId", "version", "updatedAt")
        VALUES (OLD."tenantId", 1, CURRENT_TIMESTAMP)
        ON CONFLICT ("tenantId") DO UPDATE
        SET "version" = "RagCorpusState"."version" + 1,
            "updatedAt" = CURRENT_TIMESTAMP;
    END IF;

    RETURN NULL;
END;
$$;
