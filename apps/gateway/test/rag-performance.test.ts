import test from "node:test";
import assert from "node:assert/strict";
import { DIMENSIONS } from "../dist/core/embedding.js";
import {
  readCorpusVersion,
  readSemanticRagCache,
  writeSemanticRagCache,
} from "../dist/services/rag-cache.js";
import { rerankDocuments } from "../dist/services/rag-reranker.js";
import { retrieve } from "../dist/services/rag.js";

function unitVector() {
  return Array.from({ length: DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
}

function sqlText(statement: unknown) {
  const sql = statement as { strings?: readonly string[] };
  return sql.strings?.join("?") ?? "";
}

function sqlValues(statement: unknown) {
  const sql = statement as { values?: readonly unknown[] };
  return sql.values ?? [];
}

test("hybrid reranker promotes literal business evidence without discarding vector relevance", () => {
  const documents = [
    {
      title: "Retirada do aparelho",
      content: "O prazo de retirada é de cinco dias úteis.",
      score: 0.94,
    },
    {
      title: "Garantia",
      content: "A garantia exige a apresentação da nota fiscal.",
      score: 0.8,
    },
  ];

  const ranked = rerankDocuments("garantia e nota fiscal", documents, 2);
  assert.equal(ranked[0].title, "Garantia");
  assert.ok(ranked[0].rerankScore > ranked[1].rerankScore);
  assert.equal(ranked[0].score, 0.8, "the original pgvector score remains observable");
});

test("reranker is stable on ties and honors the requested result limit", () => {
  const documents = [
    { title: "Primeiro", content: "Conteúdo neutro", score: 0.5 },
    { title: "Segundo", content: "Outro conteúdo", score: 0.5 },
    { title: "Terceiro", content: "Mais conteúdo", score: 0.5 },
  ];

  const first = rerankDocuments("consulta ausente", documents, 2);
  const second = rerankDocuments("consulta ausente", documents, 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((document) => document.title), ["Primeiro", "Segundo"]);
});

test("corpus version is tenant-aware and includes the embedding configuration", async () => {
  const statements: unknown[] = [];
  const prisma = {
    async $queryRaw(statement: unknown) {
      statements.push(statement);
      return [{ version: "17" }];
    },
  };

  const first = await readCorpusVersion(prisma as never, "tenant-a", {
    provider: "ollama",
    baseUrl: "http://embeddings.internal",
    model: "model-a",
  });
  const second = await readCorpusVersion(prisma as never, "tenant-a", {
    provider: "ollama",
    baseUrl: "http://embeddings.internal",
    model: "model-b",
  });

  assert.match(first ?? "", /^17:[a-f0-9]{16}$/);
  assert.match(second ?? "", /^17:[a-f0-9]{16}$/);
  assert.notEqual(first, second);
  assert.ok(sqlValues(statements[0]).includes("tenant-a"));
  assert.equal(sqlText(statements[0]).includes("tenant-a"), false, "tenant must remain a SQL parameter");
});

test("semantic cache enforces tenant, corpus version, TTL and records a hit", async () => {
  const queries: unknown[] = [];
  const updates: unknown[] = [];
  const prisma = {
    async $queryRaw(statement: unknown) {
      queries.push(statement);
      return [{
        id: "cache-1",
        payload: [{ title: "Garantia", content: "Cobertura de 90 dias.", score: 0.88 }],
        similarity: "0.99",
      }];
    },
    async $executeRaw(statement: unknown) {
      updates.push(statement);
      return 1;
    },
  };

  const result = await readSemanticRagCache(prisma as never, {
    tenantId: "tenant-a",
    corpusVersion: "8:embedding",
    query: "qual a garantia?",
    vector: unitVector(),
    limit: 5,
    minimumScore: 0.25,
  });

  assert.equal(result?.[0].title, "Garantia");
  const query = queries[0];
  assert.ok(sqlValues(query).includes("tenant-a"));
  assert.ok(sqlValues(query).includes("8:embedding"));
  assert.match(sqlText(query), /"expiresAt"\s*>\s*CURRENT_TIMESTAMP/);
  assert.match(sqlText(query), /ORDER BY embedding <=>/);
  assert.equal(sqlText(query).includes("tenant-a"), false);
  assert.equal(updates.length, 1);
  assert.ok(sqlValues(updates[0]).includes("cache-1"));
  assert.ok(sqlValues(updates[0]).includes("tenant-a"));
});

test("semantic cache write is an idempotent upsert with bounded expiry", async () => {
  let insert: unknown;
  const before = Date.now();
  const prisma = {
    async $executeRaw(statement: unknown) {
      insert = statement;
      return 1;
    },
  };

  const written = await writeSemanticRagCache(prisma as never, {
    tenantId: "tenant-a",
    corpusVersion: "3:embedding",
    query: "  garantia   ",
    vector: unitVector(),
    limit: 5,
    minimumScore: 0.25,
    documents: [{ title: "Garantia", content: "Noventa dias.", score: 0.9 }],
    ttlSeconds: 30,
  });

  assert.equal(written, true);
  assert.match(sqlText(insert), /ON CONFLICT \("tenantId", namespace, "corpusVersion", "queryHash"\)/);
  assert.ok(sqlValues(insert).includes("tenant-a"));
  assert.ok(sqlValues(insert).includes("3:embedding"));
  assert.equal(sqlValues(insert).includes("garantia"), false, "raw customer queries must not be persisted");
  const expiry = sqlValues(insert).find((value) => value instanceof Date) as Date | undefined;
  assert.ok(expiry);
  assert.ok(expiry.getTime() >= before + 29_000 && expiry.getTime() <= Date.now() + 31_000);
});

test("retrieve reuses a valid semantic cache entry and invalidates it by tenant", async () => {
  let cachedPayload: unknown;
  let vectorQueries = 0;
  let cacheHits = 0;
  const prisma = {
    async $queryRaw(statement: unknown) {
      const text = sqlText(statement);
      if (text.includes('FROM "RagCorpusState"')) return [{ version: "4" }];
      if (text.includes('FROM "SemanticCacheEntry"')) {
        if (!sqlValues(statement).includes("tenant-a") || !cachedPayload) return [];
        return [{ id: "cache-1", payload: cachedPayload, similarity: 1 }];
      }
      if (text.includes('FROM "KnowledgeDocument"')) {
        vectorQueries += 1;
        return [
          { title: "Garantia", content: "A garantia dura 90 dias.", score: "0.91" },
          { title: "Entrega", content: "Entregamos em todo o Brasil.", score: "0.4" },
        ];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    async $executeRaw(statement: unknown) {
      const text = sqlText(statement);
      if (text.includes('INSERT INTO "SemanticCacheEntry"')) {
        const serialized = sqlValues(statement).find(
          (value) => typeof value === "string" && value.startsWith("[{\"title\""),
        );
        cachedPayload = JSON.parse(String(serialized));
      } else if (text.includes('UPDATE "SemanticCacheEntry"')) {
        cacheHits += 1;
      }
      return 1;
    },
  };

  const firstTrace: { cacheHit?: boolean; corpusVersion?: string } = {};
  const secondTrace: { cacheHit?: boolean; corpusVersion?: string } = {};
  const first = await retrieve(prisma as never, "tenant-a", "qual a garantia?", 1, 0.25, {}, firstTrace);
  const second = await retrieve(prisma as never, "tenant-a", "qual a garantia?", 1, 0.25, {}, secondTrace);
  const otherTenant = await retrieve(prisma as never, "tenant-b", "qual a garantia?", 1, 0.25);

  assert.equal(first[0].title, "Garantia");
  assert.deepEqual(second, first);
  assert.equal(otherTenant[0].title, "Garantia");
  assert.equal(vectorQueries, 2, "tenant-a hits cache while tenant-b performs its own vector query");
  assert.equal(cacheHits, 1);
  assert.equal(firstTrace.cacheHit, false);
  assert.equal(secondTrace.cacheHit, true);
  assert.match(secondTrace.corpusVersion ?? "", /^4:/);
});

test("cache failures degrade to the authoritative pgvector query", async () => {
  let calls = 0;
  const prisma = {
    async $queryRaw(statement: unknown) {
      calls += 1;
      const text = sqlText(statement);
      if (text.includes('FROM "RagCorpusState"')) throw new Error("migration pending");
      return [{ title: "Produto", content: "Produto disponível.", score: 0.85 }];
    },
  };

  const documents = await retrieve(prisma as never, "tenant", "produto", 1, 0.25);
  assert.equal(documents[0].title, "Produto");
  assert.equal(calls, 2);
});
