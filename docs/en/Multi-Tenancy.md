# Multi-company tenant isolation

The platform uses one Gateway and one Admin to serve multiple companies. Sharing is deliberately narrow:

- provider configuration and keys are global, with access controlled by scope;
- identity, Chatwoot, RAG, rules, prompts, conversations, logs, and commercial data remain private to each tenant;
- an administrative user can select only tenants for which explicit access was granted.

`ALL` means sharing AI capacity, not sharing company data.

## Identifiers

Each tenant has:

- an opaque ID, used by the Admin and authenticated APIs through `X-Tenant-Id`;
- a human-readable, mutable slug retained as a compatibility route for Chatwoot webhooks;
- an active or inactive state;
- its own configuration, relationships, and credentials for isolated resources.

## Initial bot registration

In the Admin, **Bots / companies** is the tenant-management view. Company name and bot name are separate fields, and the top selector displays both. Registration may start without integrations:

```http
POST /admin/tenants
Content-Type: application/json

{
  "name": "Company Alpha",
  "botName": "Alpha Support",
  "slug": "company-alpha",
  "deferIntegrations": true
}
```

`deferIntegrations: true` only prevents the mandatory Wizard from opening before channels exist. The Gateway creates an identity and empty prompts for the new tenant, keeps rules and Tools disabled, and creates no Chatwoot integration, webhook, document, or chunk. Providers scoped `ALL` are available as shared capacity; a `SELECTED` provider still requires an explicit relationship.

The same field may be sent to `PUT /admin/tenants/:id`. This changes its name, bot, and onboarding state while preserving existing tenant data. A clean installation has no technical or default tenant; the first real company is registered through `POST`.

The base prompt receives the selected company dynamically. Business scope, products, policies, and tone must come from that tenant's prompts, rules, Tools, or RAG; one tenant's instructions are never reused for another.

Do not derive IDs, use company names as authorization, or accept a browser-provided slug in place of the opaque ID.

## Resolution and authorization

### Admin and administrative APIs

A tenant-aware request uses:

```http
Authorization: Bearer ADMINISTRATIVE_CREDENTIAL
X-Tenant-Id: OPAQUE_TENANT_ID
```

The header selects context but does not grant access. `AdminAuthService` first authenticates the user and then verifies the user's tenant relationship.

A `PLATFORM_ADMIN` must send `X-Tenant-Id` on every tenant-scoped route; the backend does not silently fall back to `DEFAULT_TENANT`. For a `TENANT_USER` with exactly one active membership, the API may infer that sole company when the header is omitted. With two or more memberships, the header is also required. The Admin sends it explicitly in both cases.

An unknown, inactive, or unauthorized ID is denied by default.

Global provider-management routes require global administrative permission. Authorization for one tenant does not authorize changing a shared key.

### Commercial events

`COMMERCIAL_EVENTS_TOKEN` is a backend master credential. It is never accepted directly by `POST /v1/commercial/events` and must not be distributed to an ERP, payment gateway, or automation.

A `PLATFORM_ADMIN` obtains a credential derived for the selected company:

```http
GET /admin/integrations/commercial-events-token
Authorization: Bearer ADMINISTRATIVE_CREDENTIAL
X-Tenant-Id: OPAQUE_TENANT_ID
```

The response contains a deterministic HMAC-signed token bound to that tenant ID. The integration sends this value with the same header:

```http
POST /v1/commercial/events
Authorization: Bearer commercial.v1.OPAQUE_TENANT_ID.SIGNATURE
X-Tenant-Id: OPAQUE_TENANT_ID
```

A token derived for A fails with `X-Tenant-Id: B`, grants no Admin access, and can locate conversations or create orders, payments, and outcomes only within A. Rotating the master credential invalidates every derived token.

### Chatwoot webhook

The canonical route is:

```text
POST /webhooks/chatwoot/:tenantId
```

