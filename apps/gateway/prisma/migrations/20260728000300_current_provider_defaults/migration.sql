-- Refresh only untouched bootstrap rows. User-configured providers are never
-- overwritten by this migration.
UPDATE "ProviderConfig"
SET
  "model" = '@cf/zai-org/glm-4.7-flash',
  "options" = '{"temperature":0.2,"maxTokens":600,"timeoutMs":10000}'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "type" = 'cloudflare'
  AND "model" = '@cf/meta/llama-3.1-8b-instruct'
  AND "enabled" = false
  AND "encryptedApiKey" IS NULL
  AND "options" = '{}'::jsonb;

UPDATE "ProviderConfig"
SET
  "model" = 'openrouter/free',
  "options" = '{"temperature":0.2,"maxTokens":600,"timeoutMs":15000}'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "type" = 'openrouter'
  AND "model" = 'meta-llama/llama-3.1-8b-instruct:free'
  AND "enabled" = false
  AND "encryptedApiKey" IS NULL
  AND "options" = '{}'::jsonb;

UPDATE "ProviderConfig"
SET
  "model" = 'gemini-3.5-flash-lite',
  "options" = '{"temperature":0.2,"maxTokens":600,"timeoutMs":15000}'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "type" = 'gemini'
  AND "model" = 'gemini-2.0-flash'
  AND "enabled" = false
  AND "encryptedApiKey" IS NULL
  AND "options" = '{}'::jsonb;
