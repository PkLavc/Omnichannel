import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { continuousImprovementConstants } from "../services/continuous-improvement.js";
import {
  analyzeHistoricalConversations,
  type HistoricalAnalysisProgress,
} from "../services/historical-analysis.js";

export type ConversationAnalysisCliOptions = {
  tenant?: string;
  dryRun: boolean;
  includeEvaluated: boolean;
  batchSize?: number;
  concurrency?: number;
  candidateBatchSize?: number;
  maxConversations?: number;
  maxErrors?: number;
  progressEvery?: number;
  help: boolean;
};

export const conversationAnalysisHelp = `
Analisa conversas importadas sem carregar o histórico inteiro em memória.

Uso:
  npx tsx src/cli/analyze-conversations.ts \
    --tenant <slug-ou-id> [opções]

Opções:
  --tenant <valor>              Tenant obrigatório; nunca usa tenant padrão.
  --batch-size <1..1000>        Conversas lidas por página (padrão: 100).
  --concurrency <1..32>         Avaliações simultâneas (padrão: 4).
  --candidate-batch-size <n>    Avaliações por página na consolidação (padrão: 500).
  --max-conversations <n>       Limita conversas examinadas nesta execução.
  --max-errors <n>              Interrompe após exceder este total (padrão: 100).
  --progress-every <n>          Intervalo de progresso por conversas (padrão: 1000).
  --include-evaluated           Reavalia também a versão atual; desativado por padrão.
  --dry-run                     Seleciona e contabiliza sem gravar nada.
  --help                        Exibe esta ajuda.
`;

function integer(
  raw: string | undefined,
  option: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) throw new Error(`${option} requires a value`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseConversationAnalysisArgs(
  args: readonly string[],
): ConversationAnalysisCliOptions {
  const options: ConversationAnalysisCliOptions = {
    dryRun: false,
    includeEvaluated: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = () => args[++index];
    if (argument === "--tenant") options.tenant = next();
    else if (argument === "--batch-size") {
      options.batchSize = integer(next(), argument, 1, 1_000);
    } else if (argument === "--concurrency") {
      options.concurrency = integer(next(), argument, 1, 32);
    } else if (argument === "--candidate-batch-size") {
      options.candidateBatchSize = integer(next(), argument, 1, 2_000);
    } else if (argument === "--max-conversations") {
      options.maxConversations = integer(next(), argument, 1, Number.MAX_SAFE_INTEGER);
    } else if (argument === "--max-errors") {
      options.maxErrors = integer(next(), argument, 0, 100_000);
    } else if (argument === "--progress-every") {
      options.progressEvery = integer(next(), argument, 1, 1_000_000);
    } else if (argument === "--include-evaluated") options.includeEvaluated = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function progressLine(progress: HistoricalAnalysisProgress): string {
  if (progress.phase === "candidate-discovery") {
    return `[analysis:candidates] evaluations=${progress.candidateEvaluationScans}`
      + ` signals=${progress.candidateSignals} candidates=${progress.candidatesUpdated}`
      + ` cursor=${progress.cursor ?? "end"}\n`;
  }
  return `[analysis:evaluation] pages=${progress.pagesRead} scanned=${progress.scanned}`
    + ` eligible=${progress.eligible} evaluated=${progress.evaluated}`
    + ` wouldEvaluate=${progress.wouldEvaluate}`
    + ` skippedCurrent=${progress.skippedAlreadyEvaluated}`
    + ` skippedInsufficient=${progress.skippedInsufficientHistory}`
    + ` failed=${progress.failed} cursor=${progress.cursor ?? "start"}\n`;
}

async function main() {
  const options = parseConversationAnalysisArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(conversationAnalysisHelp);
    return;
  }
  if (!options.tenant?.trim()) throw new Error("--tenant is required");

  const prisma = new PrismaClient();
  try {
    const selector = options.tenant.trim();
    const tenant = await prisma.tenant.findFirst({
      where: {
        active: true,
        OR: [{ id: selector }, { slug: selector }],
      },
      select: { id: true, slug: true, name: true },
    });
    if (!tenant) throw new Error(`active tenant not found: ${selector}`);

    const stats = await analyzeHistoricalConversations(prisma, {
      tenantId: tenant.id,
      dryRun: options.dryRun,
      includeEvaluated: options.includeEvaluated,
      batchSize: options.batchSize,
      concurrency: options.concurrency,
      candidateBatchSize: options.candidateBatchSize,
      maxConversations: options.maxConversations,
      maxErrors: options.maxErrors,
      progressEvery: options.progressEvery,
      onProgress(progress) {
        process.stderr.write(progressLine(progress));
      },
    });
    process.stdout.write(`${JSON.stringify({
      tenant,
      evaluator: {
        name: continuousImprovementConstants.evaluator,
        version: continuousImprovementConstants.evaluatorVersion,
      },
      ...stats,
    }, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`[analysis] ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
