# AI providers

Built-in adapters implement the same `AiProvider` contract with `health` and `complete`: Cloudflare AI, OpenRouter, Google Gemini, and optional Ollama. The Admin can also register OpenAI-compatible providers by supplying a name, endpoint, health path, API key, model, priority, timeout, and generation settings.

Configurations and credentials are global, but there is no one-credential-per-type limit. For example, a shared Cloudflare credential and another Cloudflare credential dedicated to one company may coexist, provided that each configuration has a unique name.

The default `ALL` scope makes a configuration available to every active tenant, including companies created later. `SELECTED` allows only tenants associated through `ProviderTenantAccess`; without an explicit relationship, use is denied. There are no tenant-local copies or overrides: selection is made among the global configurations that the tenant may access.

Keys are encrypted before storage and never returned by administrative APIs. For each tenant, only enabled providers allowed by scope enter ascending-priority selection; health or completion failure advances to the next accessible provider. See [Multi-company tenant isolation](./Multi-Tenancy.md).

## Where to register an API key

1. Sign in to Nexus and open **Communication → AI configuration**. The Admin login completes without exposing `ADMIN_TOKEN`; `http://localhost:3002` remains a technical recovery address.
2. In the side menu, open **AI and providers / keys** (the current interface is displayed in Portuguese as **IA e providers / chaves**).
3. In **Providers, API keys, and fallback**, edit an existing configuration or create another credential, even if one of the same type already exists.
4. Use a unique name, enable the configuration, and set its priority, model, Base URL, parameters, and timeout.
5. Select `ALL` — the default — or `SELECTED`; for the latter, explicitly choose the authorized tenants.
6. Enter the credential in **API key** and click **Save**.
7. Click **Test**. Its state must become `healthy`.

The lowest priority number is tried first. Priorities `1`, `2`, and `3`, for example, create a primary → first fallback → second fallback sequence. Before routing, the Gateway removes disabled configurations and configurations outside the tenant's scope. If two credentials of the same type are accessible, both may participate according to priority. Fallback is sequential: a slow provider is abandoned only after its timeout expires or it returns a handled failure.

The key field becomes empty after saving for security. This does not mean that the stored credential was lost.

### Cloudflare Workers AI

Cloudflare requires two distinct values:

- an API token with **Workers AI Read** and **Workers AI Edit** permissions;
- the **Account ID** displayed in the Cloudflare dashboard.

Build the Base URL by replacing the identifier in:

```text
https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1
```

The Account ID is part of the URL and does not replace the token. `YOUR_ACCOUNT_ID` is only a placeholder and must not be saved or tested literally.

## Where to obtain credentials with a free allowance

Use only official portals. The key itself has no cost; each provider defines quotas, models, regional availability, and usage limits:

- **Cloudflare Workers AI:** create the token under [API Tokens](https://dash.cloudflare.com/profile/api-tokens) and check the [current free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/). Set priority `1`.
- **OpenRouter:** create a key under [OpenRouter Keys](https://openrouter.ai/settings/keys), use `openrouter/free`, and review the [free router limitations](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground). Set priority `2`.
- **Google Gemini:** create a key in [Google AI Studio](https://aistudio.google.com/apikey), then review the [API key documentation](https://ai.google.dev/gemini-api/docs/api-key) and the selected model's free quota. Set priority `3`.

Free allowances are suitable for testing and low volume, but may throttle requests or become temporarily unavailable. The Gateway advances to the next provider only when the current attempt fails or exceeds its configured timeout.

## Key persistence and security

Provider API keys do not need to be stored in an environment file. The Gateway encrypts them with `GATEWAY_ENCRYPTION_KEY` and stores the global configuration in PostgreSQL. The portable state under `omnichannel-data` preserves those credentials across restarts and installation migrations.

- keep `GATEWAY_ENCRYPTION_KEY` stable and backed up; replacing it prevents existing credentials from being decrypted;
- back up PostgreSQL and its volumes;
- `docker compose down -v` deletes local volumes and therefore the persisted data;
- never put API keys in Git, JavaScript, the Admin HTML, or any frontend;
- do not store AI keys in Cloudflare Pages: Pages delivers assets to the browser and is not a secret vault;
- for an online deployment, publish the Gateway with persistent PostgreSQL and TLS; the Admin sends the key only to the authenticated Gateway.

The private `omnichannel-data/config/platform.env` file stores infrastructure secrets such as `GATEWAY_ENCRYPTION_KEY`, database credentials, and administrative credentials. It is not part of the repository. A hosting secret manager can inject those backend values in production, while global provider credentials remain managed by authorized Admin users and stored encrypted in the database.

## Connection checks

- Cloudflare queries account models.
- OpenRouter validates the key through `/key`.
- Gemini reads the configured model.
- Ollama reads `/api/tags` and requires the selected model.
- Generic OpenAI-compatible providers use their configured health path and `/chat/completions` contract.

## Usage and cost

The selected provider, model, attempted fallbacks, latency, tokens, Tools, errors, and estimated cost are logged and attributed to the requesting tenant. Cost comes from the provider when available or from the per-million-token rates configured in the Admin.

Ollama remains disabled and absent from the standard stack. An external instance can be configured directly, or the optional service can be started with `docker compose --profile local-ai up -d ollama`.
