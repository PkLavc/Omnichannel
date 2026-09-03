import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminPath = new URL("../apps/admin/index.html", import.meta.url);

test("Admin exposes an explicit bot/company context and valid inline JavaScript", async () => {
  const html = await readFile(adminPath, "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)]
    .map(match => match[1])
    .filter(Boolean);
  for (const script of scripts) new Function(script);

  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  for (const id of ["tenantSelector", "newTenantBotName", "newTenantDeferIntegrations", "aiBotContext"]) {
    assert.ok(ids.includes(id), `missing #${id}`);
  }
  assert.match(html, /Bots \/ empresas/u);
  assert.match(html, /Começar sem Chatwoot e sem conhecimento/u);
});

test("Admin does not silently select a hard-coded company for every user", async () => {
  const html = await readFile(adminPath, "utf8");
  assert.doesNotMatch(html, /slug\|\|''\)\.toLowerCase\(\)==='empresa-exemplo'/u);
});

test("Admin honors an accessible tenantSlug selected by Nexus SSO", async () => {
  const html = await readFile(adminPath, "utf8");
  assert.match(html, /URLSearchParams\(window\.location\.search\)\.get\('tenantSlug'\)/u);
  assert.match(html, /selectable\.find\(function\(item\).*item\.slug/u);
  assert.match(html, /requestedTenant\?String\(requestedTenant\.id\)/u);
});

test("Admin reviews consolidated learning by specialty without auto-approving facts", async () => {
  const html = await readFile(adminPath, "utf8");
  assert.match(html, /Candidatos consolidados/u);
  assert.match(html, /INTAKE:'Triagem',SALES:'Comercial',CUSTOMER_CARE:'SAC',TECHNICAL:'Técnico'/u);
  assert.match(html, /\/admin\/learning\/discover/u);
  assert.match(html, /\/admin\/learning\/candidates\/review/u);
  assert.match(html, /status==='READY_FOR_REVIEW'&&\(!item\.requiresGrounding\|\|item\.groundingVerified\)/u);
  assert.match(html, /Exige fonte oficial; repetição não valida o fato/u);
});
