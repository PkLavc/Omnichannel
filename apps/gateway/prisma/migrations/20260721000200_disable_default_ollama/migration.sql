-- Ollama is optional. Existing bootstrap rows created without user credentials
-- must not make the default stack depend on a local Ollama installation.
UPDATE "ProviderConfig"
SET "enabled" = false
WHERE "type" = 'ollama'
  AND "encryptedApiKey" IS NULL;
