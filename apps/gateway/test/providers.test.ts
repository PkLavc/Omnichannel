import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProviderRouter, withCompletionDefaults, type AiProvider } from "../dist/domain/provider.js";
import { providerFrom } from "../dist/infrastructure/providers.js";
import { OllamaProvider } from "../dist/infrastructure/ollama-provider.js";

test("ProviderRouter usa fallback real e informa todas as tentativas", async () => {
  const calls: string[] = [];
  const provider = (name: string, healthy: boolean, result?: string | Error): AiProvider => ({
    name,
    async health() {
      calls.push(`${name}:health`);
      return healthy;
    },
    async complete() {
      calls.push(`${name}:complete`);
      if (result instanceof Error) throw result;
      return { text: result ?? "" };
    }
  });

  const result = await new ProviderRouter([
    provider("cloudflare", false),
    provider("openrouter", true, new Error("credencial inválida")),
    provider("gemini", true, "resposta")
  ]).complete({ messages: [{ role: "user", content: "Olá" }] });

  assert.deepEqual(calls, [
    "cloudflare:health",
    "openrouter:health",
    "openrouter:complete",
    "gemini:health",
    "gemini:complete"
  ]);
  assert.equal(result.text, "resposta");
  assert.equal(result.provider, "gemini");
  assert.equal(result.fallback, true);
  assert.deepEqual(result.attemptedProviders, ["cloudflare", "openrouter", "gemini"]);
  assert.deepEqual(result.failures, [
    { provider: "cloudflare", error: "health check falhou" },
    { provider: "openrouter", error: "credencial inválida" },
  ]);
});

test("ProviderRouter rejeita resposta vazia e consolida falhas", async () => {
  const empty: AiProvider = {
    name: "empty",
    async health() { return true; },
    async complete() { return { text: "  " }; }
  };
  const offline: AiProvider = {
    name: "offline",
    async health() { return false; },
    async complete() { throw new Error("não deveria chamar"); }
  };

  await assert.rejects(
    new ProviderRouter([empty, offline]).complete({ messages: [{ role: "user", content: "teste" }] }),
    /empty: resposta vazia; offline: health check falhou/
  );
});

test("cada provider recebe suas próprias opções de geração durante o fallback", async () => {
  const requests: Array<{ provider: string; temperature?: number; maxTokens?: number }> = [];
  const provider = (name: string, text: string): AiProvider => ({
    name,
    async health() { return true; },
    async complete(request) {
      requests.push({ provider: name, temperature: request.temperature, maxTokens: request.maxTokens });
      if (!text) throw new Error("falha esperada");
      return { text };
    },
  });
  const result = await new ProviderRouter([
    withCompletionDefaults(provider("primeiro", ""), { temperature: 0.1, maxTokens: 100 }),
    withCompletionDefaults(provider("segundo", "ok"), { temperature: 0.8, maxTokens: 900 }),
  ]).complete({ messages: [{ role: "user", content: "teste" }] });

  assert.equal(result.provider, "segundo");
  assert.deepEqual(requests, [
    { provider: "primeiro", temperature: 0.1, maxTokens: 100 },
    { provider: "segundo", temperature: 0.8, maxTokens: 900 },
  ]);
});

