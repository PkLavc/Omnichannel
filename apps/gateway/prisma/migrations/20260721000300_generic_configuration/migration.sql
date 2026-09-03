-- Allow multiple provider instances of the same protocol while keeping names
-- unique inside a tenant.
DROP INDEX IF EXISTS "ProviderConfig_tenantId_type_key";
CREATE INDEX IF NOT EXISTS "ProviderConfig_tenantId_type_idx"
  ON "ProviderConfig"("tenantId", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderConfig_tenantId_name_key"
  ON "ProviderConfig"("tenantId", "name");

-- Persist HTTP Tool adapters without exposing their authentication material.
CREATE TABLE "ToolConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "endpoint" TEXT,
    "encryptedAuth" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ToolConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ToolConfig_tenantId_name_key" ON "ToolConfig"("tenantId", "name");
CREATE INDEX "ToolConfig_tenantId_enabled_idx" ON "ToolConfig"("tenantId", "enabled");
ALTER TABLE "ToolConfig" ADD CONSTRAINT "ToolConfig_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
