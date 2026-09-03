-- Global provider visibility and database-backed administrative identities.
-- Every statement is safe to re-run manually; Prisma still records the
-- migration once during a normal deploy.

DO $$ BEGIN
  CREATE TYPE "ProviderScope" AS ENUM ('ALL', 'SELECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AdminRole" AS ENUM ('PLATFORM_ADMIN', 'TENANT_USER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ProviderConfig"
  ADD COLUMN IF NOT EXISTS "scope" "ProviderScope" NOT NULL DEFAULT 'ALL',
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Providers were tenant-owned before this migration. They become global and
-- keep their full encrypted configuration. In the unlikely event that two
-- tenants used the same display name, retain both rows with a stable suffix.
DO $migration$
DECLARE
  duplicate_provider RECORD;
  candidate_name TEXT;
BEGIN
  FOR duplicate_provider IN
    SELECT "id", "name"
    FROM (
      SELECT "id", "name",
             ROW_NUMBER() OVER (
               PARTITION BY "name"
               ORDER BY "updatedAt" DESC, "id"
             ) AS duplicate_number
      FROM "ProviderConfig"
    ) ranked
    WHERE duplicate_number > 1
  LOOP
    candidate_name := duplicate_provider."name" || ' [migrated:' || duplicate_provider."id" || ']';
    WHILE EXISTS (
      SELECT 1
      FROM "ProviderConfig"
      WHERE "name" = candidate_name
        AND "id" <> duplicate_provider."id"
    ) LOOP
      candidate_name := candidate_name || '_';
    END LOOP;
    UPDATE "ProviderConfig"
    SET "name" = candidate_name
    WHERE "id" = duplicate_provider."id";
  END LOOP;
END;
$migration$;

ALTER TABLE "ProviderConfig"
  DROP CONSTRAINT IF EXISTS "ProviderConfig_tenantId_fkey";
ALTER TABLE "ProviderConfig"
  ALTER COLUMN "tenantId" DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE "ProviderConfig"
    ADD CONSTRAINT "ProviderConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ProviderTenantAccess" (
  "providerConfigId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderTenantAccess_pkey" PRIMARY KEY ("providerConfigId", "tenantId")
);
CREATE INDEX IF NOT EXISTS "ProviderTenantAccess_tenantId_providerConfigId_idx"
  ON "ProviderTenantAccess"("tenantId", "providerConfigId");
DO $$ BEGIN
  ALTER TABLE "ProviderTenantAccess"
    ADD CONSTRAINT "ProviderTenantAccess_providerConfigId_fkey"
    FOREIGN KEY ("providerConfigId") REFERENCES "ProviderConfig"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ProviderTenantAccess"
    ADD CONSTRAINT "ProviderTenantAccess_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A pre-migration provider belonged to exactly one tenant. Preserve that
-- visibility explicitly before clearing the legacy ownership column.
INSERT INTO "ProviderTenantAccess" ("providerConfigId", "tenantId")
SELECT "id", "tenantId"
FROM "ProviderConfig"
WHERE "tenantId" IS NOT NULL
ON CONFLICT ("providerConfigId", "tenantId") DO NOTHING;

UPDATE "ProviderConfig"
SET "scope" = 'SELECTED',
    "tenantId" = NULL
WHERE "tenantId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderConfig_name_key"
  ON "ProviderConfig"("name");
CREATE INDEX IF NOT EXISTS "ProviderConfig_scope_enabled_priority_idx"
  ON "ProviderConfig"("scope", "enabled", "priority");
CREATE INDEX IF NOT EXISTS "Tenant_active_name_idx"
  ON "Tenant"("active", "name");

CREATE TABLE IF NOT EXISTS "AdminUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "AdminRole" NOT NULL DEFAULT 'TENANT_USER',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminUser_email_normalized_check"
    CHECK ("email" = lower("email") AND position('@' IN "email") > 1),
  CONSTRAINT "AdminUser_password_hash_check"
    CHECK (length("passwordHash") >= 40)
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminUser_email_key"
  ON "AdminUser"("email");
CREATE INDEX IF NOT EXISTS "AdminUser_active_role_idx"
  ON "AdminUser"("active", "role");

CREATE TABLE IF NOT EXISTS "AdminUserTenant" (
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminUserTenant_pkey" PRIMARY KEY ("userId", "tenantId")
);
CREATE INDEX IF NOT EXISTS "AdminUserTenant_tenantId_userId_idx"
  ON "AdminUserTenant"("tenantId", "userId");
DO $$ BEGIN
  ALTER TABLE "AdminUserTenant"
    ADD CONSTRAINT "AdminUserTenant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AdminUser"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AdminUserTenant"
    ADD CONSTRAINT "AdminUserTenant_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AdminSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminSession_token_hash_check"
    CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AdminSession_expiry_check"
    CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminSession_tokenHash_key"
  ON "AdminSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "AdminSession_userId_expiresAt_idx"
  ON "AdminSession"("userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "AdminSession_expiresAt_revokedAt_idx"
  ON "AdminSession"("expiresAt", "revokedAt");
DO $$ BEGIN
  ALTER TABLE "AdminSession"
    ADD CONSTRAINT "AdminSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "AdminUser"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
