import type { AiProvider, CompletionRequest, CompletionResult } from "../domain/provider.js";
import type { ProviderType } from "../domain/types.js";

export type ProviderConfig = {
  type: ProviderType;
  name?: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string;
  timeoutMs?: number;
  healthPath?: string;
};

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1";
const DEFAULT_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";
const COMPLETION_TIMEOUT_MS = 45_000;
const HEALTH_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;

abstract class RemoteProvider implements AiProvider {
  readonly name: string;
  protected readonly model: string;
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly completionTimeoutMs: number;
  protected readonly healthTimeoutMs: number;

  constructor(config: ProviderConfig, defaultUrl?: string) {
    this.name = config.name?.trim() || config.type;
    this.model = required(config.model, "modelo");
    this.apiKey = required(config.apiKey, "API key");
    this.baseUrl = normalizedUrl(config.baseUrl || defaultUrl, `${config.type} base URL`);
    this.completionTimeoutMs = timeout(config.timeoutMs, COMPLETION_TIMEOUT_MS);
    this.healthTimeoutMs = Math.min(this.completionTimeoutMs, HEALTH_TIMEOUT_MS);
  }

  abstract health(): Promise<boolean>;
  abstract complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class OpenRouterProvider extends RemoteProvider {
  constructor(config: ProviderConfig) {
    super(config, DEFAULT_OPENROUTER_URL);
  }

  async health(): Promise<boolean> {
    try {
      const data = asObject(await requestJson(joinUrl(this.baseUrl, "key"), {
        headers: this.headers()
      }, this.healthTimeoutMs));
      assertNoApiError(data, "OpenRouter");
      return true;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const data = asObject(await requestJson(joinUrl(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 600
      })
    }, this.completionTimeoutMs));

    assertNoApiError(data, "OpenRouter");
    return openAiResult(data, "OpenRouter");
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      "X-OpenRouter-Title": "Omnichannel Platform"
    };
  }
}

export class CloudflareProvider extends RemoteProvider {
  constructor(config: ProviderConfig) {
    if (!config.baseUrl || /ACCOUNT_ID/i.test(config.baseUrl)) {
      throw new Error("Cloudflare requer a Base URL da conta, terminando em /accounts/<ACCOUNT_ID>/ai/v1.");
    }
    super(config);
  }

  async health(): Promise<boolean> {
    try {
      const data = asObject(await requestJson(cloudflareHealthUrl(this.baseUrl), {
        headers: this.headers()
      }, this.healthTimeoutMs));
      assertNoApiError(data, "Cloudflare");
      if (data.success === false) return false;
      return true;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const raw = asObject(await requestJson(joinUrl(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 600
      })
    }, this.completionTimeoutMs));