test("OpenRouter usa health sem geração e envia headers de identificação", async () => {
  const requests: Array<{ method?: string; url?: string; headers: IncomingMessage["headers"]; body?: unknown }> = [];

  await withServer(async (request, response) => {
    const body = request.method === "POST" ? await readJson(request) : undefined;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url === "/api/v1/key") return sendJson(response, 200, { data: { label: "test" } });
    if (request.url === "/api/v1/chat/completions") {
      return sendJson(response, 200, {
        choices: [{ message: { content: "Resposta OpenRouter" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.001 }
      });
    }
    sendJson(response, 404, { error: { message: "not found" } });
  }, async baseUrl => {
    const provider = providerFrom({
      type: "openrouter",
      model: "test/model",
      apiKey: "secret",
      baseUrl: `${baseUrl}/api/v1`
    });

    assert.equal(await provider.health(), true);
    const result = await provider.complete({
      messages: [{ role: "user", content: "Olá" }],
      temperature: 0.4,
      maxTokens: 77
    });

    assert.deepEqual(result, {
      text: "Resposta OpenRouter",
      inputTokens: 12,
      outputTokens: 5,
      estimatedCost: 0.001
    });
  });

  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.authorization, "Bearer secret");
  assert.equal(requests[1]?.headers["x-openrouter-title"], "Omnichannel Platform");
  assert.deepEqual(requests[1]?.body, {
    model: "test/model",
    messages: [{ role: "user", content: "Olá" }],
    temperature: 0.4,
    max_tokens: 77
  });
});

test("Cloudflare valida a conta sem completion e aceita o envelope Workers AI", async () => {
  const paths: string[] = [];

  await withServer(async (request, response) => {
    paths.push(`${request.method} ${request.url}`);
    if (request.url === "/client/v4/accounts/account-123/ai/models/search?per_page=1") {
      return sendJson(response, 200, { success: true, result: [] });
    }
    if (request.url === "/client/v4/accounts/account-123/ai/v1/chat/completions") {
      return sendJson(response, 200, {
        success: true,
        result: {
          choices: [{ message: { content: "Resposta Cloudflare" } }],
          usage: { prompt_tokens: 9, completion_tokens: 3 }
        }
      });
    }
    sendJson(response, 404, { success: false });
  }, async baseUrl => {
    const provider = providerFrom({
      type: "cloudflare",
      model: "@cf/meta/test",
      apiKey: "token",
      baseUrl: `${baseUrl}/client/v4/accounts/account-123/ai/v1`
    });

    assert.equal(await provider.health(), true);
    assert.deepEqual(await provider.complete({ messages: [{ role: "user", content: "Olá" }] }), {
      text: "Resposta Cloudflare",
      inputTokens: 9,
      outputTokens: 3,
      estimatedCost: undefined
    });
  });

  assert.deepEqual(paths, [
    "GET /client/v4/accounts/account-123/ai/models/search?per_page=1",
    "POST /client/v4/accounts/account-123/ai/v1/chat/completions"
  ]);
  assert.throws(
    () => providerFrom({ type: "cloudflare", model: "m", apiKey: "k" }),
    /Base URL da conta/
  );
});

