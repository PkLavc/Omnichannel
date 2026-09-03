-- A compact, trigger-maintained corpus counter makes semantic-cache
-- invalidation O(1), including imports, reindexing and deletions.
CREATE TABLE IF NOT EXISTS "RagCorpusState" (
    "tenantId" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RagCorpusState_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "RagCorpusState_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION "bumpRagCorpusVersion"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    affected_tenant TEXT;
BEGIN
    affected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;

    INSERT INTO "RagCorpusState" ("tenantId", "version", "updatedAt")
    VALUES (affected_tenant, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId") DO UPDATE
    SET "version" = "RagCorpusState"."version" + 1,
        "updatedAt" = CURRENT_TIMESTAMP;

    IF TG_OP = 'UPDATE' AND OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
        INSERT INTO "RagCorpusState" ("tenantId", "version", "updatedAt")
        VALUES (OLD."tenantId", 1, CURRENT_TIMESTAMP)
        ON CONFLICT ("tenantId") DO UPDATE
        SET "version" = "RagCorpusState"."version" + 1,
            "updatedAt" = CURRENT_TIMESTAMP;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "KnowledgeDocument_bump_corpus_version" ON "KnowledgeDocument";
CREATE TRIGGER "KnowledgeDocument_bump_corpus_version"
AFTER INSERT OR UPDATE OR DELETE ON "KnowledgeDocument"
FOR EACH ROW
EXECUTE FUNCTION "bumpRagCorpusVersion"();

INSERT INTO "RagCorpusState" ("tenantId", "version", "updatedAt")
SELECT DISTINCT "tenantId", 1, CURRENT_TIMESTAMP
FROM "KnowledgeDocument"
ON CONFLICT ("tenantId") DO NOTHING;

-- HNSW was introduced by pgvector 0.5.0. Older installations keep working
-- with the exact scan already used by the application instead of failing the
-- whole migration.
DO $migration$
DECLARE
    vector_version TEXT;
    version_parts TEXT[];
    vector_major INTEGER;
    vector_minor INTEGER;
BEGIN
    SELECT extversion
    INTO vector_version
    FROM pg_extension
    WHERE extname = 'vector';

    version_parts := regexp_match(COALESCE(vector_version, ''), '^([0-9]+)\.([0-9]+)');
    IF version_parts IS NULL THEN
        RAISE NOTICE 'pgvector version could not be detected; keeping exact vector scans';
        RETURN;
    END IF;

    vector_major := version_parts[1]::INTEGER;
    vector_minor := version_parts[2]::INTEGER;
    IF vector_major = 0 AND vector_minor < 5 THEN
        RAISE NOTICE 'pgvector % does not support HNSW; keeping exact vector scans', vector_version;
        RETURN;
    END IF;

    BEGIN
        EXECUTE '
            CREATE INDEX IF NOT EXISTS "KnowledgeDocument_embedding_hnsw_idx"
            ON "KnowledgeDocument"
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        ';
    EXCEPTION
        WHEN feature_not_supported OR undefined_object OR undefined_function OR invalid_parameter_value THEN
            RAISE NOTICE 'KnowledgeDocument HNSW unavailable (%); keeping exact vector scans', SQLERRM;
    END;

    IF to_regclass('"SemanticCacheEntry"') IS NOT NULL THEN
        BEGIN
            EXECUTE '
                CREATE INDEX IF NOT EXISTS "SemanticCacheEntry_embedding_hnsw_idx"
                ON "SemanticCacheEntry"
                USING hnsw (embedding vector_cosine_ops)
                WITH (m = 12, ef_construction = 48)
            ';
        EXCEPTION
            WHEN feature_not_supported OR undefined_object OR undefined_function OR invalid_parameter_value THEN
                RAISE NOTICE 'SemanticCacheEntry HNSW unavailable (%); semantic cache will use an exact scan', SQLERRM;
        END;
    END IF;
END;
$migration$;
