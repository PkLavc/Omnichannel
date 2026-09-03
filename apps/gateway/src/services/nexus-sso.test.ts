import assert from "node:assert/strict";
import test from "node:test";
import { AdminRole } from "@prisma/client";
import {
  NEXUS_SSO_ISSUED_AT_SKEW_SECONDS,
  NEXUS_SSO_AUDIENCE,
  NEXUS_SSO_ISSUER,
  NexusSsoError,
  NexusSsoRedeemer,
  validateNexusSsoClaims,
  type NexusSsoClaims,
} from "./nexus-sso.js";

const now = new Date("2026-08-20T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);

function claims(overrides: Partial<NexusSsoClaims> = {}): NexusSsoClaims {
  return {
    version: 1,
    issuer: NEXUS_SSO_ISSUER,
    audience: NEXUS_SSO_AUDIENCE,
    subject: "nexus-user-1",
    email: "admin@example.com",
    name: "Admin Nexus",
    role: AdminRole.PLATFORM_ADMIN,
    tenantSlugs: [],
    jti: "9ceefc44-0d07-46f7-b41d-50a97517c44a",
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
    ...overrides,
  };
}

function isNexusError(code: string) {
  return (error: unknown) => error instanceof NexusSsoError && error.code === code;
}

test("claims Nexus válidos exigem emissor, audiência, papel, UUID e TTL curto exatos", () => {
  assert.deepEqual(validateNexusSsoClaims(claims(), now), claims());
  const edgeAhead = claims({
    issuedAt: nowSeconds + 6 * 60,
    expiresAt: nowSeconds + 7 * 60,
  });
  assert.deepEqual(validateNexusSsoClaims(edgeAhead, now), edgeAhead);
  assert.throws(
    () => validateNexusSsoClaims({ ...claims(), issuer: "https://attacker.example" }, now),
    isNexusError("invalid_sso_claims"),
  );
  assert.throws(
    () => validateNexusSsoClaims({ ...claims(), audience: "outro-sistema" }, now),
    isNexusError("invalid_sso_claims"),
  );
  assert.throws(
    () => validateNexusSsoClaims({ ...claims(), role: "TENANT_MEMBER" }, now),
    isNexusError("invalid_sso_claims"),
  );
  assert.throws(
    () => validateNexusSsoClaims(claims({ expiresAt: nowSeconds + 61 }), now),
    isNexusError("invalid_sso_claims"),
  );
  assert.throws(
    () => validateNexusSsoClaims(claims({ issuedAt: nowSeconds - 60, expiresAt: nowSeconds }), now),
    isNexusError("invalid_sso_claims"),
  );
  assert.throws(
    () => validateNexusSsoClaims(claims({
      issuedAt: nowSeconds + NEXUS_SSO_ISSUED_AT_SKEW_SECONDS + 1,
      expiresAt: nowSeconds + NEXUS_SSO_ISSUED_AT_SKEW_SECONDS + 61,
    }), now),
    isNexusError("invalid_sso_claims"),
  );
});

test("redeem chama somente o endpoint configurado e valida o envelope estrito", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const redeemer = new NexusSsoRedeemer({
    redeemUrl: "https://sso.example.com/api/omnichannel/redeem",
    now: () => now,
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ success: true, claims: claims() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await redeemer.redeem("a".repeat(43)), claims());
  assert.equal(requestUrl, "https://sso.example.com/api/omnichannel/redeem");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.redirect, "error");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { code: "a".repeat(43) });
});

test("redeem rejeita claims ruins e respostas upstream inválidas", async () => {
  const badClaims = new NexusSsoRedeemer({
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      claims: { ...claims(), audience: "wrong" },
    })),
  });
  await assert.rejects(badClaims.redeem("a".repeat(43)), isNexusError("invalid_sso_claims"));

  const badEnvelope = new NexusSsoRedeemer({
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, claims: claims(), extra: true })),
  });
  await assert.rejects(badEnvelope.redeem("a".repeat(43)), isNexusError("invalid_sso_response"));
});

test("redeem distingue ticket recusado, falha upstream e timeout", async () => {
  const refused = new NexusSsoRedeemer({
    fetchImpl: async () => new Response(JSON.stringify({ success: false, error: "invalid_code" }), { status: 401 }),
  });
  await assert.rejects(refused.redeem("a".repeat(43)), isNexusError("sso_ticket_invalid"));

  const failed = new NexusSsoRedeemer({
    fetchImpl: async () => new Response("failure", { status: 503 }),
  });
  await assert.rejects(failed.redeem("a".repeat(43)), isNexusError("sso_upstream_failed"));

  const timedOut = new NexusSsoRedeemer({
    timeoutMs: 250,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });
  await assert.rejects(timedOut.redeem("a".repeat(43)), isNexusError("sso_upstream_timeout"));
});
