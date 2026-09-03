-- Nexus identities remain separate from local password identities. The
-- compound key makes the external subject idempotent while PostgreSQL still
-- permits multiple LOCAL rows with a NULL external subject.
CREATE TYPE "AdminAuthSource" AS ENUM ('LOCAL', 'NEXUS');

ALTER TABLE "AdminUser"
  ADD COLUMN "authSource" "AdminAuthSource" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN "externalSubject" TEXT;

CREATE UNIQUE INDEX "AdminUser_authSource_externalSubject_key"
  ON "AdminUser"("authSource", "externalSubject");
