# Controlled continuous improvement

This phase turns real conversations into auditable quality signals without allowing the AI to edit its own prompt or publish changes automatically. The implemented cycle is:

```text
conversation
→ commercial outcome and verifiable evidence
→ human feedback and heuristic evaluation
→ redacted, versioned dataset
→ candidate prompt version
→ comparison and human approval
→ primary or canary release
→ promotion or rollback
```

The system does not train provider models. It records evidence, measures results, and controls which prompt versions may reach production.

## What is automatic and what requires approval

The Gateway schedules an evaluation after every valid response and automatically consolidates signals into a small taxonomy. It does not create one card per conversation: there is at most one card per tactic and specialty (`Intake`, `Sales`, `Customer care`, or `Technical`), and a newer evaluation updates that conversation's evidence.

By default, a behavioral tactic becomes reviewable only after at least 8 conversations, 5 distinct customers, 3 verified outcomes, 4 supporting observations, 72% confidence, and no more than 25% contradiction. Repetition without diversity or verified outcomes remains `GATHERING`.

Business facts, prices, discounts, warranties, and policies are never learned from dialogue. Those cards remain `BLOCKED_GROUNDING` until linked to an official RAG document, enabled business rule, or Tool in the same tenant. Even after approval, a value seen in dialogue is not injected: runtime must resolve the official source again.

Humans review only consolidated cards under **Continuous improvement → Consolidated candidates**. Approving a behavioral tactic activates it only for the specialty that produced the evidence; rejecting it preserves the decision history. Prompt versions are never generated or published automatically.

Datasets remain a separate workflow: `POSITIVE` and `NEGATIVE` feedback becomes `GOOD` and `BAD`, completed evaluations use a `0.70` cutoff, fingerprints remove duplicates, and common PII patterns are redacted. Prompt creation, approval, canary, and rollback remain explicit human actions.

The API requires `tenant:write` to discover, approve, or reject candidates. The authenticated session supplies the reviewer identity.

## Where to use it in the Admin

1. Sign in to Nexus and open **Communication → AI configuration**.
2. Nexus issues the administrative session automatically; use `ADMIN_TOKEN` only through the technical recovery flow.
3. Open **Continuous improvement** in the side menu. The current interface displays this label as **Melhoria contínua**.
4. Enter the conversation external ID or select a conversation from the table.

This page contains:

- commercial outcome;
- order or payment link;
- human feedback;
- automatic evaluation;
- consolidated learning candidates separated by specialty;
- datasets and versions;
- prompt versions, comparisons, approvals, canary releases, and rollback;
- outcome, evaluation, and semantic-cache metrics.

Model configuration and credentials are under **AI and providers / keys** (`IA e providers / chaves`). RAG documents are under **Knowledge / RAG** (`Conhecimento / RAG`). Provider, latency, token, cost, and log information is under **Operations** (`Operação`).

## Commercial outcome

Each conversation may have successive outcome revisions. A new revision preserves the previous record and identifies which revision it supersedes.

| State | Meaning |
| --- | --- |
| `PENDING` | There is not yet conclusive evidence of a win or loss. |
| `WON` | A positive result is confirmed, normally by a verified order or payment with a successful status. |
| `LOST` | A terminal negative outcome was confirmed or manually recorded by an authorized reviewer. |

The Admin can record a state, confidence between `0` and `1`, and evidence manually. Persuasive text, purchase intent, or a claim made by the AI must not be treated as proof of a sale.

### Order or payment link

A commerce link contains:

- kind `ORDER` or `PAYMENT`;
- source system, such as an ERP or payment gateway;
- external identifier;
- external status;
- optional value and currency;
- verification state `UNVERIFIED`, `VERIFIED`, or `REJECTED`;
- verification evidence as JSON.

A `VERIFIED` or `REJECTED` link requires non-empty evidence. Tenant, kind, source, and external identifier form a unique key, and the same external record cannot be linked to two conversations.

When a link is received or updated, the Gateway reconciles the outcome:

