import { createHash } from "node:crypto";

export const DIMENSIONS = 384;

const DEFAULT_MODEL = "all-minilm";
const DEFAULT_TIMEOUT_MS = 30_000;

export type EmbeddingOptions = {
  provider?: "local" | "ollama";
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

type OllamaEmbedResponse = {
  embeddings?: unknown;
};

export class EmbeddingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

function embeddingConfig(options: EmbeddingOptions) {
  const rawBaseUrl = options.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const model = options.model ?? process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? Number(process.env.EMBEDDING_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    throw new EmbeddingError("A URL do provider de embeddings deve usar HTTP ou HTTPS");
  }
  if (!model.trim()) throw new EmbeddingError("O modelo de embeddings não foi configurado");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EmbeddingError("O timeout do provider de embeddings é inválido");
  }

  return { baseUrl, model, timeoutMs };
}

function localEmbedding(text: string): number[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("pt-BR");
  const words = normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const features = [...words, ...words.slice(0, -1).map((word, index) => `${word}_${words[index + 1]}`)];
  const vector = Array<number>(DIMENSIONS).fill(0);
  for (const feature of features) {
    const hash = createHash("sha256").update(feature).digest();
    const index = hash.readUInt16BE(0) % DIMENSIONS;
    vector[index] += hash[2] % 2 === 0 ? 1 : -1;
  }
  const norm = Math.hypot(...vector);
  if (!norm) throw new EmbeddingError("O texto não possui termos indexáveis");
  return vector.map((component) => component / norm);
}

function normalizeVector(value: unknown, index: number): number[] {
  if (!Array.isArray(value) || value.length !== DIMENSIONS) {
    const received = Array.isArray(value) ? value.length : "valor não vetorial";
    throw new EmbeddingError(
      `O embedding ${index + 1} retornou dimensão ${received}; o banco requer ${DIMENSIONS}. ` +
        `Use um modelo compatível, como ${DEFAULT_MODEL}.`,
    );
  }

  const vector = value.map(Number);
  if (vector.some((component) => !Number.isFinite(component))) {
    throw new EmbeddingError(`O embedding ${index + 1} contém componentes inválidos`);
  }

  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingError(`O embedding ${index + 1} retornado pelo provider é nulo`);
  }

  return vector.map((component) => component / norm);
}

/**
 * Generates semantic embeddings through the local Ollama service.
 *
 * The database column is vector(384), therefore the configured model must
 * return exactly 384 dimensions. Errors are surfaced to the caller so an
 * import or retrieval can never silently degrade to unrelated lexical data.
 */
export async function embedMany(texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];

  const input = texts.map((text, index) => {
    const normalized = text.normalize("NFKC").trim();
    if (!normalized) throw new EmbeddingError(`O texto ${index + 1} para embedding está vazio`);
    return normalized;
  });

  const provider = options.provider ?? (options.fetch || options.baseUrl ? "ollama" : process.env.EMBEDDING_PROVIDER === "ollama" ? "ollama" : "local");
  if (provider === "local") return input.map(localEmbedding);

  const { baseUrl, model, timeoutMs } = embeddingConfig(options);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new EmbeddingError("A implementação HTTP para embeddings não está disponível");

  let response: Response;
  try {
    response = await fetchImplementation(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input, truncate: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new EmbeddingError(`Não foi possível conectar ao provider de embeddings em ${baseUrl}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new EmbeddingError(
      `Provider de embeddings respondeu HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  let payload: OllamaEmbedResponse;
  try {
    payload = (await response.json()) as OllamaEmbedResponse;
  } catch (error) {
    throw new EmbeddingError("Provider de embeddings retornou JSON inválido", { cause: error });
  }

  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== input.length) {
    throw new EmbeddingError(
      `Provider de embeddings retornou ${Array.isArray(payload.embeddings) ? payload.embeddings.length : 0} ` +
        `vetores para ${input.length} textos`,
    );
  }

  return payload.embeddings.map(normalizeVector);
}

export async function embed(text: string, options: EmbeddingOptions = {}) {
  return (await embedMany([text], options))[0];
}

export function vectorLiteral(vector: number[]) {
  if (vector.length !== DIMENSIONS || vector.some((component) => !Number.isFinite(component))) {
    throw new EmbeddingError(`Vetor inválido: eram esperadas ${DIMENSIONS} dimensões numéricas`);
  }
  return `[${vector.join(",")}]`;
}