The connection test registers a URL based on the tenant's opaque, immutable ID. Renaming a company or changing its slug therefore does not interrupt the webhook. The Gateway validates that tenant's secret, account, and one of its authorized inboxes before reading or writing a conversation.

Each Chatwoot channel has its own technical inbox: WhatsApp, Instagram, Facebook, Website, and API cannot physically share one inbox. In the Admin, each company registers its Chatwoot account and the list of all those Inbox IDs. The Gateway treats that list as one operation, always replies in the originating conversation and channel, and continues to isolate data by tenant. The customer does not select a tenant: the receiving channel determines the inbox, and the pre-registered webhook determines the company. Events from another account or inbox are ignored.

Department and platform are separate concepts. The Admin maps `commercial`, `support`, and `postSale` to Chatwoot teams and optional assignees. The Gateway detects only explicit signals, persists the department in conversation memory, and uses the specific route on human handoff; the default team and assignee remain a fallback. Agents can therefore work in Commercial, Customer Support, or Post-sale without duplicating the operation by platform.

The same handler still recognizes the current slug and legacy webhook names for compatibility and reconciles them on the next test. The identifier-less `POST /webhooks/chatwoot` route returns `410 tenant_route_required`; it never selects `DEFAULT_TENANT`.

## Global providers

Each provider record is a global configuration with a unique name. Multiple records of the same type may coexist with different keys, models, priorities, and scopes. For example, a shared Cloudflare credential and another restricted to Company Alpha can coexist.

Model, endpoint, priority, timeout, costs, and API key belong to the global record; there is no tenant-local copy or override.

`ProviderAccessService` filters providers before fallback:

| Scope | Rule |
| --- | --- |
| `ALL` | Available to every active tenant. |
| `SELECTED` | Available only to tenants present in `ProviderTenantAccess`. With no explicit relationship, access is denied. |

Additional rules:

- a disabled provider never participates;
- an inactive tenant receives no provider, including one scoped `ALL`;
- only accessible providers enter priority and fallback selection;
- having no accessible provider produces an explicit failure, never borrowing another tenant's credential;
- encrypted keys are never returned to users or the frontend;
- usage, cost, and logs remain attributed to the tenant that made the call.

If more than one configuration of the same type is accessible to a tenant, all of them enter global priority ordering. There is no precedence between local and global configuration because local provider overrides are not part of this phase.

## Isolated data

| Domain | Required isolation |
| --- | --- |
| Identity and settings | Name, branding, messages, hours, Tools, and preferences belong to the tenant. |
| Chatwoot | URL, account, inbox/channel list, token, webhook secret, team, and assignee are tenant-exclusive. |
| RAG | Documents, chunks, embeddings, corpus version, and semantic cache always include `tenantId`. |
| Business rules | Conversational rules and `bot.json` interpretation are loaded in tenant context. |
| Prompts | Bot identity and Commercial, Customer Support, and post-sale instructions, plus definitions, versions, approvals, comparisons, canaries, and rollbacks, belong to the tenant. |
| Conversations and memory | External IDs are unique only within a tenant; messages, state, and summaries never cross the boundary. |
| Commerce | Outcomes, orders, payments, feedback, evaluations, and datasets are filtered by tenant. |
| Observability | Logs, costs, RAG sources, provider, and prompt version remain attributed to the tenant. |

A shared physical index such as HNSW does not change logical isolation: pgvector and cache queries require `tenantId`.

## Users and company switching

User access is an explicit relationship with tenants. When the Admin switches companies:

1. the frontend sends the opaque ID in `X-Tenant-Id`;
2. the backend validates the relationship again;
3. queries and mutations use only that tenant;
4. data from the former company is discarded from page state.

Manually changing the header does not expand permission. The backend does not trust a tenant supplied in a JSON body when context has already been resolved from the header.

Current roles:

| Role | Access |
| --- | --- |
| `PLATFORM_ADMIN` | Global administration, users, tenants, and providers; may select any active tenant. |
| `TENANT_USER` | Read and write access only for active tenants present in `AdminUserTenant`. At least one membership is required. |

