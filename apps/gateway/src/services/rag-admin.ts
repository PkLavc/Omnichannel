import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { embedMany, vectorLiteral, type EmbeddingOptions } from "../core/embedding.js";

export type RagDocumentSummary = {
  source: string;
  externalId: string;
  title: string;
  chunks: number;
  embeddings: number;
  lastIndexedAt: Date;
  status: "ready" | "partial" | "pending";
};

type SummaryRow = Omit<RagDocumentSummary, "status">;

export async function listRagDocuments(prisma: PrismaClient, tenantId: string): Promise<RagDocumentSummary[]> {
  const rows = await prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
    SELECT
      "source",
      COALESCE(metadata->>'parentExternalId', "externalId") AS "externalId",
      MIN("title") AS "title",
      COUNT(*)::int AS "chunks",
      COUNT(embedding)::int AS "embeddings",
      MAX("updatedAt") AS "lastIndexedAt"
    FROM "KnowledgeDocument"
    WHERE "tenantId" = ${tenantId}
    GROUP BY "source", COALESCE(metadata->>'parentExternalId', "externalId")
    ORDER BY MAX("updatedAt") DESC
  `);
  return rows.map((row) => ({
    ...row,
    status: row.embeddings === 0 ? "pending" : row.embeddings === row.chunks ? "ready" : "partial",
  }));
}

export async function getRagDocument(prisma: PrismaClient, tenantId: string, source: string, externalId: string) {
  const chunks = await prisma.knowledgeDocument.findMany({
    where: {
      tenantId,
      source,
      OR: [
        { externalId },
        { externalId: { startsWith: `${externalId}::chunk:` } },
        { metadata: { path: ["parentExternalId"], equals: externalId } },
      ],
    },
    orderBy: { externalId: "asc" },
    select: { id: true, externalId: true, title: true, content: true, metadata: true, updatedAt: true },
  });
  return chunks.length ? { source, externalId, title: chunks[0].title, chunks } : null;
}

export async function updateRagDocument(
  prisma: PrismaClient,
  tenantId: string,
  source: string,
  externalId: string,
  contents: Array<{ id: string; content: string }>,
  embeddingOptions: EmbeddingOptions = {},
) {
  const current = await getRagDocument(prisma, tenantId, source, externalId);
  if (!current) return 0;
  const allowed = new Set(current.chunks.map((chunk) => chunk.id));
  if (contents.some((chunk) => !allowed.has(chunk.id))) throw new Error("invalid_chunk");
  const vectors = await embedMany(contents.map((chunk) => chunk.content), embeddingOptions);
  const checksums = contents.map((chunk) => createHash("sha256").update(chunk.content).digest("hex"));
  await prisma.$transaction(contents.map((chunk, index) => prisma.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeDocument"
    SET "content" = ${chunk.content},
        "checksum" = ${checksums[index]},
        embedding = ${vectorLiteral(vectors[index])}::vector,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${chunk.id} AND "tenantId" = ${tenantId}
  `)));
  return contents.length;
}

export async function deleteRagDocument(prisma: PrismaClient, tenantId: string, source: string, externalId: string) {
  return prisma.knowledgeDocument.deleteMany({
    where: {
      tenantId,
      source,
      OR: [
        { externalId },
        { externalId: { startsWith: `${externalId}::chunk:` } },
        { metadata: { path: ["parentExternalId"], equals: externalId } },
      ],
    },
  });
}

export async function reindexRagDocuments(
  prisma: PrismaClient,
  tenantId: string,
  filter: { source?: string; externalId?: string } = {},
  embeddingOptions: EmbeddingOptions = {},
) {
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      tenantId,
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.externalId ? {
        OR: [
          { externalId: filter.externalId },
          { externalId: { startsWith: `${filter.externalId}::chunk:` } },
          { metadata: { path: ["parentExternalId"], equals: filter.externalId } },
        ],
      } : {}),
    },
    orderBy: { id: "asc" },
    select: { id: true, content: true },
  });
  if (!documents.length) return 0;
  const vectors = await embedMany(documents.map((document) => document.content), embeddingOptions);
  await prisma.$transaction(documents.map((document, index) => prisma.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeDocument"
    SET embedding = ${vectorLiteral(vectors[index])}::vector, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${document.id} AND "tenantId" = ${tenantId}
  `)));
  return documents.length;
}