- any verified link with a status such as `paid`, `approved`, `captured`, `completed`, `delivered`, or `success` produces `WON`;
- if every verified link has a terminal status such as `cancelled`, `declined`, `expired`, `failed`, `refunded`, or `lost`, the result is `LOST`;
- every other case remains `PENDING`.

Reconciliation runs when an event is submitted to the Gateway. The Gateway does not poll an ERP or payment gateway by itself; the external system must publish each status change.

## Human feedback

Feedback may target the entire conversation or a specific AI message. It records:

- verdict `POSITIVE`, `NEGATIVE`, or `NEUTRAL`;
- optional integer score from `-100` to `100`;
- comment;
- expected response;
- reviewer ID and source.

When a dataset is materialized, negative feedback becomes a bad example and positive feedback becomes a good example, preserving the expected response and rationale when supplied. Neutral feedback remains auditable but is not artificially labeled `GOOD` or `BAD` and does not enter the dataset.

## Automatic evaluator

The current evaluator is `deterministic-conversation-rubric` version `1.0.0`. It is heuristic and deterministic: it does not call another LLM, incurs no provider cost, and returns the same result for the same data snapshot.

It considers:

| Dimension | Weight |
| --- | ---: |
| Coverage of customer messages | 22% |
| Commercial outcome | 22% |
| Human satisfaction | 18% |
| Outcome evidence | 14% |
| Engagement and turn balance | 12% |
| Response concision | 12% |

The evaluation stores the evaluator version, message IDs, outcome revision, feedback count, verified-link count, final score, dimensions, evidence, and recommendations.

It does not independently verify factual correctness, confirm payments, or change prompts. Its recommendations are inputs for human review.

A valid provider response schedules evaluation after delivery, outside the Chatwoot critical path. Operational provider failures are not attributed to a prompt. Commercial outcomes, order/payment links, and human feedback also trigger a new evaluation so the score reflects current evidence. If a conversation spans different prompt versions, its conversation-level evaluation is not credited to only one version.

## Redacted and versioned dataset

**Materialize dataset** creates a `DRAFT` version from positive/negative feedback and every available completed evaluation. Evaluations scoring at least `0.70` receive `GOOD`; lower scores receive `BAD`. Each example has input, response, expected response, rationale, source, fingerprint, and internal lineage.

Before reusable text is persisted, the Gateway replaces common patterns for:

- email;
- Brazilian CPF;
- Brazilian CNPJ;
- card number;
- phone number.

Values are replaced by markers such as `<EMAIL>` and `<PHONE>`; raw identifiers or reversible hashes are not used as substitutes. The internal relationship with the conversation, feedback, or evaluation is retained for auditing.

Automatic redaction does not recognize every proper name, address, or domain-specific identifier. Review examples before publishing or exporting a dataset.

Version rules:

- only a `DRAFT` version can receive examples;
- fingerprints remove duplicates within a version;
- the checksum changes deterministically with its examples;
- publishing requires at least one example;
- the new version becomes `PUBLISHED`, and the formerly published version becomes `ARCHIVED`;
- published versions are not edited.

Publishing a dataset does not modify the prompt or AI behavior. It creates an auditable, versioned artifact; the current evaluator and prompt comparison do not consume it automatically.

## Prompts: approval, canary, and rollback

The versioned conversational prompt is the `assistant-bundle`, containing:

- `system`;
- `commercial`;
- `support`;
- `postSale`.

The safe workflow is:

1. create a candidate version;
2. compare candidate and baseline;
3. review differences and metrics;
4. explicitly approve the version;
5. release it as primary or canary;
6. promote the canary or roll back.

A comparison records changed fields, lengths, and hashes, plus the count and average of existing evaluations linked to each version. It does not by itself run a new test over every dataset conversation.

Only `APPROVED` versions can enter a release. For a canary, a deterministic SHA-256 bucket based on tenant, prompt definition, and conversation external ID selects the version. The same conversation therefore stays on the same variant while that release remains active.

The promotion endpoint makes the current canary the primary version. Rollback ends the current release and creates another one pointing to a previously approved or explicitly selected version. The current Admin page supports creation, comparison, approval, release, and rollback; explicit canary promotion is currently API-only.