    assertNoApiError(raw, "Cloudflare");
    const data = isObject(raw.result) ? raw.result : raw;
    return openAiResult(data, "Cloudflare");
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`
    };
  }
}

export class GeminiProvider extends RemoteProvider {
  constructor(config: ProviderConfig) {
    super(config, DEFAULT_GEMINI_URL);
  }

  async health(): Promise<boolean> {
    try {
      const data = asObject(await requestJson(this.modelUrl(), {
        headers: this.headers()
      }, this.healthTimeoutMs));
      assertNoApiError(data, "Gemini");
      return true;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = request.messages
      .filter(message => message.role === "system")
      .map(message => message.content.trim())
      .filter(Boolean)
      .join("\n\n");
    const contents = geminiContents(request);
    const model = this.model.replace(/^models\//, "");
    const supportsSamplingParameters = !/^gemini-(?:3\.[5-9]|[4-9](?:\.|$))/i.test(model);

    if (contents.length === 0) {
      throw new Error("Gemini requer ao menos uma mensagem user ou assistant.");
    }

    const data = asObject(await requestJson(`${this.modelUrl()}:generateContent`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          ...(supportsSamplingParameters ? { temperature: request.temperature ?? 0.2 } : {}),
          maxOutputTokens: request.maxTokens ?? 600
        }
      })
    }, this.completionTimeoutMs));

    assertNoApiError(data, "Gemini");
    return geminiResult(data);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-goog-api-key": this.apiKey
    };
  }

  private modelUrl(): string {
    const model = this.model.replace(/^models\//, "");
    return joinUrl(this.baseUrl, `models/${encodeURIComponent(model)}`);
  }
}

export function providerFrom(config: ProviderConfig): AiProvider {
  switch (config.type) {
    case "cloudflare": return new CloudflareProvider(config);
    case "openrouter": return new OpenRouterProvider(config);
    case "gemini": return new GeminiProvider(config);
    case "openai-compatible": return new OpenAiCompatibleProvider(config);
    case "ollama": throw new Error("Use OllamaProvider para o provider ollama.");
  }
}

/** Generic adapter only for APIs that implement the OpenAI chat-completions contract. */
export class OpenAiCompatibleProvider extends RemoteProvider {
  private readonly healthPath: string;

  constructor(config: ProviderConfig) {
    super(config);
    required(config.name, "nome do provider");
    this.healthPath = normalizeRelativePath(config.healthPath ?? "models");
  }

  async health(): Promise<boolean> {
    try {
      const data = asObject(await requestJson(joinUrl(this.baseUrl, this.healthPath), {
        headers: this.headers(),
      }, this.healthTimeoutMs));
      assertNoApiError(data, this.name);
      return true;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const data = asObject(await requestJson(joinUrl(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 600,
      }),
    }, this.completionTimeoutMs));
    assertNoApiError(data, this.name);
    return openAiResult(data, this.name);
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }
}

function geminiContents(request: CompletionRequest): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const message of request.messages) {
    if (message.role === "system" || !message.content.trim()) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push({ text: message.content });
    else contents.push({ role, parts: [{ text: message.content }] });
  }

  return contents;
}

function geminiResult(data: JsonObject): CompletionResult {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const candidate = isObject(candidates[0]) ? candidates[0] : undefined;
  const content = candidate && isObject(candidate.content) ? candidate.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .filter(isObject)
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!text) {
    const feedback = isObject(data.promptFeedback) ? data.promptFeedback : undefined;
    const reason = stringValue(feedback?.blockReason)
      || stringValue(candidate?.finishReason)
      || (parts.some(part => isObject(part) && isObject(part.functionCall)) ? "function call sem resposta textual" : undefined)
      || "resposta vazia";
    throw new Error(`Gemini não retornou texto: ${reason}`);
  }

  const usage = isObject(data.usageMetadata) ? data.usageMetadata : undefined;
  return {
    text,
    inputTokens: numberValue(usage?.promptTokenCount),
    outputTokens: numberValue(usage?.candidatesTokenCount)
  };
}

function openAiResult(data: JsonObject, provider: string): CompletionResult {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = isObject(choices[0]) ? choices[0] : undefined;
  const message = first && isObject(first.message) ? first.message : undefined;
  const text = openAiText(message?.content).trim();

  if (!text) {
    const reason = stringValue(first?.finish_reason) || "resposta vazia";
    throw new Error(`${provider} não retornou texto: ${reason}`);
  }

  const usage = isObject(data.usage) ? data.usage : undefined;
  return {
    text,
    inputTokens: numberValue(usage?.prompt_tokens),
    outputTokens: numberValue(usage?.completion_tokens),
    estimatedCost: numberValue(usage?.cost)
  };
}

function openAiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("");
}

function assertNoApiError(data: JsonObject, provider: string): void {
  if (!data.error) return;
  const error = isObject(data.error) ? data.error : undefined;
  const message = stringValue(error?.message) || stringValue(data.error) || "erro retornado pela API";
  throw new Error(`${provider}: ${message}`);
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro de rede";
    throw new Error(`Falha de conexão com ${new URL(url).origin}: ${reason}`, { cause: error });
  }

  const body = await response.text();
  let parsed: unknown = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      if (response.ok) throw new Error(`HTTP ${response.status} retornou JSON inválido.`);
    }
  }

  if (!response.ok) {
    const apiMessage = isObject(parsed) && isObject(parsed.error)
      ? stringValue(parsed.error.message)
      : undefined;
    throw new Error(`HTTP ${response.status}: ${apiMessage || body.slice(0, 200) || response.statusText}`);
  }

  return parsed;
}

function cloudflareHealthUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  if (/\/accounts\/[^/]+\/ai\/v1$/i.test(normalizedPath)) {
    url.pathname = normalizedPath.replace(/\/v1$/i, "/models/search");
    url.search = "?per_page=1";
    return url.toString();
  }
  return joinUrl(baseUrl, "models");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function normalizedUrl(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} não informada.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} inválida.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} deve usar HTTP ou HTTPS.`);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeRelativePath(value: string) {
  const path = value.trim().replace(/^\/+/, "");
  if (!path || path.includes("..") || /^https?:/i.test(path)) throw new Error("Health path inválido.");
  return path;
}

function timeout(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) throw new Error("Timeout do provider inválido.");
  return value;
}

function required(value: string | null | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${label} não informada.`);
  return result;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("A API retornou um payload inválido.");
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
