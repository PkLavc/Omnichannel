-- Replace only the untouched GLM bootstrap configuration. Existing enabled
-- providers and rows with credentials are operator-owned and remain unchanged.
UPDATE "ProviderConfig"
SET
  "model" = '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  "options" = '{
    "temperature": 0.2,
    "maxTokens": 600,
    "timeoutMs": 5000,
    "inputCostPerMillion": 0.045,
    "outputCostPerMillion": 0.384
  }'::jsonb,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "type" = 'cloudflare'
  AND "model" = '@cf/zai-org/glm-4.7-flash'
  AND "enabled" = false
  AND "encryptedApiKey" IS NULL;