test("Gemini valida modelo sem geração e trata system instruction, uso e bloqueio", async () => {
  let completionBody: any;

  await withServer(async (request, response) => {
    if (request.url === "/v1beta/models/gemini-test" && request.method === "GET") {
      assert.equal(request.headers["x-goog-api-key"], "gemini-key");
      return sendJson(response, 200, { name: "models/gemini-test" });
    }
    if (request.url === "/v1beta/models/gemini-test:generateContent") {
      completionBody = await readJson(request);
      return sendJson(response, 200, {
        candidates: [{ content: { parts: [{ text: "Resposta " }, { text: "Gemini" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 4 }
      });
    }
    sendJson(response, 404, { error: { message: "not found" } });
  }, async baseUrl => {
    const provider = providerFrom({
      type: "gemini",
      model: "models/gemini-test",
      apiKey: "gemini-key",
      baseUrl: `${baseUrl}/v1beta`
    });

    assert.equal(await provider.health(), true);
    assert.deepEqual(await provider.complete({ messages: [
      { role: "system", content: "Regra 1" },
      { role: "system", content: "Regra 2" },
      { role: "user", content: "Parte 1" },
      { role: "user", content: "Parte 2" },
      { role: "assistant", content: "Anterior" }
    ] }), {
      text: "Resposta Gemini",
      inputTokens: 14,
      outputTokens: 4
    });
  });

  assert.deepEqual(completionBody.systemInstruction, { parts: [{ text: "Regra 1\n\nRegra 2" }] });
  assert.deepEqual(completionBody.contents, [
    { role: "user", parts: [{ text: "Parte 1" }, { text: "Parte 2" }] },
    { role: "model", parts: [{ text: "Anterior" }] }
  ]);
});

test("Gemini 3.5 omite parâmetros de sampling descontinuados", async () => {
  let completionBody: any;
  await withServer(async (request, response) => {
    if (request.url === "/v1beta/models/gemini-3.5-flash-lite:generateContent") {
      completionBody = await readJson(request);
      return sendJson(response, 200, {
        candidates: [{ content: { parts: [{ text: "Resposta atual" }] }, finishReason: "STOP" }],
      });
    }
    sendJson(response, 404, { error: { message: "not found" } });
  }, async baseUrl => {
    const provider = providerFrom({
      type: "gemini",
      model: "gemini-3.5-flash-lite",
      apiKey: "gemini-key",
      baseUrl: `${baseUrl}/v1beta`,
    });
    assert.equal((await provider.complete({
      messages: [{ role: "user", content: "Olá" }],
      temperature: 0.8,
      maxTokens: 321,
    })).text, "Resposta atual");
  });

  assert.deepEqual(completionBody.generationConfig, { maxOutputTokens: 321 });
});

test("Ollama health exige o modelo e completion envia opções e contabiliza tokens", async () => {
  let installed = false;
  let completionBody: any;

  await withServer(async (request, response) => {
    if (request.url === "/api/tags") {
      return sendJson(response, 200, { models: installed ? [{ name: "llama3.2:3b" }] : [] });
    }
    if (request.url === "/api/chat") {
      completionBody = await readJson(request);
      return sendJson(response, 200, {
        message: { role: "assistant", content: "Resposta Ollama" },
        prompt_eval_count: 20,
        eval_count: 6
      });
    }
    sendJson(response, 404, { error: "not found" });
  }, async baseUrl => {
    const provider = new OllamaProvider(`${baseUrl}/`, "llama3.2:3b");
    assert.equal(await provider.health(), false);
    installed = true;
    assert.equal(await provider.health(), true);
    assert.deepEqual(await provider.complete({
      messages: [{ role: "user", content: "Olá" }],
      temperature: 0.3,
      maxTokens: 88
    }), {
      text: "Resposta Ollama",
      inputTokens: 20,
      outputTokens: 6
    });
  });

  assert.deepEqual(completionBody, {
    model: "llama3.2:3b",
    messages: [{ role: "user", content: "Olá" }],
    stream: false,
    options: { temperature: 0.3, num_predict: 88 }
  });
});

test("provider OpenAI-compatible usa nome, health path e timeout configuráveis", async () => {
  const paths: string[] = [];
  await withServer(async (request, response) => {
    paths.push(`${request.method} ${request.url}`);
    if (request.url === "/v1/ready") return sendJson(response, 200, { ok: true });
    if (request.url === "/v1/chat/completions") return sendJson(response, 200, {
      choices: [{ message: { content: "Resposta compatível" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    return sendJson(response, 404, {});
  }, async baseUrl => {
    const provider = providerFrom({
      type: "openai-compatible",
      name: "Provider interno",
      model: "modelo-1",
      apiKey: "token",
      baseUrl: `${baseUrl}/v1`,
      healthPath: "ready",
      timeoutMs: 2_000,
    });
    assert.equal(provider.name, "Provider interno");
    assert.equal(await provider.health(), true);
    assert.equal((await provider.complete({ messages: [{ role: "user", content: "teste" }] })).text, "Resposta compatível");
  });
  assert.deepEqual(paths, ["GET /v1/ready", "POST /v1/chat/completions"]);
  assert.throws(
    () => providerFrom({ type: "openai-compatible", name: "x", model: "m", apiKey: "k", baseUrl: "http://localhost", timeoutMs: 10 }),
    /Timeout/,
  );
});

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response).catch(error => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "test error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
