# Deployment

The bundled Compose environment targets development and controlled staging. The standard command does not start Ollama:

```powershell
docker compose up --build -d
```

## Production checklist

- Store strong database, Gateway, Admin, n8n, and Chatwoot secrets outside source control.
- Keep the Gateway encryption key stable and backed up.
- Keep global provider API keys encrypted in PostgreSQL; review every named configuration by type, priority, `ALL` scope, or `SELECTED` relationships, and never embed keys in the static Admin, Cloudflare Pages, or any frontend bundle.
- Publish Chatwoot, Admin, and Gateway behind TLS and an authenticated reverse proxy.
- With Cloudflare, use a managed domain and a Named Tunnel with a stable hostname. Cloudflare Pages can host the static Nexus frontend but cannot reach the computer's `localhost`; Quick Tunnels are test-only and change address.
- Do not expose PostgreSQL, Redis, or an optional Ollama instance publicly.
- Use centralized Nexus login for the Admin, protect the Nexus account itself with appropriate controls, and periodically review each user's `omnichannelAccess` and company grants. Keep `ADMIN_TOKEN` only in the backend secret manager, never in a URL or frontend.
- Do not confuse the protected link with Chatwoot SSO. In the Community edition, Chatwoot keeps its own authentication; mandatory SSO requires a compatible edition/feature or a planned shared OAuth provider.
- Require `X-Tenant-Id` from `PLATFORM_ADMIN` on every tenant-scoped route and never treat the header alone as authorization.
- Keep `COMMERCIAL_EVENTS_TOKEN` only in the backend secret manager; give integrations only tenant-derived tokens.
- Preserve one webhook secret per tenant, use the stable opaque-ID canonical route, retain slug compatibility, rotate secrets when needed, use HTTPS, and prevent proxies from logging secrets.
- Add tested backup and restore procedures for PostgreSQL and persistent volumes.
- Run cross-tenant isolation tests with at least two tenants before each release.
- Centralize logs, metrics, traces, and alerts for provider, RAG, Tool, and delivery failures.

## Scaling

One Gateway instance processes different conversations concurrently and serializes each conversation locally. Multiple replicas require a distributed queue and lock/idempotency coordination. A restart can interrupt a task that already returned HTTP `202`.

The `local-ai` profile is an optional future deployment choice. It requires explicit model downloads and separately planned CPU/GPU, storage, and private networking.
