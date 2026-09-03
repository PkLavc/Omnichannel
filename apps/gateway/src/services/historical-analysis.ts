import {
  AutomaticEvaluationStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  ContinuousImprovementService,
  continuousImprovementConstants,
} from "./continuous-improvement.js";
import { LearningCandidateService } from "./learning-candidates.js";

type EvaluationRunner = Pick<ContinuousImprovementService, "runAutomaticEvaluation">;
type CandidateDiscoverer = Pick<LearningCandidateService, "discoverFromEvaluations">;

type ConversationPageRow = {
  id: string;
  externalId: string;
  hasSufficientHistory: boolean;
  alreadyEvaluated: boolean;
};

export type HistoricalAnalysisProgress = {
  phase: "evaluation" | "candidate-discovery";
  pagesRead: number;
  scanned: number;
  eligible: number;
  evaluated: number;
  wouldEvaluate: number;
  skippedAlreadyEvaluated: number;
  skippedInsufficientHistory: number;
  failed: number;
  candidateEvaluationScans: number;
  candidateSignals: number;
  candidatesUpdated: number;
  cursor: string | null;
};

export type HistoricalAnalysisStats = HistoricalAnalysisProgress & {
  tenantId: string;
  dryRun: boolean;
  includeEvaluated: boolean;
  abortedAfterErrorLimit: boolean;
  errors: { conversationId: string; externalId: string; message: string }[];
};

export type HistoricalAnalysisOptions = {
  tenantId: string;
  dryRun?: boolean;
  includeEvaluated?: boolean;
  batchSize?: number;
  concurrency?: number;
  candidateBatchSize?: number;
  maxConversations?: number;
  maxErrors?: number;
  progressEvery?: number;
  onProgress?: (progress: HistoricalAnalysisProgress) => void | Promise<void>;
};

export type HistoricalAnalysisDependencies = {
  evaluationRunner?: EvaluationRunner;
  candidateDiscoverer?: CandidateDiscoverer;
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
) {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= values.length) return;
        await worker(values[current]!);
      }
    },
  );
  await Promise.all(runners);
}

async function loadConversationPage(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    cursor: string | null;
    limit: number;
  },
): Promise<ConversationPageRow[]> {
  return prisma.$queryRaw<ConversationPageRow[]>(Prisma.sql`
    SELECT
      conversation."id",
      conversation."externalId",
      EXISTS (
        SELECT 1
        FROM "ConversationMessage" customer_message
        WHERE customer_message."conversationId" = conversation."id"
          AND customer_message."role" = 'user'
          AND length(btrim(customer_message."content")) > 0
          AND EXISTS (
            SELECT 1
            FROM "ConversationMessage" assistant_message
            WHERE assistant_message."conversationId" = conversation."id"
              AND assistant_message."role" = 'assistant'
              AND length(btrim(assistant_message."content")) > 0
              AND assistant_message."createdAt" >= customer_message."createdAt"
          )
      ) AS "hasSufficientHistory",
      EXISTS (
        SELECT 1
        FROM "AutomaticEvaluation" evaluation
        WHERE evaluation."tenantId" = ${input.tenantId}
          AND evaluation."conversationId" = conversation."id"
          AND evaluation."evaluator" = ${continuousImprovementConstants.evaluator}
          AND evaluation."evaluatorVersion" = ${continuousImprovementConstants.evaluatorVersion}
          AND evaluation."status" IN (
            ${AutomaticEvaluationStatus.PENDING}::"AutomaticEvaluationStatus",
            ${AutomaticEvaluationStatus.COMPLETED}::"AutomaticEvaluationStatus"
          )
      ) AS "alreadyEvaluated"
    FROM "Conversation" conversation
    WHERE conversation."tenantId" = ${input.tenantId}
      AND (${input.cursor}::text IS NULL OR conversation."id" > ${input.cursor})
    ORDER BY conversation."id" ASC
    LIMIT ${input.limit}
  `);
}

function progressOf(stats: HistoricalAnalysisStats): HistoricalAnalysisProgress {
  return {
    phase: stats.phase,
    pagesRead: stats.pagesRead,
    scanned: stats.scanned,
    eligible: stats.eligible,
    evaluated: stats.evaluated,
    wouldEvaluate: stats.wouldEvaluate,
    skippedAlreadyEvaluated: stats.skippedAlreadyEvaluated,
    skippedInsufficientHistory: stats.skippedInsufficientHistory,
    failed: stats.failed,
    candidateEvaluationScans: stats.candidateEvaluationScans,
    candidateSignals: stats.candidateSignals,
    candidatesUpdated: stats.candidatesUpdated,
    cursor: stats.cursor,
  };
}

/**
 * Evaluates a large tenant archive with bounded memory. Pagination is based on
 * the immutable conversation id and discovery is separately cursor-paginated.
 */
