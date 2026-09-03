import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { ProviderAccessService } from "./provider-access.js";

const baseUrl = process.env.MULTI_TENANT_E2E_BASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
const commercialToken = process.env.COMMERCIAL_EVENTS_TOKEN;
const enabled = Boolean(baseUrl && adminToken && commercialToken);

type RequestOptions = {
  token?: string;
  tenantId?: string;
  method?: string;
  body?: unknown;
  form?: FormData;
};

async function api(path: string, options: RequestOptions = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.tenantId) headers.set("x-tenant-id", options.tenantId);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, payload };
}

function record(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

test("duas empresas permanecem isoladas em acesso, RAG, regras, conversas e comercial", {
  skip: !enabled,
  timeout: 60_000,
}, async () => {
  const prisma = new PrismaClient();
  const providerAccess = new ProviderAccessService(prisma);
  const prefix = `runtime-audit-${Date.now()}`;
  let tenantAId: string | undefined;
  let tenantBId: string | undefined;
  const providerIds: string[] = [];

  try {
    const tenantAResponse = await api("/admin/tenants", {
      method: "POST",
      token: adminToken,
      body: {
        slug: `${prefix}-a`,
        name: "Empresa Audit A",
        language: "pt-BR",
        primaryColor: "#1166aa",
      },
    });
    const tenantBResponse = await api("/admin/tenants", {
      method: "POST",
      token: adminToken,
      body: {
        slug: `${prefix}-b`,
        name: "Empresa Audit B",
        language: "pt-BR",
        primaryColor: "#aa6611",
      },
    });
    assert.equal(tenantAResponse.status, 201);
    assert.equal(tenantBResponse.status, 201);
    tenantAId = String(record(tenantAResponse.payload).id);
    tenantBId = String(record(tenantBResponse.payload).id);

    for (const [tenantId, companyName, botName, marker, webhookSecret] of [
      [tenantAId, "Empresa Audit A", "Bot Comercial A", "REGRA_EXCLUSIVA_EMPRESA_A", "webhook-audit-a"],
      [tenantBId, "Empresa Audit B", "Bot SAC B", "REGRA_EXCLUSIVA_EMPRESA_B", "webhook-audit-b"],
    ] as const) {
      const settings = await api("/admin/settings", {
        method: "PUT",
        token: adminToken,
        tenantId,
        body: {
          companyName,
          botName,
          prompts: {
            commercial: `Comercial de ${companyName}`,
            support: `SAC de ${companyName}`,
          },
          chatwootAccountId: tenantId === tenantAId ? "101" : "202",
          chatwootInboxId: tenantId === tenantAId ? "11" : "22",
          chatwootInboxIds: tenantId === tenantAId ? ["11", "12", "13"] : ["22", "23"],
          webhookSecret,
        },
      });
      assert.equal(settings.status, 200);
      const rules = await api("/admin/business-rules", {
        method: "PUT",
        token: adminToken,
        tenantId,
        body: {
          enabled: true,
          rules: {
            data: {
              nodes: [{
                id: `message-${tenantId}`,
                type: "whatsappMessage",
                displayName: companyName,
                data: { parameters: { body: marker } },
              }],
              edges: [],
            },
          },
        },
      });
      assert.equal(rules.status, 200);
    }

    const providerResponse = await api("/admin/providers", {
      method: "POST",
      token: adminToken,
      body: {
        type: "cloudflare",
        name: `${prefix}-provider`,
        enabled: false,
        priority: 50,
        scopeMode: "SELECTED",
        tenantIds: [tenantAId],
        model: "audit-model",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/audit/ai/v1",
        options: {
          temperature: 0.2,
          maxTokens: 100,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          timeoutMs: 1_000,
          healthPath: "models",
        },
      },
    });
    assert.equal(providerResponse.status, 201);
    const provider = record(providerResponse.payload);
    providerIds.push(String(provider.id));
    assert.equal(provider.scopeMode, "SELECTED");
    assert.deepEqual(provider.tenantIds, [tenantAId]);
    assert.equal(
      (await providerAccess.listForTenant(tenantAId, { enabledOnly: false }))
        .some(item => item.id === providerIds[0]),
      true,
    );
    assert.equal(
      (await providerAccess.listForTenant(tenantBId, { enabledOnly: false }))
        .some(item => item.id === providerIds[0]),
      false,
    );

    const globalProviderResponse = await api("/admin/providers", {
      method: "POST",
      token: adminToken,
      body: {
        type: "openrouter",
        name: `${prefix}-global-provider`,
        enabled: false,
        priority: 51,
        tenantIds: [],
        model: "openrouter/free",
        baseUrl: "https://openrouter.ai/api/v1",
        options: {
          temperature: 0.2,
          maxTokens: 100,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          timeoutMs: 1_000,
          healthPath: "models",
        },
      },
    });
    assert.equal(globalProviderResponse.status, 201);
    const globalProvider = record(globalProviderResponse.payload);
    providerIds.push(String(globalProvider.id));
    assert.equal(globalProvider.scopeMode, "ALL");
    assert.equal(
      (await providerAccess.listForTenant(tenantAId, { enabledOnly: false }))
        .some(item => item.id === providerIds[1]),
      true,
    );
    assert.equal(
      (await providerAccess.listForTenant(tenantBId, { enabledOnly: false }))
        .some(item => item.id === providerIds[1]),
      true,
    );

    const passwordA = "AuditPass!2026-A";
    const passwordB = "AuditPass!2026-B";
    const userAResponse = await api("/admin/users", {
      method: "POST",
      token: adminToken,
      body: {
        username: `${prefix}-a@example.test`,
        name: "Operador A",
        password: passwordA,
        role: "TENANT_USER",
        enabled: true,
        tenantIds: [tenantAId],
      },
    });
    const userBResponse = await api("/admin/users", {
      method: "POST",
      token: adminToken,
      body: {
        username: `${prefix}-b@example.test`,
        name: "Operador B",
        password: passwordB,
        role: "TENANT_USER",
        enabled: true,
        tenantIds: [tenantBId],
      },
    });
    assert.equal(userAResponse.status, 201);
    assert.equal(userBResponse.status, 201);
    const userAId = String(record(userAResponse.payload).id);

    const loginA = await api("/admin/auth/login", {
      method: "POST",
      body: {
        username: record(userAResponse.payload).email,
        password: passwordA,
      },
    });
    const loginB = await api("/admin/auth/login", {
      method: "POST",
      body: {
        username: record(userBResponse.payload).email,
        password: passwordB,
      },
    });
    assert.equal(loginA.status, 200);
    assert.equal(loginB.status, 200);
    const tokenA = String(record(loginA.payload).token);
    const tokenB = String(record(loginB.payload).token);

    const meA = await api("/admin/me", { token: tokenA });
    const meB = await api("/admin/me", { token: tokenB });
    assert.deepEqual(record(meA.payload).tenants.map((item: any) => item.id), [tenantAId]);
    assert.deepEqual(record(meB.payload).tenants.map((item: any) => item.id), [tenantBId]);
    assert.equal((await api("/admin/settings", { token: tokenA, tenantId: tenantBId })).status, 403);
    assert.equal((await api("/admin/settings", { token: tokenB, tenantId: tenantAId })).status, 403);
    assert.equal((await api("/admin/providers", { token: tokenA })).status, 403);
    assert.equal((await api("/admin/settings", { token: adminToken })).status, 400);

    const webhookWithoutIdentity = await api(`/webhooks/chatwoot/${prefix}-a?secret=webhook-audit-a`, {
      method: "POST",
      body: {
        event: "message_created",
        message_type: "incoming",
        content: "não deve entrar sem account e inbox",
        conversation: { id: `${prefix}-forged` },
      },
    });
    assert.equal(webhookWithoutIdentity.status, 202);
    assert.equal(record(webhookWithoutIdentity.payload).reason, "account_missing");
    const webhookWithoutInbox = await api(`/webhooks/chatwoot/${prefix}-a?secret=webhook-audit-a`, {
      method: "POST",
      body: {
        event: "message_created",
        message_type: "incoming",
        content: "não deve entrar sem inbox",
        account: { id: "101" },
        conversation: { id: `${prefix}-forged` },
      },
    });
    assert.equal(webhookWithoutInbox.status, 202);
    assert.equal(record(webhookWithoutInbox.payload).reason, "inbox_missing");
    const webhookFromSecondCompany = await api(`/webhooks/chatwoot/${prefix}-a?secret=webhook-audit-a`, {
      method: "POST",
      body: {
        event: "message_created",
        message_type: "incoming",
        content: "canal de outra empresa",
        account: { id: "101" },
        inbox: { id: "22" },
        conversation: { id: `${prefix}-forged` },
      },
    });
    assert.equal(webhookFromSecondCompany.status, 202);
    assert.equal(record(webhookFromSecondCompany.payload).reason, "inbox_mismatch");
    const validSecondaryChannel = await api(`/webhooks/chatwoot/${prefix}-a?secret=webhook-audit-a`, {
      method: "POST",
      body: {
        event: "message_created",
        message_type: "incoming",
        private: true,
        content: "canal secundário válido",
        account: { id: "101" },
        inbox: { id: "12" },
        conversation: { id: `${prefix}-private` },
      },
    });
    assert.equal(validSecondaryChannel.status, 202);
    assert.equal(record(validSecondaryChannel.payload).ignored, true);
    assert.equal(record(validSecondaryChannel.payload).reason, undefined);
    assert.equal((await api("/webhooks/chatwoot?secret=webhook-audit-a", {
      method: "POST",
      body: {
        event: "message_created",
        message_type: "incoming",
        content: "rota legada",
        conversation: { id: `${prefix}-legacy` },
      },
    })).status, 410);

    const formA = new FormData();
    formA.set(
      "file",
      new Blob([await readFile("/workspace/docs/pt-br/Multi-Tenancy.md")], { type: "text/markdown" }),
      "Multi-Tenancy.md",
    );
    const formB = new FormData();
    formB.set(
      "file",
      new Blob([await readFile("/workspace/docs/en/Providers.md")], { type: "text/markdown" }),
      "Providers.md",
    );
    assert.equal((await api("/admin/rag/import", {
      method: "POST",
      token: tokenA,
      tenantId: tenantAId,
      form: formA,
    })).status, 200);
    assert.equal((await api("/admin/rag/import", {
      method: "POST",
      token: tokenB,
      tenantId: tenantBId,
      form: formB,
    })).status, 200);
    const documentsA = record((await api("/admin/rag/documents", {
      token: tokenA,
      tenantId: tenantAId,
    })).payload).documents;
    const documentsB = record((await api("/admin/rag/documents", {
      token: tokenB,
      tenantId: tenantBId,
    })).payload).documents;
    assert.deepEqual(documentsA.map((item: any) => item.title), ["Multi-Tenancy.md"]);
    assert.deepEqual(documentsB.map((item: any) => item.title), ["Providers.md"]);

    const conversationExternalId = `${prefix}-conversation`;
    assert.equal((await api("/v1/chat/completions", {
      method: "POST",
      token: adminToken,
      tenantId: tenantAId,
      body: { conversationId: conversationExternalId, message: "Pergunta somente da empresa A" },
    })).status, 200);
    assert.equal((await api("/v1/chat/completions", {
      method: "POST",
      token: adminToken,
      tenantId: tenantBId,
      body: { conversationId: conversationExternalId, message: "Pergunta somente da empresa B" },
    })).status, 200);
    const listA = (await api("/admin/conversations", {
      token: tokenA,
      tenantId: tenantAId,
    })).payload as any[];
    const listB = (await api("/admin/conversations", {
      token: tokenB,
      tenantId: tenantBId,
    })).payload as any[];
    assert.equal(listA.filter(item => item.externalId === conversationExternalId).length, 1);
    assert.equal(listB.filter(item => item.externalId === conversationExternalId).length, 1);
    assert.notEqual(
      listA.find(item => item.externalId === conversationExternalId).id,
      listB.find(item => item.externalId === conversationExternalId).id,
    );
    assert.equal((await api(`/admin/conversations/${encodeURIComponent(conversationExternalId)}/feedback`, {
      method: "POST",
      token: tokenA,
      tenantId: tenantAId,
      body: {
        verdict: "POSITIVE",
        reviewerId: "forged-reviewer",
        comment: "Auditoria de identidade",
        source: "runtime-audit",
        metadata: {},
      },
    })).status, 200);

    const tenantCommercialCredential = await api("/admin/integrations/commercial-events-token", {
      token: adminToken,
      tenantId: tenantAId,
    });
    assert.equal(tenantCommercialCredential.status, 200);
    const tenantCommercialToken = String(record(tenantCommercialCredential.payload).token);
    assert.notEqual(tenantCommercialToken, commercialToken);
    assert.equal((await api("/v1/commercial/events", {
      method: "POST",
      token: commercialToken,
      tenantId: tenantAId,
      body: {
        conversationExternalId,
        kind: "ORDER",
        source: "runtime-audit",
        externalId: `${prefix}-raw-master-order`,
        status: "confirmed",
        verificationStatus: "VERIFIED",
        verificationEvidence: { audit: true },
        metadata: {},
      },
    })).status, 401);
    assert.equal((await api("/v1/commercial/events", {
      method: "POST",
      token: tenantCommercialToken,
      tenantId: tenantBId,
      body: {
        conversationExternalId,
        kind: "ORDER",
        source: "runtime-audit",
        externalId: `${prefix}-cross-tenant-order`,
        status: "confirmed",
        verificationStatus: "VERIFIED",
        verificationEvidence: { audit: true },
        metadata: {},
      },
    })).status, 401);
    assert.equal((await api("/v1/commercial/events", {
      method: "POST",
      token: tenantCommercialToken,
      tenantId: tenantAId,
      body: {
        conversationExternalId,
        kind: "ORDER",
        source: "runtime-audit",
        externalId: `${prefix}-order`,
        status: "confirmed",
        verificationStatus: "VERIFIED",
        verificationEvidence: { audit: true },
        metadata: {},
      },
    })).status, 200);
    const summaryA = record((await api("/admin/improvement/summary", {
      token: tokenA,
      tenantId: tenantAId,
    })).payload);
    const summaryB = record((await api("/admin/improvement/summary", {
      token: tokenB,
      tenantId: tenantBId,
    })).payload);
    const conversationA = summaryA.conversations.find((item: any) => item.externalId === conversationExternalId);
    const conversationB = summaryB.conversations.find((item: any) => item.externalId === conversationExternalId);
    assert.equal(conversationA.commerceLinks.length, 1);
    assert.equal(conversationB.commerceLinks.length, 0);
    assert.equal(conversationA.humanFeedback[0].reviewerId, userAId);

    const rulesA = record((await api("/admin/business-rules", {
      token: tokenA,
      tenantId: tenantAId,
    })).payload);
    const rulesB = record((await api("/admin/business-rules", {
      token: tokenB,
      tenantId: tenantBId,
    })).payload);
    assert.equal(rulesA.rules.data.nodes[0].data.parameters.body, "REGRA_EXCLUSIVA_EMPRESA_A");
    assert.equal(rulesB.rules.data.nodes[0].data.parameters.body, "REGRA_EXCLUSIVA_EMPRESA_B");
  } finally {
    for (const providerId of providerIds) {
      await api(`/admin/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
        token: adminToken,
      }).catch(() => undefined);
    }
    await prisma.adminUser.deleteMany({ where: { email: { startsWith: prefix } } });
    await prisma.providerConfig.deleteMany({ where: { name: { startsWith: prefix } } });
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: prefix } } });
    assert.equal(await prisma.adminUser.count({ where: { email: { startsWith: prefix } } }), 0);
    assert.equal(await prisma.providerConfig.count({ where: { name: { startsWith: prefix } } }), 0);
    assert.equal(await prisma.tenant.count({ where: { slug: { startsWith: prefix } } }), 0);
    await prisma.$disconnect();
  }
});
