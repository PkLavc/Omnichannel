# Historical conversation import

The importer streams NDJSON/JSONL files, including `.gz`. It is intended for large archives: only one batch is kept in memory, each decompressed line has a hard limit, and progress is reported periodically.

## Before importing

- keep an immutable copy of the source archive;
- put exactly one conversation JSON object on each line — whole JSON arrays are not supported;
- select the tenant explicitly; the command never falls back to a default company;
- run with `--dry-run` first;
- prefer stable external identifiers for conversations and messages.

With Docker, a file stored under the private root as `imports/conversations.jsonl.gz` is available as `/private-data/imports/conversations.jsonl.gz`:

```powershell
docker compose exec gateway node dist/cli/import-conversations.js `
  --tenant company-alpha `
  --file /private-data/imports/conversations.jsonl.gz `
  --source chatwoot-export-2026 `
  --dry-run
```

Remove `--dry-run` only after reviewing the statistics. The operation is idempotent by conversation `tenant + externalId` and message `conversation + externalId`. Messages without an ID receive a deterministic ID based on their position and content.

## Canonical format

```json
{"externalId":"conversation-123","status":"resolved","contactId":"contact-9","messages":[{"externalId":"message-1","role":"user","content":"Where is my order?","createdAt":"2026-08-01T10:00:00Z"},{"externalId":"message-2","role":"assistant","content":"I will check it.","createdAt":"2026-08-01T10:00:02Z"}]}
```

Common Chatwoot export fields are also recognized:

- conversation: `externalId`, `external_id`, `id`, or `display_id`;
- messages: `messages`;
- message: `externalId`, `external_id`, or `id`;
- direction: `role`, `message_type`, and `sender_type`;
- text/date: `content`, `text`, `body`, `created_at`, or `timestamp`;
- contact: `contactId`, `customerId`, `sender.id`, or `meta.sender.id`.

The contact identifier is stored only as an opaque hash. No phone number, e-mail address, name, or other personal value is copied into `Conversation.state`. This supports customer-diversity metrics without mixing companies.

## Commercial outcome

Conversation text is never used to infer a sale, loss, discount, or business policy. A final outcome is imported only from an explicit `WON` or `LOST` object with a source, verification, and external evidence:

```json
{"externalId":"conversation-124","messages":[{"externalId":"message-3","role":"user","content":"Thank you"}],"commercialOutcome":{"status":"WON","source":"erp","verified":true,"order_id":"order-789"}}
```

`PENDING`, unverified values, and outcomes without evidence are counted as rejected. `order_id` creates a verified `ORDER` link and `payment_id` creates a verified `PAYMENT` link. A generic `externalReference` creates a link only when accompanied by `kind: "ORDER"` or `kind: "PAYMENT"`; the importer never chooses between ambiguous references.

For `WON`, the verified link receives the coherent `completed` status. For `LOST`, a link is created only when the archive also supplies `order_status`, `payment_status`, or another explicit link-status field. Otherwise only the lost outcome is kept. Re-running the import does not recreate the same verified outcome or commerce link.

## Analyze the imported archive

After importing, run a simulation first. The analyzer pages through conversations, bounds concurrency, and by default skips conversations that already have a completed or pending evaluation for the current evaluator version:

```powershell
docker compose exec gateway node dist/cli/analyze-conversations.js `
  --tenant company-alpha `
  --dry-run `
  --batch-size 100 `
  --concurrency 4
```

Review the counts and run the same command without `--dry-run`. After evaluation, it traverses every evaluation page and consolidates idempotent candidates. Use `--max-conversations` to validate a sample before processing a large archive. Re-runs do not duplicate the current evaluator version; use `--include-evaluated` only for an intentional full re-evaluation.

## Security and limits

- exported `system`, `developer`, and `tool` roles never become instructions;
- recognized prompt-control attempts are removed from historical text before persistence;
- arbitrary export metadata is not copied into operational state;
- invalid lines and lines above `--max-line-mb` are rejected without logging their content;
- `--max-rejected` stops excessively corrupt archives;
- progress and final statistics never print raw customer data.

To run locally with `DATABASE_URL` already configured:

```powershell
npm run conversations:import -w @omnichannel/gateway -- --tenant company-alpha --file C:\data\conversations.jsonl.gz --dry-run
```

Run with `--help` to see batching and limit options.