export async function analyzeHistoricalConversations(
  prisma: PrismaClient,
  options: HistoricalAnalysisOptions,
  dependencies: HistoricalAnalysisDependencies = {},
): Promise<HistoricalAnalysisStats> {
  const tenantId = options.tenantId.trim();
  if (!tenantId) throw new Error("tenantId is required");
  const batchSize = boundedInteger(options.batchSize, 100, 1, 1_000, "batchSize");
  const concurrency = boundedInteger(options.concurrency, 4, 1, 32, "concurrency");
  const candidateBatchSize = boundedInteger(
    options.candidateBatchSize,
    500,
    1,
    2_000,
    "candidateBatchSize",
  );
  const progressEvery = boundedInteger(options.progressEvery, 1_000, 1, 1_000_000, "progressEvery");
  const maxErrors = boundedInteger(options.maxErrors, 100, 0, 100_000, "maxErrors");
  const maxConversations = options.maxConversations === undefined
    ? Number.MAX_SAFE_INTEGER
    : boundedInteger(options.maxConversations, 1, 1, Number.MAX_SAFE_INTEGER, "maxConversations");
  const dryRun = options.dryRun === true;
  const includeEvaluated = options.includeEvaluated === true;
  const evaluationRunner = dependencies.evaluationRunner ?? new ContinuousImprovementService(prisma);
  const candidateDiscoverer = dependencies.candidateDiscoverer ?? new LearningCandidateService(prisma);
  const stats: HistoricalAnalysisStats = {
    tenantId,
    dryRun,
    includeEvaluated,
    phase: "evaluation",
    pagesRead: 0,
    scanned: 0,
    eligible: 0,
    evaluated: 0,
    wouldEvaluate: 0,
    skippedAlreadyEvaluated: 0,
    skippedInsufficientHistory: 0,
    failed: 0,
    candidateEvaluationScans: 0,
    candidateSignals: 0,
    candidatesUpdated: 0,
    cursor: null,
    abortedAfterErrorLimit: false,
    errors: [],
  };
  let nextProgressAt = progressEvery;

  const reportEvaluationProgress = async (force = false) => {
    if (!options.onProgress) return;
    if (!force && stats.scanned < nextProgressAt) return;
    while (stats.scanned >= nextProgressAt) nextProgressAt += progressEvery;
    await options.onProgress(progressOf(stats));
  };

  while (stats.scanned < maxConversations && !stats.abortedAfterErrorLimit) {
    const remaining = maxConversations - stats.scanned;
    const page = await loadConversationPage(prisma, {
      tenantId,
      cursor: stats.cursor,
      limit: Math.min(batchSize, remaining),
    });
    if (!page.length) break;
    stats.pagesRead += 1;
    stats.scanned += page.length;
    stats.cursor = page.at(-1)!.id;

    const eligible = page.filter(conversation => {
      if (!conversation.hasSufficientHistory) {
        stats.skippedInsufficientHistory += 1;
        return false;
      }
      if (conversation.alreadyEvaluated && !includeEvaluated) {
        stats.skippedAlreadyEvaluated += 1;
        return false;
      }
      stats.eligible += 1;
      return true;
    });

    if (dryRun) {
      stats.wouldEvaluate += eligible.length;
    } else {
      await mapConcurrent(eligible, concurrency, async conversation => {
        if (stats.abortedAfterErrorLimit) return;
        try {
          await evaluationRunner.runAutomaticEvaluation({
            tenantId,
            conversationId: conversation.id,
          });
          stats.evaluated += 1;
        } catch (error) {
          stats.failed += 1;
          if (stats.errors.length < 20) {
            stats.errors.push({
              conversationId: conversation.id,
              externalId: conversation.externalId,
              message: error instanceof Error ? error.message.slice(0, 1_000) : "unknown error",
            });
          }
          if (stats.failed > maxErrors) stats.abortedAfterErrorLimit = true;
        }
      });
    }
    await reportEvaluationProgress();
    if (page.length < Math.min(batchSize, remaining)) break;
  }
  await reportEvaluationProgress(true);

  // A dry-run is strictly read-only. It reports how many evaluations would be
  // made and deliberately does not materialize candidate evidence.
  if (dryRun) return stats;

  stats.phase = "candidate-discovery";
  let discoveryCursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const result = await candidateDiscoverer.discoverFromEvaluations({
      tenantId,
      cursor: discoveryCursor,
      limit: candidateBatchSize,
      evaluator: continuousImprovementConstants.evaluator,
      evaluatorVersion: continuousImprovementConstants.evaluatorVersion,
      maxCandidates: 32,
    });
    stats.candidateEvaluationScans += result.scannedEvaluations;
    stats.candidateSignals += result.derivedSignals;
    stats.candidatesUpdated += result.updatedCandidates.length;
    stats.cursor = result.nextCursor;
    if (options.onProgress) await options.onProgress(progressOf(stats));
    if (!result.hasMore) break;
    if (!result.nextCursor || seenCursors.has(result.nextCursor)) {
      throw new Error("candidate discovery returned a repeated or empty cursor");
    }
    seenCursors.add(result.nextCursor);
    discoveryCursor = result.nextCursor;
  }
  return stats;
}
