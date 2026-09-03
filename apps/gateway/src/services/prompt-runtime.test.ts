import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPromptBundle,
  parsePromptBundle,
  serializePromptBundle,
} from "./prompt-runtime.js";

test("prompt bundle keeps all conversational prompt roles in one version", () => {
  const serialized = serializePromptBundle({
    system: "Regra principal",
    commercial: "Regra comercial",
    support: "Regra de suporte",
    postSale: "Regra pós-venda",
  });
  assert.deepEqual(parsePromptBundle(serialized), {
    system: "Regra principal",
    commercial: "Regra comercial",
    support: "Regra de suporte",
    postSale: "Regra pós-venda",
  });
});

test("plain prompt remains a backwards-compatible system-only version", () => {
  const base = { system: "antigo", commercial: "c", support: "s", postSale: "p", extra: true };
  assert.deepEqual(applyPromptBundle(base, "novo"), {
    system: "novo",
    commercial: "",
    support: "",
    postSale: "",
    extra: true,
  });
});
