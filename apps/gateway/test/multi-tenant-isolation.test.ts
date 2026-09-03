import test from "node:test";
import assert from "node:assert/strict";
import { AdminRole, ProviderScope } from "@prisma/client";
import {
  AdminAuthError,
  canAccessTenant,
  capabilitiesForRole,
  hasAdminCapability,
  requireTenantAuthorization,
  type AdminPrincipal,
} from "../dist/services/admin-auth.js";
import {
  providerVisibilityWhere,
  requireProviderWriteAuthorization,
} from "../dist/services/provider-access.js";

function principal(role: AdminRole, tenantIds: string[]): AdminPrincipal {
  return {
    userId: `user-${role}`,
    sessionId: `session-${role}`,
    email: `${role.toLowerCase()}@example.test`,
    name: role,
    role,
    capabilities: capabilitiesForRole(role),
    tenantIds,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

test("tenant users receive default-deny access outside explicit memberships", () => {
  const user = principal(AdminRole.TENANT_USER, ["tenant-a"]);

  assert.equal(canAccessTenant(user, "tenant-a"), true);
  assert.equal(canAccessTenant(user, "tenant-b"), false);
  assert.equal(canAccessTenant(user, ""), false);
});

test("opaque tenant IDs are matched exactly, never by slug, prefix, or case folding", () => {
  const user = principal(AdminRole.TENANT_USER, ["opaque-Tenant-01"]);

  assert.equal(canAccessTenant(user, "opaque-Tenant-01"), true);
  assert.equal(canAccessTenant(user, "opaque-tenant-01"), false);
  assert.equal(canAccessTenant(user, "opaque-Tenant"), false);
  assert.equal(canAccessTenant(user, "company-slug"), false);
});

test("tenant authorization rejects a forged X-Tenant-Id context", () => {
  const user = principal(AdminRole.TENANT_USER, ["tenant-a"]);

  assert.doesNotThrow(() => requireTenantAuthorization(user, "tenant-a", "tenant:read"));
  assert.throws(
    () => requireTenantAuthorization(user, "tenant-b", "tenant:read"),
    (error: unknown) =>
      error instanceof AdminAuthError
      && error.code === "tenant_forbidden"
      && error.statusCode === 403,
  );
});

test("platform-only capabilities cannot be obtained from tenant membership", () => {
  const tenantUser = principal(AdminRole.TENANT_USER, ["tenant-a", "tenant-b"]);
  const platformAdmin = principal(AdminRole.PLATFORM_ADMIN, []);

  assert.equal(hasAdminCapability(tenantUser, "providers:write"), false);
  assert.equal(hasAdminCapability(tenantUser, "users:write"), false);
  assert.equal(hasAdminCapability(tenantUser, "tenant:read"), true);
  assert.equal(hasAdminCapability(platformAdmin, "providers:write"), true);
  assert.equal(canAccessTenant(platformAdmin, "tenant-not-in-memberships"), true);
});

test("provider visibility expresses ALL or an explicit SELECTED allowlist", () => {
  assert.deepEqual(providerVisibilityWhere("tenant-a"), {
    OR: [
      { scope: ProviderScope.ALL },
      {
        scope: ProviderScope.SELECTED,
        tenantAccesses: { some: { tenantId: "tenant-a" } },
      },
    ],
  });
});

test("provider writes remain platform-admin-only regardless of tenant memberships", () => {
  const tenantUser = principal(AdminRole.TENANT_USER, ["tenant-a", "tenant-b"]);
  const platformAdmin = principal(AdminRole.PLATFORM_ADMIN, []);

  assert.throws(
    () => requireProviderWriteAuthorization(tenantUser),
    (error: unknown) =>
      error instanceof AdminAuthError
      && error.code === "forbidden"
      && error.statusCode === 403,
  );
  assert.doesNotThrow(() => requireProviderWriteAuthorization(platformAdmin));
});
