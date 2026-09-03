import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { vectorLiteral, type EmbeddingOptions } from "../core/embedding.js";
import { sanitizeKnowledgeText, type RetrievedDocument } from "./rag.js";

const CACHE_NAMESPACE_VERSION = "rag-v1";
const DEFAULT_TTL_SECONDS = 15 * 60;
const DEFAULT_MINIMUM_SIMILARITY = 0.96;

type CacheRow = {
  id: string;
  payload: unknown;
  similarity: number | string;
};

function boundedNumber(value: number, fallback: number, minimum: number, maximum: number) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function embeddingFingerprint(options: EmbeddingOptions) {
  const provider = options.provider
    ?? (options.fetch || options.baseUrl ? "ollama" : process.env.EMBEDDING_PROVIDER === "ollama" ? "ollama" : "local");
  const identity = JSON.stringify({
    provider,
    baseUrl: options.baseUrl ?? (provider === "ollama" ? process.env.OLLAMA_URL ?? "" : ""),
    model: options.model ?? (provider === "ollama" ? process.env.EMBEDDING_MODEL ?? "all-minilm" : "local-384-v1"),
  });
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function cacheNamespace(limit: number, minimumScore: number) {
  return `${CACHE_NAMESPACE_VERSION}:l${limit}:s${String(minimumScore)}`;
}

function queryHash(query: string) {
  return createHash("sha256").update(query.normalize("NFKC").trim()).digest("hex");
}

function validatePayload(payload: unknown): RetrievedDocument[] | undefined {
  if (!Array.isArray(payload) || payload.length > 80) return undefined;
  const documents: RetrievedDocument[] = [];
  for (const value of payload) {
    if (!value || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    const score = Number(item.score);
    if (typeof item.title !== "string" || typeof item.content !== "string" || !Number.isFinite(score)) {
      return undefined;
    }
    const title = sanitizeKnowledgeText(item.title, 300);
    const content = sanitizeKnowledgeText(item.content);
    if (!title || !content) return undefined;
    documents.push({ title, content, score });
  }
  return documents;
}

function cacheEnabled() {
  return process.env.RAG_CACHE_ENABLED !== "false";
}

/**
 * Reads the trigger-maintained corpus counter. A fingerprint of the embedding
 * configuration is appended so switching models cannot reuse incompatible
 * cached vectors.
 */
export async function readCorpusVersion(
  prisma: PrismaClient,
  tenantId: string,
  embeddingOptions: EmbeddingOptions = {},
): Promise<string | undefined> {
  if (!cacheEnabled()) return undefined;
  try {
    const rows = await prisma.$queryRaw<Array<{ version: string | number | bigint }>>(Prisma.sql`
      SELECT COALESCE(
        (SELECT version::text FROM "RagCorpusState" WHERE "tenantId" = ${tenantId}),
        '0'
      ) AS version
    `);
    const version = rows[0]?.version;
    if (typeof version !== "string" && typeof version !== "number" && typeof version !== "bigint") return undefined;
    return `${String(version)}:${embeddingFingerprint(embeddingOptions)}`;
  } catch {
    // Cache is an optimization. A deployment still migrating must use the
    // authoritative vector query instead of making RAG unavailable.
    return undefined;
  }
}

export type SemanticCacheLookup = {
  tenantId: string;
  corpusVersion: string;
  query: string;
  vector: number[];
  limit: number;
  minimumScore: number;
  minimumSimilarity?: number;
};

export async function readSemanticRagCache(
  prisma: PrismaClient,
  lookup: SemanticCacheLookup,
): Promise<RetrievedDocument[] | undefined> {
  if (!cacheEnabled()) return undefined;
  const namespace = cacheNamespace(lookup.limit, lookup.minimumScore);
  const minimumSimilarity = boundedNumber(
    lookup.minimumSimilarity ?? Number(process.env.RAG_CACHE_MIN_SCORE ?? DEFAULT_MINIMUM_SIMILARITY),
    DEFAULT_MINIMUM_SIMILARITY,
    0.8,
    1,
  );
  const vector = vectorLiteral(lookup.vector);

  try {
    const rows = await prisma.$queryRaw<CacheRow[]>(Prisma.sql`
      SELECT
        id,
        payload,
        1 - (embedding <=> ${vector}::vector) AS similarity
      FROM "SemanticCacheEntry"
      WHERE "tenantId" = ${lookup.tenantId}
        AND namespace = ${namespace}
        AND "corpusVersion" = ${lookup.corpusVersion}
        AND "expiresAt" > CURRENT_TIMESTAMP
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> ${vector}::vector) >= ${minimumSimilarity}
      ORDER BY embedding <=> ${vector}::vector
      LIMIT 1
    `);
    const row = rows[0];
    const documents = row ? validatePayload(row.payload) : undefined;
    if (!row || !documents || !Number.isFinite(Number(row.similarity))) return undefined;

    try {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "SemanticCacheEntry"
        SET "hitCount" = "hitCount" + 1, "lastHitAt" = CURRENT_TIMESTAMP
        WHERE id = ${row.id}
          AND "tenantId" = ${lookup.tenantId}
      `);
    } catch {
      // Metrics must never turn a valid cache hit into a failed retrieval.
    }
    return documents;
  } catch {
    return undefined;
  }
}

export type SemanticCacheWrite = SemanticCacheLookup & {
  documents: RetrievedDocument[];
  ttlSeconds?: number;
};

export async function writeSemanticRagCache(prisma: PrismaClient, entry: SemanticCacheWrite) {
  if (!cacheEnabled()) return false;
  const documents = validatePayload(entry.documents);
  if (!documents) return false;
  const ttlSeconds = boundedNumber(
    entry.ttlSeconds ?? Number(process.env.RAG_CACHE_TTL_SECONDS ?? DEFAULT_TTL_SECONDS),
    DEFAULT_TTL_SECONDS,
    30,
    86_400,
  );
  const namespace = cacheNamespace(entry.limit, entry.minimumScore);
  const hash = queryHash(entry.query);
  const vector = vectorLiteral(entry.vector);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);

  try {
    await prisma.$executeRaw(Prisma.sql`
      WITH purged AS (
        DELETE FROM "SemanticCacheEntry"
        WHERE "tenantId" = ${entry.tenantId}
          AND namespace = ${namespace}
          AND (
            "expiresAt" <= CURRENT_TIMESTAMP
            OR "corpusVersion" <> ${entry.corpusVersion}
          )
      )
      INSERT INTO "SemanticCacheEntry" (
        id,
        "tenantId",
        namespace,
        "corpusVersion",
        "queryHash",
        embedding,
        payload,
        "hitCount",
        "expiresAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${randomUUID()},
        ${entry.tenantId},
        ${namespace},
        ${entry.corpusVersion},
        ${hash},
        ${vector}::vector,
        ${JSON.stringify(documents)}::jsonb,
        0,
        ${expiresAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("tenantId", namespace, "corpusVersion", "queryHash")
      DO UPDATE SET
        embedding = EXCLUDED.embedding,
        payload = EXCLUDED.payload,
        "hitCount" = 0,
        "lastHitAt" = NULL,
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
    `);
    return true;
  } catch {
    return false;
  }
}
