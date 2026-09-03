import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, rename, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import {
  importConversationArchive,
  type ConversationImportReject,
} from "../services/conversation-import.js";

type CliOptions = {
  tenant?: string;
  file?: string;
  source?: string;
  dryRun: boolean;
  batchSize?: number;
  maxLineBytes?: number;
  maxMessageCharacters?: number;
  maxRejectedLines?: number;
  progressEvery?: number;
  checkpoint?: string;
  help: boolean;
};

const help = `
Importa um arquivo NDJSON/JSONL ou uma pasta de JSONs sem carregá-los em memória.

Uso:
  npm run conversations:import -w @omnichannel/gateway -- \\
    --tenant <slug-ou-id> --file <arquivo.jsonl[.gz]|pasta> [opções]

Opções:
  --tenant <valor>             Tenant obrigatório; nunca existe tenant padrão.
  --file <caminho>             Arquivo .jsonl/.ndjson[.gz] ou pasta de JSONs Hablla.
  --checkpoint <arquivo>       Salva e retoma o número do último registro processado.
  --source <nome>              Origem auditável (padrão: conversation_archive).
  --dry-run                    Valida e contabiliza, sem gravar dados.
  --batch-size <1..1000>       Conversas por transação (padrão: 100).
  --max-line-mb <n>            Limite descompactado por linha (padrão: 8 MB).
  --max-message-characters <n> Limite de cada mensagem (padrão: 100000).
  --max-rejected <n>           Interrompe depois deste total (padrão: 1000).
  --progress-every <n>         Intervalo de progresso em linhas (padrão: 1000).
  --help                       Exibe esta ajuda.
`;

function positiveInteger(raw: string | undefined, option: string, allowZero = false) {
  if (raw === undefined) throw new Error(`${option} requires a value`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

export function parseConversationImportArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { dryRun: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = () => args[++index];
    if (argument === "--tenant") options.tenant = next();
    else if (argument === "--file") options.file = next();
    else if (argument === "--source") options.source = next();
    else if (argument === "--checkpoint") options.checkpoint = next();
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--batch-size") options.batchSize = positiveInteger(next(), argument);
    else if (argument === "--max-line-mb") options.maxLineBytes = positiveInteger(next(), argument) * 1024 * 1024;
    else if (argument === "--max-message-characters") options.maxMessageCharacters = positiveInteger(next(), argument);
    else if (argument === "--max-rejected") options.maxRejectedLines = positiveInteger(next(), argument, true);
    else if (argument === "--progress-every") options.progressEvery = positiveInteger(next(), argument);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseConversationImportArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  if (!options.tenant?.trim()) throw new Error("--tenant is required");
  if (!options.file?.trim()) throw new Error("--file is required");

  const prisma = new PrismaClient();
  try {
    const tenantSelector = options.tenant.trim();
    const tenant = await prisma.tenant.findFirst({
      where: {
        OR: [{ id: tenantSelector }, { slug: tenantSelector }],
        active: true,
      },
      select: { id: true, slug: true, name: true },
    });
    if (!tenant) throw new Error(`active tenant not found: ${tenantSelector}`);

    const rejectedReasons = new Map<string, number>();
    const checkpointPath = options.checkpoint && !options.dryRun ? resolve(options.checkpoint) : undefined;
    let startAfterRecords = 0;
    if (checkpointPath) {
      try {
        const saved = JSON.parse(await readFile(checkpointPath, "utf8")) as { recordsProcessed?: unknown };
        if (Number.isSafeInteger(saved.recordsProcessed) && Number(saved.recordsProcessed) >= 0) {
          startAfterRecords = Number(saved.recordsProcessed);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const saveCheckpoint = async (recordsProcessed: number, complete = false) => {
      if (!checkpointPath) return;
      const temporary = `${checkpointPath}.tmp`;
      await writeFile(temporary, `${JSON.stringify({
        tenant: tenant.slug,
        recordsProcessed,
        complete,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      await rename(temporary, checkpointPath);
    };
    const onReject = (reject: ConversationImportReject) => {
      rejectedReasons.set(reject.reason, (rejectedReasons.get(reject.reason) ?? 0) + 1);
    };
    const stats = await importConversationArchive(prisma, {
      tenantId: tenant.id,
      file: resolve(options.file),
      source: options.source,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      maxLineBytes: options.maxLineBytes,
      maxMessageCharacters: options.maxMessageCharacters,
      maxRejectedLines: options.maxRejectedLines,
      progressEvery: options.progressEvery,
      startAfterRecords,
      onReject,
      async onProgress(progress) {
        await saveCheckpoint(progress.linesRead);
        process.stderr.write(
          `[import] records=${progress.linesRead} accepted=${progress.conversationsAccepted} skipped=${progress.conversationsSkipped} rejected=${progress.conversationsRejected} messages=${progress.messagesImported}/${progress.messagesAccepted} batches=${progress.batchesCompleted}\n`,
        );
      },
    });
    await saveCheckpoint(stats.linesRead, true);
    process.stdout.write(`${JSON.stringify({
      tenant,
      ...stats,
      rejectedReasons: Object.fromEntries([...rejectedReasons.entries()].sort(([left], [right]) => left.localeCompare(right))),
    }, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[import] ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