The selected version is recorded on messages and logs, making it possible to relate evaluations and outcomes to the prompt that generated each response.

## RAG performance

Retrieval remains tenant-isolated:

```text
question
→ embedding
→ valid semantic cache?
→ pgvector candidates
→ hybrid reranker
→ excerpts sent to the active provider or fallback
```

### Semantic cache

The cache is keyed by tenant, namespace, corpus version, retrieval parameters, and embedding-configuration fingerprint. By default it:

- is enabled;
- expires after 15 minutes;
- requires a minimum similarity of `0.96`;
- ignores expired entries;
- removes expired or stale-version entries when writing a new item.

Importing, updating, reindexing, or deleting knowledge increments the corpus version through a database trigger. An entry from an earlier version is never returned.

The raw customer question is not persisted in the cache. Only its SHA-256, embedding, retrieved excerpts, usage metrics, and expiry are stored. `AiLog` records `cacheHit` and the RAG sources used.

Optional environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RAG_CACHE_ENABLED` | `true` | Set to `false` to disable the cache. |
| `RAG_CACHE_TTL_SECONDS` | `900` | TTL, clamped from 30 to 86,400 seconds. |
| `RAG_CACHE_MIN_SCORE` | `0.96` | Minimum cache similarity, clamped from `0.8` to `1`. |
| `RAG_RERANK_CANDIDATE_MULTIPLIER` | `4` | Candidates per requested result, clamped from `1` to `10`. |

### Reranker

The vector search retrieves additional candidates and applies a deterministic reranker. Its score combines:

- 72% vector similarity;
- 28% lexical coverage, title terms, bigrams, and exact phrase.

This promotes product codes, product names, and policy terms without discarding semantic relevance. Ties preserve original order, making results reproducible.

### HNSW

The embeddings in `KnowledgeDocument` and `SemanticCacheEntry` have cosine-distance HNSW indexes. If the installed pgvector version does not support HNSW, the migration retains the existing exact vector scan instead of preventing startup.

## Current endpoints

Tenant-scoped administrative endpoints and `/v1/chat/completions` require:

```http
Authorization: Bearer YOUR_ADMIN_TOKEN
X-Tenant-Id: OPAQUE_TENANT_ID
```

Global routes such as tenant, user, and provider management do not use `X-Tenant-Id`. A `PLATFORM_ADMIN`, however, must send the header on every tenant-scoped route.

The environment `COMMERCIAL_EVENTS_TOKEN` is a master credential and is never accepted directly by `POST /v1/commercial/events`. A `PLATFORM_ADMIN` first obtains the token derived for the company:

```http
GET /admin/integrations/commercial-events-token
Authorization: Bearer YOUR_ADMIN_TOKEN
X-Tenant-Id: OPAQUE_TENANT_ID
```

The integration uses the returned `token` field:

```http
Authorization: Bearer commercial.v1.OPAQUE_TENANT_ID.SIGNATURE
X-Tenant-Id: OPAQUE_TENANT_ID
```

The **Start system** option in `Omnichannel.bat` generates the master `COMMERCIAL_EVENTS_TOKEN` in `omnichannel-data/config/platform.env` without replacing existing secrets. Do not reuse or distribute the administrative token or master credential to an ERP, payment system, or automation. The derived token is HMAC-signed, works only with the same `X-Tenant-Id`, and grants no Admin access. Rotating the master credential invalidates every derived token.

| Method and path | Purpose |
| --- | --- |
| `GET /admin/integrations/commercial-events-token` | Returns the selected tenant's derived commercial credential to a `PLATFORM_ADMIN`. |
| `POST /v1/commercial/events` | Accepts `conversationExternalId` plus an `ORDER` or `PAYMENT` event, updates its link, and reconciles the outcome. |
| `GET /admin/improvement/summary` | Returns metrics, conversations, outcomes, links, feedback, evaluations, datasets, prompts, and cache information. |
| `PUT /admin/conversations/:externalId/outcome` | Creates a manual `PENDING`, `WON`, or `LOST` revision. |
| `POST /admin/conversations/:externalId/commerce-links` | Creates or updates an order/payment link and reconciles the outcome. |
| `POST /admin/conversations/:externalId/feedback` | Records human feedback for a conversation or message. |
| `POST /admin/conversations/:externalId/evaluate` | Runs and persists the heuristic evaluation. |
| `GET /admin/learning/candidates` | Lists the consolidated review queue and approved guidance. |
| `POST /admin/learning/discover` | Consolidates new evaluations without creating one card per conversation. |
| `POST /admin/learning/candidates/review` | Approves, rejects, or reopens candidates in a batch. |
| `POST /admin/learning/candidates/:id/ground` | Attaches and validates official sources for a fact or offer. |
| `POST /admin/datasets/materialize` | Creates a draft version and materializes eligible feedback and evaluations. |
| `POST /admin/datasets/:datasetId/versions/:versionId/publish` | Publishes a non-empty version and archives the former one. |
| `GET /admin/prompts` | Lists the definition, versions, releases, comparisons, and current bundle. |
| `POST /admin/prompts/versions` | Creates a candidate prompt version. |
| `POST /admin/prompts/versions/:id/approve` | Approves a candidate version. |
| `POST /admin/prompts/compare` | Stores the diff and metrics for a baseline and candidate. |
| `POST /admin/prompts/release` | Publishes a primary or canary release using approved versions. |
| `POST /admin/prompts/promote` | Promotes the active canary to primary. |
| `POST /admin/prompts/rollback` | Restores a formerly approved or selected version. |
| `GET /admin/rag/documents` | Lists documents, chunks, embeddings, and indexing state. |
| `POST /admin/rag/import` | Imports and indexes a supported file. |
| `POST /admin/rag/reindex` | Rebuilds embeddings for the tenant or selected document. |
| `DELETE /admin/rag/documents/:source/:externalId` | Deletes a document and invalidates the corpus. |

Example verified event:

```json
{
  "conversationExternalId": "12345",
  "kind": "PAYMENT",
  "source": "payment-gateway",
  "externalId": "pay_987",
  "status": "paid",
  "value": 199.9,
  "currency": "BRL",
  "verificationStatus": "VERIFIED",
  "verificationEvidence": {
    "transactionId": "pay_987",
    "checkedAt": "2026-07-28T15:00:00Z"
  }
}
```

## Keys and operational security

In the Admin, open **AI and providers / keys**, fill in **API key**, save, and test the provider. The key:

- is sent only to the authenticated Gateway;
- is encrypted with `GATEWAY_ENCRYPTION_KEY`;
- is stored in a global configuration persisted in PostgreSQL; multiple configurations of the same type may coexist with different names and scopes;
- survives restarts and rebuilds when volumes are retained;
- is never returned by APIs or displayed again by the Admin.

Never put provider keys in Git, HTML/JavaScript, Cloudflare Pages, or any other frontend. Cloudflare Pages publishes assets to browsers and is not a secret vault.

For an online production deployment:

- host the Gateway behind HTTPS;
- use persistent, backed-up PostgreSQL;
- inject `ADMIN_TOKEN`, the master `COMMERCIAL_EVENTS_TOKEN`, `GATEWAY_ENCRYPTION_KEY`, and database credentials through the backend hosting secret manager;
- distribute only the commercial token derived for the corresponding tenant to each integration;
- keep `GATEWAY_ENCRYPTION_KEY` stable, because replacing it makes stored provider keys undecipherable;
- do not expose `ADMIN_TOKEN` in links, logs, or public frontend code.

The Admin keeps its session token only in page memory. Reloading or closing the tab requires entering it again.

## Intentional limits

- No model is trained automatically.
- Evaluations and datasets do not edit or publish prompts.
- Conversation text is not proof of a sale without a commerce event or human review.
- PII redaction reduces risk but does not replace privacy review.
- The cache accelerates retrieval; it does not change the RAG source of truth.
