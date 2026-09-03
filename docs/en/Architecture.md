# Architecture

Chatwoot is the omnichannel user interface. The **AI Gateway** receives events, keeps conversation state, applies configurable business prompts and rules, queries Tools and RAG, selects an AI provider, and sends the answer through the Chatwoot API.

```text
Customer → Chatwoot → webhook → AI Gateway
                                  ├─ memory and business rules
                                  ├─ registered HTTP Tool
                                  ├─ RAG / pgvector
                                  └─ AI providers with fallback
                         ← Chatwoot API ← answer
```

## Configuration model

The initial setup wizard creates each organization's identity and operational configuration. Company name, bot name, visual identity, language, messages, prompts, business hours, embeddings, Chatwoot, Tools, knowledge, rules, and conversations are persisted per tenant.

Providers and their API keys are global, and multiple configurations of the same type may coexist under unique names. The default `ALL` scope lets every active tenant use a configuration, while `SELECTED` requires an explicit `ProviderTenantAccess` relationship. Sharing ends at provider capacity: Commercial, Customer Support, and post-sale prompts, RAG, conversations, logs, and commercial outcomes remain isolated by `tenantId`. See [Multi-company tenant isolation](./Multi-Tenancy.md).

Only bootstrap and integration secrets remain in environment variables: database password, encryption key, administrative credentials, the master `COMMERCIAL_EVENTS_TOKEN`, n8n key, and `CHATWOOT_SECRET_KEY_BASE`. The master derives HMAC tokens bound to a tenant and is never accepted directly by the commercial endpoint. Global provider API keys, Chatwoot tokens, and Tool credentials are encrypted before storage.

## Administrative identity

Nexus is the identity and company-scope source for day-to-day access. After validating its own session, it stores only the hash of a random one-time code in KV and redirects the browser to the Admin with that code in the URL fragment. The Admin removes the fragment immediately; the Gateway redeems the claims directly from Nexus and issues its own short, revocable session. The `jti` also becomes the unique PostgreSQL session identity, preventing two concurrent redemptions from reusing the same ticket even with KV eventual consistency.

Nexus identities remain distinct from local identities in the Gateway database. Companies granted in Nexus are resolved through `Tenant.slug` and become real `AdminUserTenant` memberships; every API continues to enforce the existing authorization around `X-Tenant-Id`. `ADMIN_TOKEN` does not participate in this flow and remains an infrastructure recovery mechanism only.

## Message processing

The canonical `POST /webhooks/chatwoot/:tenantId` webhook uses the company's stable opaque ID, validates that tenant's secret, account, and one authorized inbox/channel, then accepts public incoming `message_created` events with content. The current slug remains accepted for compatibility; the identifier-less route returns `410` and never chooses a default company. It returns HTTP `202` immediately for tenant-routed events, whether accepted or ignored. Different conversations run concurrently; messages in the same tenant and conversation are serialized by an in-memory queue. External message identifiers are idempotent within a tenant.

The knowledge order is: enabled Tool, tenant RAG, and AI completion under the configured anti-fabrication rules. A conversation assigned to a human remains recorded but receives no further automatic answers.

## Persistence and services

PostgreSQL holds separate `gateway`, `chatwoot`, and `n8n` databases. pgvector is enabled in `gateway`. Redis supports Chatwoot. Migrations and bootstrap records are idempotent.

The default 384-dimensional local embedding works without Ollama. Ollama is optional, disabled by default, and only starts through the `local-ai` Compose profile.

## Optional tenant knowledge

Files uploaded in the Admin are indexed in pgvector only for the selected tenant. Private sources stay outside the repository under `<OMNICHANNEL_DATA_ROOT>\tenants\<company>`. There is no global spreadsheet or graph: every file must be deliberately imported into the correct company. A graph saved through the Admin is interpreted as conversational knowledge only when `businessRulesEnabled` is enabled; it is never executed literally.

## MVP boundaries

The queue is not distributed, and accepted background work does not survive a Gateway restart. Administrative authorization validates both the user and access to `X-Tenant-Id`; the header alone never grants access. Disabling a Nexus account prevents new logins immediately, but an already-issued Gateway session may remain valid until its short expiry. The installed Chatwoot Community edition does not provide native Nexus SSO and retains its own session. Internet exposure still requires HTTPS, credential rotation, periodic review of user/tenant relationships, and protection against webhook-secret logging.
