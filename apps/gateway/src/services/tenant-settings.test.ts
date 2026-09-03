import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialTenantSettings,
  embeddingOptionsFromSettings,
  mergeTenantSettings,
  safeTenantSettings,
} from "./tenant-settings.js";

test("partial tenant settings preserve nested configuration and hide secrets", () => {
  const merged = mergeTenantSettings({
    companyName: "Company A",
    prompts: { system: "system", support: "support" },
    embeddings: { provider: "local", model: "old" },
    chatwootApiToken: "encrypted",
  }, {
    prompts: { support: "updated" },
    embeddings: { provider: "ollama", baseUrl: "http://embeddings:11434", model: "all-minilm", timeoutMs: 1200 },
  });
  assert.deepEqual(merged.prompts, { system: "system", support: "updated" });
  assert.deepEqual(embeddingOptionsFromSettings(merged), {
    provider: "ollama",
    baseUrl: "http://embeddings:11434",
    model: "all-minilm",
    timeoutMs: 1200,
  });
  const safe = safeTenantSettings(merged);
  assert.equal("chatwootApiToken" in safe, false);
  assert.equal(safe.hasChatwootApiToken, true);
});

test("initial tenant settings create an empty isolated bot profile", () => {
  const settings = buildInitialTenantSettings({
      name: " Empresa Alpha ",
      botName: " Atendimento Alpha ",
    language: "pt-BR",
    primaryColor: "#15803d",
    deferIntegrations: true,
  }, new Date("2026-08-20T12:00:00.000Z"));

  assert.deepEqual(settings, {
      companyName: "Empresa Alpha",
      botName: "Atendimento Alpha",
    language: "pt-BR",
    primaryColor: "#15803d",
    businessRulesEnabled: false,
    prompts: { system: "", commercial: "", support: "", postSale: "" },
    setupDeferredAt: "2026-08-20T12:00:00.000Z",
  });
  assert.equal("chatwootUrl" in settings, false);
  assert.equal("chatwootInboxIds" in settings, false);
  assert.equal("businessRulesDocument" in settings, false);
});
