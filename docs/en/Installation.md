# Installation

## Recommended Windows flow

1. Run `Omnichannel.bat` and select **Start system**. On first use it automatically finds or creates `omnichannel-data` beside the repository, migrates any old `.env` into `omnichannel-data/config/platform.env`, creates missing secrets, starts Docker Desktop when necessary, builds the stack, and waits for service health.
2. Preserve the generated `GATEWAY_ENCRYPTION_KEY`: it must remain stable after credentials have been stored. `ADMIN_TOKEN` also remains in `config/platform.env`, but only as a backend bootstrap and recovery secret; the script neither displays it nor places it in a URL.
3. Complete onboarding at `http://localhost:3000` and create the Chatwoot inboxes/channels that belong to the first company.
4. Sign in to Nexus and open **Communication → AI configuration**. If the Nexus session is valid and the user has Omnichannel access, the Admin login completes automatically. Create or select the bot under **Bots / companies**.
5. For an operation whose channels already exist, complete the Wizard, save, and test Chatwoot. To prepare a company that has no channel yet, keep **Start without Chatwoot and knowledge** selected; identity and prompts remain editable without inventing an inbox, webhook, or RAG corpus.
6. Under **AI and providers / keys**, register global credentials. The default `ALL` scope serves every company; use `SELECTED` for one or more specific companies. Multiple credentials of the same type are allowed when they have unique names.
7. Select the correct company and open **Knowledge / RAG** to import manually only the documents that belong to it.

After the Wizard, both settings remain available in the Admin side menu. In a multi-company installation, the Admin sends the selected tenant through `X-Tenant-Id`; the backend verifies the user's access before loading any data:

- **AI and providers / keys**: authorized administrators enable global providers, enter credentials, select scope `ALL` or `SELECTED`, order fallback, save, and test;
- **Knowledge / RAG**: import a spreadsheet or another document only into the selected tenant, index it, and inspect chunks, embeddings, and status;
- **Identity**, **Operations / rules**, and **Chatwoot**: configure each company's Commercial, Customer Support, and post-sale prompts, rules, and list of inboxes/channels.

Onboarding does not automatically copy any file from the private folder into new tenants. Import is always a deliberate action under **Knowledge / RAG**, preventing one company's knowledge from being indexed into another.

The **Active bot / company** selector determines the entire context edited in the Admin. **Identity** changes that bot's name, branding, and messages; **AI and providers / keys** changes prompts only for the selected company. Shared guardrails use only the active tenant's name and sources.

AI keys registered through the Admin are encrypted in PostgreSQL and remain stored across restarts. They do not need to be copied into the repository. `omnichannel-data/config/platform.env` holds infrastructure secrets and must retain the same `GATEWAY_ENCRYPTION_KEY`.

## Centralized access through Nexus

The normal flow never asks for `ADMIN_TOKEN`, a local Gateway password, or a provider credential. Nexus generates a random, one-time code valid for at most 60 seconds. The Gateway redeems that code directly with the Nexus backend, creates or updates the linked identity, and issues a revocable session limited to the companies assigned to that user. The code travels only in the URL fragment and is removed before redemption.

In Nexus, **Registered users** controls whether a user has Omnichannel access and which companies they may access. Users without that grant cannot obtain a Gateway session. `ADMIN_TOKEN` remains available only under the collapsed **Technical access / recovery** section of the local Admin.

The **Chatwoot service** link is also centralized in Nexus and requires an authorized Nexus session before revealing the active destination. The Chatwoot Community edition used by this Compose stack, however, does not provide native SSO with Nexus: on first use, the operator must still authenticate in Chatwoot itself. An existing Chatwoot session is reused normally.

For a manual startup, first copy `.env.example` to `<OMNICHANNEL_DATA_ROOT>/config/platform.env`, replace every `replace-with-*` value, and keep the encryption key stable:

```powershell
docker compose up --build -d
docker compose ps -a
Invoke-RestMethod http://localhost:3001/health
```

One-shot services `postgres-init`, `gateway-migrate`, and `chatwoot-migrate` must exit with code `0`. Long-running services must be healthy or running.

## Local addresses

- Chatwoot: `http://localhost:3000`
- AI Gateway: `http://localhost:3001/health`
- Admin: `http://localhost:3002`
- n8n: `http://localhost:5678`

## Chatwoot webhook

After onboarding, configure the internal URL, account, inbox/channel list, API token, default team, and the optional Commercial, Support, and Post-sale routes in the Admin. Each platform needs its own technical Chatwoot inbox, but all Inbox IDs for that company live in the same configuration and are presented to agents as one operation. Saving and testing makes the Gateway create or update the `AI Gateway` webhook automatically, subscribe it to `message_created`, and protect its URL with a random tenant-encrypted secret. Its internal base URL is:

```text
http://gateway:3001/webhooks/chatwoot/OPAQUE_TENANT_ID
```

The opaque ID remains stable when the company name or slug changes. The current slug remains accepted for compatibility, while the test registers and reconciles the canonical ID-based URL. That company's secret authenticates the event, and the account plus one configured inbox/channel must also match. The route without an identifier is rejected: the Gateway never selects `DEFAULT_TENANT` for a message. Do not copy the URL secret or register a duplicate webhook manually. In production, expose the endpoint over HTTPS and keep secrets out of proxy logs.

`http://gateway:3001` is internal to the Docker network and is the correct setting while Chatwoot and Gateway run in the same Compose project. A Cloudflare Pages site cannot forward requests to your computer's `localhost`. For remote operation, publish Chatwoot and Gateway over HTTPS through a stable domain and Cloudflare Tunnel; do not use a Quick Tunnel as a permanent address.

## Commercial event token

`COMMERCIAL_EVENTS_TOKEN` in `config/platform.env` is only the Gateway master credential and must never be distributed to an integration. With a company selected, a `PLATFORM_ADMIN` obtains its derived token:

```http
GET /admin/integrations/commercial-events-token
Authorization: Bearer ADMINISTRATIVE_CREDENTIAL
X-Tenant-Id: OPAQUE_TENANT_ID
```

The ERP or payment gateway sends the returned `token` field to `POST /v1/commercial/events`, always with the same `X-Tenant-Id`. A credential derived for one company is rejected for every other company.

## Commands and tests

```powershell
npm ci
npm test -w @omnichannel/gateway
docker compose config --quiet
```

Use the single `Omnichannel.bat` menu to start, stop, restart, update, and run auxiliary configuration. Ollama is not required and is not started by the default command.