Administrative passwords use scrypt and require at least 12 characters. Sessions are signed, persisted only by token hash, expire, and can be revoked; changing a password or disabling a user revokes existing sessions.

## Required scenario matrix

This matrix is the test specification for resolution and isolation:

| Scenario | Expected result |
| --- | --- |
| User with access to A sends `X-Tenant-Id: A` | Allowed; response contains only A data. |
| User with access only to A sends `X-Tenant-Id: B` | Denied even when B exists. |
| `PLATFORM_ADMIN` omits the header on a tenant-aware route | Denied; never use `DEFAULT_TENANT`. |
| `TENANT_USER` omits the header and has one active membership | The sole membership may be inferred. |
| `TENANT_USER` omits the header and has multiple memberships | Denied; explicit selection is required. |
| Unknown ID or inactive tenant | Denied without revealing configuration or existence details. |
| Enabled `ALL` provider and active tenant A | Provider is available to A. |
| `SELECTED` provider with an A relationship | Provider is available to A. |
| `SELECTED` provider without a B relationship | Provider is excluded from B's fallback. |
| Disabled provider with any scope | Provider is unavailable. |
| Inactive tenant and `ALL` provider | Provider is unavailable. |
| A has a RAG document and B asks the same term | B receives no A document, cache entry, or corpus version. |
| A and B use the same external conversation ID | Two independent conversations exist. |
| A order references a B internal conversation | Denied as nonexistent in A context. |
| Webhook `/chatwoot/A_ID` with A secret | Allowed when the account and one authorized inbox also match. |
| Webhook `/chatwoot/A_ID` with B secret | Denied without trying B. |
| Webhook using A's current slug | Accepted for compatibility and reconciled to the ID route on the next test. |
| Route without an ID/slug | Rejected with `410`; the Gateway never selects a default company. |
| Token derived for A with `X-Tenant-Id: A` | Event is limited to A conversations and commerce data. |
| Token derived for A with `X-Tenant-Id: B` | Denied. |
| Master credential sent directly to `/v1/commercial/events` | Denied. |
| Commercial token used on `/admin/*` | Denied. |
| Tenant user attempts to read a global key | API returns configuration state only, never the key. |

## Implementation invariants

- Resolve the tenant once per request and pass its ID instead of looking up a default tenant inside every service.
- Every isolated read, update, delete, and upsert includes `tenantId`.
- Conversation, message, prompt, dataset, order, and payment IDs are validated together with the tenant.
- `SELECTED` is an explicit allowlist with default-deny behavior.
- Cache, queue, and lock keys include tenant and conversation.
- Security logs record decisions and technical identifiers but not secrets.
- Error responses include no keys, tokens, other-tenant configuration, or unauthorized tenant lists.

## Credential security

Global API keys are encrypted with `GATEWAY_ENCRYPTION_KEY` and persisted in PostgreSQL. `ALL` and `SELECTED` control backend use of each configuration; neither scope delivers a key value to a tenant.

Never store keys in Cloudflare Pages, JavaScript, Git, or browser-visible headers. In production, use HTTPS, backed-up PostgreSQL, and a backend secret manager for `ADMIN_TOKEN`, the master `COMMERCIAL_EVENTS_TOKEN`, `GATEWAY_ENCRYPTION_KEY`, and infrastructure credentials. Distribute only the commercial token derived for the corresponding tenant.

## Manual validation checklist

1. Create two active tenants, A and B, plus users with different access.
2. Register one `ALL` provider and another — including one of the same type — with `SELECTED` access only for A.
3. Confirm A fallback includes both while B includes only the first.
4. Import different knowledge and send the same question to each tenant.
5. Configure different accounts and inbox lists for A and B; validate each company's WhatsApp, Instagram, and Website channels through its stable ID route and secret.
6. Create conversations with the same external ID and confirm independent state.
7. Obtain A's derived commercial token, send an event to A, and confirm that token is rejected for B.
8. Change the header to an unauthorized tenant and confirm denial.
