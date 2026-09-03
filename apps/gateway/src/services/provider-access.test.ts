import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminRole,
  PrismaClient,
  ProviderScope,
} from "@prisma/client";
import {
  ProviderAccessError,
  ProviderAccessService,
  providerVisibilityWhere,
  requireProviderWriteAuthorization,
} from "./provider-access.js";
import {
  capabilitiesForRole,
  type AdminPrincipal,
} from "./admin-auth.js";

test("filtro efetivo combina provider ALL com membership SELECTED", () => {
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

test("apenas PLATFORM_ADMIN possui providers:write", () => {
  const principal: AdminPrincipal = {
    userId: "user-1",
    sessionId: "session-1",
    email: "user@example.com",
    name: "Usuário",
    role: AdminRole.TENANT_USER,
    capabilities: capabilitiesForRole(AdminRole.TENANT_USER),
    tenantIds: ["tenant-a"],
    expiresAt: new Date(Date.now() + 60_000),
  };
  assert.throws(
    () => requireProviderWriteAuthorization(principal),
    /providers:write/u,
  );
  requireProviderWriteAuthorization({
    ...principal,
    role: AdminRole.PLATFORM_ADMIN,
    capabilities: capabilitiesForRole(AdminRole.PLATFORM_ADMIN),
  });
});

test("listForTenant valida tenant ativo e aplica visibilidade global", async () => {
  let providerWhere: unknown;
  const fakePrisma = {
    tenant: {
      findFirst: async () => ({ id: "tenant-a" }),
    },
    providerConfig: {
      findMany: async ({ where }: { where: unknown }) => {
        providerWhere = where;
        return [{ id: "provider-all" }];
      },
    },
  } as unknown as PrismaClient;
  const service = new ProviderAccessService(fakePrisma);
  const rows = await service.listForTenant("tenant-a");
  assert.equal(rows.length, 1);
  assert.deepEqual(providerWhere, {
    enabled: true,
    ...providerVisibilityWhere("tenant-a"),
  });
});

test("setScope SELECTED substitui atomicamente os tenants permitidos", async () => {
  const operations: Array<{ operation: string; value: unknown }> = [];
  const transaction = {
    providerTenantAccess: {
      deleteMany: async ({ where }: { where: unknown }) => {
        operations.push({ operation: "delete", value: where });
      },
      createMany: async ({ data }: { data: unknown }) => {
        operations.push({ operation: "create", value: data });
      },
    },
    providerConfig: {
      update: async ({ data }: { data: unknown }) => {
        operations.push({ operation: "update", value: data });
        return {
          id: "provider-1",
          scope: ProviderScope.SELECTED,
          tenantAccesses: [{ tenantId: "tenant-a" }, { tenantId: "tenant-b" }],
        };
      },
    },
  };
  const fakePrisma = {
    providerConfig: {
      findUnique: async () => ({ id: "provider-1" }),
    },
    tenant: {
      findMany: async () => [{ id: "tenant-a" }, { id: "tenant-b" }],
    },
    $transaction: async (
      callback: (value: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  } as unknown as PrismaClient;
  const service = new ProviderAccessService(fakePrisma);
  const provider = await service.setScope({
    providerConfigId: "provider-1",
    scope: ProviderScope.SELECTED,
    tenantIds: ["tenant-a", "tenant-b", "tenant-a"],
  });
  assert.equal(provider.scope, ProviderScope.SELECTED);
  assert.deepEqual(operations, [
    {
      operation: "delete",
      value: { providerConfigId: "provider-1" },
    },
    {
      operation: "create",
      value: [
        { providerConfigId: "provider-1", tenantId: "tenant-a" },
        { providerConfigId: "provider-1", tenantId: "tenant-b" },
      ],
    },
    {
      operation: "update",
      value: { scope: ProviderScope.SELECTED },
    },
  ]);
});

test("scope SELECTED vazio é recusado", async () => {
  const fakePrisma = {
    providerConfig: {
      findUnique: async () => ({ id: "provider-1" }),
    },
  } as unknown as PrismaClient;
  const service = new ProviderAccessService(fakePrisma);
  await assert.rejects(
    service.setScope({
      providerConfigId: "provider-1",
      scope: ProviderScope.SELECTED,
      tenantIds: [],
    }),
    (error: unknown) => error instanceof ProviderAccessError
      && error.code === "selected_tenants_required",
  );
});
