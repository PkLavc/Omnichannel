import type { AiProvider, CompletionRequest, CompletionResult } from "../domain/provider.js";

type JsonObject = Record<string, unknown>;

export class OllamaProvider implements AiProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, model: string, timeoutMs = 60_000, name = "ollama") {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model.trim();
    this.name = name;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error("Timeout do Ollama inválido.");
    this.timeoutMs = timeoutMs;
    if (!this.model) throw new Error("Modelo Ollama não informado.");
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 8_000))
      });
      if (!response.ok) return false;

      const data = await response.json() as unknown;
      if (!isObject(data) || !Array.isArray(data.models)) return false;

      return data.models.some(entry => {
        if (!isObject(entry)) return false;
        const installed = typeof entry.name === "string"
          ? entry.name
          : typeof entry.model === "string" ? entry.model : "";
        return matchesModel(installed, this.model);
      });
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          stream: false,
          options: {
            temperature: request.temperature ?? 0.2,
            num_predict: request.maxTokens ?? 600
          }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "erro de rede";
      throw new Error(`Falha de conexão com Ollama: ${reason}`, { cause: error });
    }

    const body = await response.text();
    let data: unknown;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`Ollama HTTP ${response.status} retornou JSON inválido.`);
    }

    if (!response.ok) {
      const detail = isObject(data) && typeof data.error === "string" ? data.error : body.slice(0, 200);
      throw new Error(`Ollama HTTP ${response.status}: ${detail || response.statusText}`);
    }
    if (!isObject(data) || !isObject(data.message) || typeof data.message.content !== "string") {
      throw new Error("Ollama retornou um payload inválido.");
    }

    const text = data.message.content.trim();
    if (!text) throw new Error("Ollama retornou uma resposta vazia.");

    return {
      text,
      inputTokens: numberValue(data.prompt_eval_count),
      outputTokens: numberValue(data.eval_count)
    };
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL do Ollama inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL do Ollama deve usar HTTP ou HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function matchesModel(installed: string, requested: string): boolean {
  if (installed === requested) return true;
  if (!requested.includes(":")) return installed === `${requested}:latest` || installed.startsWith(`${requested}:`);
  return false;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
