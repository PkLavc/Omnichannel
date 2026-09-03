import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { parseConversationAnalysisArgs } from "../cli/analyze-conversations.js";
import { analyzeHistoricalConversations } from "./historical-analysis.js";

type PageRow = {
  id: string;
  externalId: string;
  hasSufficientHistory: boolean;
  alreadyEvaluated: boolean;
};

function fakePrismaWithPages(pages: PageRow[][], observedSql?: string[]) {
  let page = 0;
  return {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      observedSql?.push(query.strings?.join("?") ?? "");
      const result = pages[page] ?? [];
      page += 1;
      return result;
    },
  } as unknown as PrismaClient;
}

test("CLI exige limites explícitos e mantém reavaliação desativada por padrão", () => {
  assert.deepEqual(parseConversationAnalysisArgs([
    "--tenant", "loja-a",
    "--batch-size", "250",
    "--concurrency", "6",
    "--candidate-batch-size", "750",
    "--max-conversations", "10000",
    "--max-errors", "0",
    "--progress-every", "500",
    "--dry-run",
  ]), {
    tenant: "loja-a",
    batchSize: 250,
    concurrency: 6,
    candidateBatchSize: 750,
    maxConversations: 10_000,
    maxErrors: 0,
    progressEvery: 500,
    dryRun: true,
    includeEvaluated: false,
    help: false,
  });
  assert.throws(
    () => parseConversationAnalysisArgs(["--concurrency", "33"]),
    /between 1 and 32/u,
  );
  assert.equal(
    parseConversationAnalysisArgs(["--include-evaluated"]).includeEvaluated,
    true,
  );
});

test("dry-run pagina e contabiliza sem avaliar nem descobrir candidatos", async () => {
  const observedSql: string[] = [];
  const prisma = fakePrismaWithPages([[
    { id: "a", externalId: "external-a", hasSufficientHistory: true, alreadyEvaluated: false },
    { id: "b", externalId: "external-b", hasSufficientHistory: true, alreadyEvaluated: true },
    { id: "c", externalId: "external-c", hasSufficientHistory: false, alreadyEvaluated: false },
  ], []], observedSql);
  let evaluationCalls = 0;
  let discoveryCalls = 0;
  const stats = await analyzeHistoricalConversations(prisma, {
    tenantId: "tenant-a",
    dryRun: true,
    batchSize: 3,
    progressEvery: 1,
  }, {
    evaluationRunner: {
      async runAutomaticEvaluation() {
        evaluationCalls += 1;
        return {} as never;
      },
    },
    candidateDiscoverer: {
      async discoverFromEvaluations() {
        discoveryCalls += 1;
        return {} as never;
      },
    },
  });
  assert.equal(stats.scanned, 3);
  assert.equal(stats.eligible, 1);
  assert.equal(stats.wouldEvaluate, 1);
  assert.equal(stats.skippedAlreadyEvaluated, 1);
  assert.equal(stats.skippedInsufficientHistory, 1);
  assert.equal(stats.evaluated, 0);
  assert.equal(evaluationCalls, 0);
  assert.equal(discoveryCalls, 0);
  assert.match(observedSql[0] ?? "", /AutomaticEvaluation/u);
  assert.match(observedSql[0] ?? "", /hasSufficientHistory/u);
});

test("avalia com concorrência limitada e consolida candidatos por cursor", async () => {
  const rows: PageRow[] = [
    { id: "a", externalId: "external-a", hasSufficientHistory: true, alreadyEvaluated: false },
    { id: "b", externalId: "external-b", hasSufficientHistory: true, alreadyEvaluated: false },
    { id: "c", externalId: "external-c", hasSufficientHistory: true, alreadyEvaluated: false },
    { id: "d", externalId: "external-d", hasSufficientHistory: true, alreadyEvaluated: true },
  ];
  const prisma = fakePrismaWithPages([rows, []]);
  let active = 0;
  let maximumActive = 0;
  const evaluated: string[] = [];
  const discoveryCursors: (string | undefined)[] = [];
  const stats = await analyzeHistoricalConversations(prisma, {
    tenantId: "tenant-a",
    batchSize: 4,
    concurrency: 2,
    candidateBatchSize: 25,
  }, {
    evaluationRunner: {
      async runAutomaticEvaluation(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        evaluated.push(input.conversationId);
        active -= 1;
        return {} as never;
      },
    },
    candidateDiscoverer: {
      async discoverFromEvaluations(input) {
        discoveryCursors.push(input.cursor);
        if (!input.cursor) {
          return {
            scannedEvaluations: 25,
            distinctConversations: 25,
            derivedSignals: 60,
            updatedCandidates: [{ id: "candidate-a" }],
            nextCursor: "evaluation-25",
            hasMore: true,
          } as never;
        }
        return {
          scannedEvaluations: 10,
          distinctConversations: 10,
          derivedSignals: 20,
          updatedCandidates: [{ id: "candidate-a" }, { id: "candidate-b" }],
          nextCursor: null,
          hasMore: false,
        } as never;
      },
    },
  });
  assert.deepEqual(evaluated.sort(), ["a", "b", "c"]);
  assert.equal(maximumActive, 2);
  assert.equal(stats.evaluated, 3);
  assert.equal(stats.skippedAlreadyEvaluated, 1);
  assert.deepEqual(discoveryCursors, [undefined, "evaluation-25"]);
  assert.equal(stats.candidateEvaluationScans, 35);
  assert.equal(stats.candidateSignals, 80);
  assert.equal(stats.candidatesUpdated, 3);
});

test("include-evaluated permite reavaliar explicitamente a versão atual", async () => {
  const prisma = fakePrismaWithPages([[
    { id: "a", externalId: "external-a", hasSufficientHistory: true, alreadyEvaluated: true },
  ]]);
  let evaluated = 0;
  const stats = await analyzeHistoricalConversations(prisma, {
    tenantId: "tenant-a",
    includeEvaluated: true,
    batchSize: 2,
  }, {
    evaluationRunner: {
      async runAutomaticEvaluation() {
        evaluated += 1;
        return {} as never;
      },
    },
    candidateDiscoverer: {
      async discoverFromEvaluations() {
        return {
          scannedEvaluations: 0,
          distinctConversations: 0,
          derivedSignals: 0,
          updatedCandidates: [],
          nextCursor: null,
          hasMore: false,
        } as never;
      },
    },
  });
  assert.equal(evaluated, 1);
  assert.equal(stats.skippedAlreadyEvaluated, 0);
});
