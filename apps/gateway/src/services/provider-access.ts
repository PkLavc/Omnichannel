import {
  Prisma,
  PrismaClient,
  ProviderScope,
} from "@prisma/client";
import {
  type AdminPrincipal,
  requireAdminCapability,
} from "./admin-auth.js";

export class ProviderAccessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProviderAccessError";
  }
}

export function providerVisibilityWhere(
  tenantId: string,
): Prisma.ProviderConfigWhereInput {
  return {
    OR: [
      { scope: ProviderScope.ALL },
      {
        scope: ProviderScope.SELECTED,
        tenantAccesses: { some: { tenantId } },
      },
    ],
  };
}

export function requireProviderWriteAuthorization(principal: AdminPrincipal) {
  requireAdminCapability(principal, "providers:write");
}

export class ProviderAccessService {
  constructor(private readonly prisma: PrismaClient) {}

  private async requireActiveTenantIds(tenantIds: readonly string[]) {
    const uniqueIds = [...new Set(tenantIds.map(value => value.trim()).filter(Boolean))];
    if (!uniqueIds.length) {
      throw new ProviderAccessError(
        "selected_tenants_required",
        "O escopo SELECTED exige ao menos um tenant.",
        400,
      );
    }
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: uniqueIds }, active: true },
      select: { id: true },
    });
    if (tenants.length !== uniqueIds.length) {
      throw new ProviderAccessError(
        "invalid_selected_tenant",
        "Um ou mais tenants selecionados não existem ou estão inativos.",
        400,
      );
    }
    return uniqueIds;
  }

  async listForTenant(
    tenantId: string,
    options: { enabledOnly?: boolean } = {},
  ) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, active: true },
      select: { id: true },
    });
    if (!tenant) {
      throw new ProviderAccessError("tenant_not_found", "Tenant ativo não encontrado.", 404);
    }
    return this.prisma.providerConfig.findMany({
      where: {
        ...(options.enabledOnly !== false ? { enabled: true } : {}),
        ...providerVisibilityWhere(tenantId),
      },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
    });
  }

  async listGlobal(options: { enabledOnly?: boolean } = {}) {
    return this.prisma.providerConfig.findMany({
      where: options.enabledOnly ? { enabled: true } : undefined,
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      include: {
        tenantAccesses: {
          orderBy: { createdAt: "asc" },
          select: {
            tenantId: true,
            tenant: {
              select: { slug: true, name: true, active: true },
            },
          },
        },
      },
    });
  }

  async canTenantUseProvider(tenantId: string, providerConfigId: string) {
    const activeTenant = await this.prisma.tenant.count({
      where: { id: tenantId, active: true },
    });
    if (!activeTenant) return false;
    return await this.prisma.providerConfig.count({
      where: {
        id: providerConfigId,
        enabled: true,
        ...providerVisibilityWhere(tenantId),
      },
    }) > 0;
  }

  async setScope(input: {
    providerConfigId: string;
    scope: ProviderScope;
    tenantIds?: readonly string[];
  }) {
    const provider = await this.prisma.providerConfig.findUnique({
      where: { id: input.providerConfigId },
      select: { id: true },
    });
    if (!provider) {
      throw new ProviderAccessError("provider_not_found", "Provider não encontrado.", 404);
    }

    if (input.scope === ProviderScope.ALL) {
      return this.prisma.$transaction(async transaction => {
        await transaction.providerTenantAccess.deleteMany({
          where: { providerConfigId: provider.id },
        });
        return transaction.providerConfig.update({
          where: { id: provider.id },
          data: { scope: ProviderScope.ALL },
          include: {
            tenantAccesses: { select: { tenantId: true } },
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }

    const tenantIds = await this.requireActiveTenantIds(input.tenantIds ?? []);
    return this.prisma.$transaction(async transaction => {
      await transaction.providerTenantAccess.deleteMany({
        where: { providerConfigId: provider.id },
      });
      await transaction.providerTenantAccess.createMany({
        data: tenantIds.map(tenantId => ({
          providerConfigId: provider.id,
          tenantId,
        })),
      });
      return transaction.providerConfig.update({
        where: { id: provider.id },
        data: { scope: ProviderScope.SELECTED },
        include: {
          tenantAccesses: {
            orderBy: { createdAt: "asc" },
            select: { tenantId: true },
          },
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
