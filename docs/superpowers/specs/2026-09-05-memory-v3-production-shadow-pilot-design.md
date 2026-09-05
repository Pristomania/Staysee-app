# Memory V3 Production Shadow Pilot Design

**Date:** 2026-09-05
**Status:** Approved architecture; implementation, deployment, and live execution are separate gates
**Branch:** `codex/memory-v3-pilot`

## Decision

Adopt a production shadow pilot for Memory V3 on exactly one explicitly allowlisted StaySEE account.

The pilot observes bounded real conversation history, runs the validated Memory V3 V2 extractor in the background, and stores its normalized output in a dedicated service-only table. It does not change replies, prompt context, the current memory system, the UI, or any user-visible behavior.

The first pilot account is Nastya's account with the most useful conversation history. The son's account and the other account are outside the pilot. Adding any account requires a separate configuration change and authorization.

This design does not authorize implementation deployment, database migration deployment, environment changes, OpenRouter calls, or paid execution.

## Why this is the next step

The offline and paid synthetic benchmarks established that the V2 contract, layered admission rules, evaluator, and Gemini extractor are technically usable. They did not establish how the extractor behaves on ordinary production conversations.

The application has only two users across three accounts and limited dialogue history. A percentage rollout would add complexity without useful risk separation. An exact one-account allowlist is simpler, auditable, and reversible.

Replacing the current memory system now would be premature. Shadow execution produces evidence without putting experimental memory into replies.

## Goals

1. Measure Memory V3 behavior on real dialogue from one authorized account.
2. Preserve the current reply and memory behavior exactly.
3. Prevent duplicate, runaway, or accidental paid calls.
4. Store only normalized V3 output and safe operational metadata.
5. Make every failure fail open for the user-facing chat path.
6. Produce records that Nastya and Codex can review before any product integration decision.

## Non-goals

The first pilot does not:

- replace `conversation_summary` or `user_memory`;
- inject Memory V3 into model context;
- expose Memory V3 in the app or Memory screen;
- migrate or backfill legacy memory;
- process the son's account or all accounts;
- run the full 24-case benchmark again;
- add automatic retries, repair calls, or extraction fallback calls;
- save raw prompts, raw provider responses, or full dialogue snapshots;
- claim that structural extraction quality is equivalent to semantic safety;
- deploy anything as part of implementation review.

## Existing system boundary

The current product memory remains authoritative during the pilot:

- `supabase/functions/_shared/memory.ts` owns the legacy structured conversation summary stored in `conversations.conversation_summary`.
- `supabase/functions/_shared/summaryRefresh.ts` refreshes that summary and may update cross-conversation memory.
- `supabase/functions/_shared/context.ts` reads `conversation_summary` and `user_memory` into reply context.
- `supabase/functions/_shared/userLifeMemory.ts` owns current cross-conversation memory writes.
- `supabase/functions/_shared/memoryLayersV2.ts` is an older draft with a different schema. It is not the canonical Memory V3 V2 contract and must not be reused as such.

The pilot must not modify the behavior or storage contracts of those modules.

## Operating modes and account gate

Two server-side environment values control eligibility:

```text
STAYSEE_MEMORY_V3_MODE=off|shadow
STAYSEE_MEMORY_V3_SHADOW_USER_ID=canonical UUID of the one pilot account
```

Rules:

- Missing, empty, or unknown `STAYSEE_MEMORY_V3_MODE` means `off`.
- `shadow` is the only value that permits work.
- `STAYSEE_MEMORY_V3_SHADOW_USER_ID` must be one canonical UUID string.
- It is not an email, comma-separated list, wildcard, percentage, or client-provided value.
- The authenticated `userId` must exactly equal the configured UUID.
- A missing, malformed, or nonmatching UUID produces zero database reservations and zero provider calls.
- The client cannot override either value.
- The implementation and first deployment keep the mode `off` until Nastya separately authorizes activation.

The implementation must expose a pure eligibility function so the gate is testable without reading real environment values.

## Trigger and user-facing isolation

The composition point is the existing background section in `supabase/functions/staysee-chat/index.ts` inside the `EdgeRuntime.waitUntil` call.

The shadow pilot is considered only after a normal reply has been assembled and only when the existing rolling-summary decision `bgShould` is true. It therefore shares the current summary-refresh cadence without changing that cadence.

The shadow task is independent from summary refresh:

- summary failure must not control the shadow task;
- shadow failure must not control summary refresh;
- shadow work must not delay or alter the HTTP response;
- the shadow result must never be read while constructing the current or a later reply;
- the shadow result must never update `conversation_summary`, `user_memory`, conversation metadata, or messages;
- the shadow result must never be returned to the client.

The background promise handles its own errors and emits only safe diagnostic codes. It must not reject the user-facing request path.

## Source dialogue

The current `fetchTranscriptForSummary` projection is insufficient because it drops message IDs. Memory V3 evidence requires stable source-message identity.

A dedicated query loads a bounded slice from `messages` for the current conversation with exactly:

```text
id, sender, content, created_at
```

Rules:

- The query is constrained by both `conversation_id` and the authenticated `user_id` through the conversation ownership boundary.
- Rows are ordered by `created_at ASC`, then `id ASC` for deterministic ties.
- At most 60 rows are loaded.
- Empty content, invalid UUIDs, invalid timestamps, unknown senders, sparse projections, and duplicate message IDs fail before reservation.
- `sender=user` maps to role `user`; `sender=ai` maps to role `assistant`.
- Assistant messages may be untrusted context but can never become evidence.
- The current response exchange is used only if it has already been persisted as valid message rows. Synthetic in-memory message IDs are forbidden.
- At least one user message is required.
- The complete extractor request must not exceed 20,000 UTF-8 bytes, matching the reviewed V2 live-smoke boundary.

No dialogue text is copied into the shadow-run row outside the normalized extraction. The source remains in the existing `messages` table under its existing retention and deletion behavior.

## Canonical input identity

Before any provider call, the runner builds a deterministic input hash from:

```text
schemaVersion: memory-v3-shadow-input-v1
extractorVersion
userId
conversationId
ordered messages: id, role, text, createdAt
```

The canonical serializer is fixed and tested. Text is preserved exactly after shape validation; object key order and database row order cannot change the hash.

The hash is SHA-256 encoded as lowercase hexadecimal. The provider key, prompt wrapper, gold data, and previous memory are not part of the hash.

The uniqueness identity is:

```text
(user_id, conversation_id, extractor_version, input_hash)
```

A new extractor version may create a new run for the same dialogue. The same version and input may not create a second run, including after failure. There is no automatic retry for a failed identity.

## Atomic reservation and daily cap

The provider call is allowed only after an atomic database reservation succeeds.

The migration creates a service-only PostgreSQL function:

```text
reserve_memory_v3_shadow_run(
  p_user_id uuid,
  p_conversation_id uuid,
  p_extractor_version text,
  p_model text,
  p_input_hash text,
  p_source_last_message_id uuid,
  p_source_last_created_at timestamptz,
  p_message_count integer,
  p_user_message_count integer
)
```

The function is `SECURITY DEFINER` with a fixed safe `search_path`. It executes in one transaction and:

1. verifies that the conversation belongs to `p_user_id`;
2. takes a transaction-scoped advisory lock derived from `p_user_id` and the UTC date;
3. returns `duplicate` if the unique input identity already exists;
4. counts that user's rows created in the current UTC day;
5. returns `daily_cap` when the count is already 4;
6. inserts one `reserved` row and returns its ID otherwise.

The hard pilot cap is four reservations per UTC day for the one allowed account. Failed and abandoned reservations count toward the cap. The cap is not configurable from the client and cannot be raised through request input.

No provider call occurs for `duplicate`, `daily_cap`, ownership failure, database error, or an invalid reservation result.

## Storage model

Create migration:

```text
supabase/migrations/20260905120000_032_memory_v3_shadow_pilot.sql
```

Create table `public.memory_v3_shadow_runs`:

| Column | Type | Contract |
|---|---|---|
| `id` | `uuid` | primary key, generated server-side |
| `user_id` | `uuid` | required FK to `profiles(id)` with cascade delete |
| `conversation_id` | `uuid` | required FK to `conversations(id)` with cascade delete |
| `extractor_version` | `text` | required fixed version label |
| `model` | `text` | required model identifier |
| `input_hash` | `text` | required 64-character lowercase SHA-256 hex |
| `status` | `text` | `reserved`, `succeeded`, or `failed` |
| `diagnostic_code` | `text` | nullable allowlisted safe code |
| `source_last_message_id` | `uuid` | required source boundary |
| `source_last_created_at` | `timestamptz` | required source boundary |
| `message_count` | `integer` | required bounded count |
| `user_message_count` | `integer` | required positive count |
| `item_count` | `integer` | nullable until completion |
| `evidence_count` | `integer` | nullable until completion |
| `extraction` | `jsonb` | nullable normalized V2 extraction |
| `prompt_tokens` | `integer` | nullable; only trusted provider usage |
| `completion_tokens` | `integer` | nullable; only trusted provider usage |
| `cost_usd` | `numeric` | nullable; never estimated as actual cost |
| `created_at` | `timestamptz` | server timestamp |
| `completed_at` | `timestamptz` | nullable server timestamp |

Constraints and indexes:

- unique `(user_id, conversation_id, extractor_version, input_hash)`;
- status check constraint;
- nonnegative counts and costs;
- `message_count <= 60` and `user_message_count <= message_count`;
- index on `(user_id, created_at DESC)`;
- index on `(conversation_id, created_at DESC)`;
- index on `created_at` for retention cleanup.

The `extraction` JSON contains only the normalized V2 `items` and `evidence` returned by the trusted core. It may contain sensitive psychological inferences and therefore receives the same protection as private memory data.

It must not contain the provider envelope, raw model string, system prompt, dialogue transcript, API key, Authorization header, request headers, or arbitrary exception text.

## Database access and retention

Row Level Security is enabled. No `anon` or `authenticated` policy is created. Table privileges and reservation/completion functions are revoked from `public`, `anon`, and `authenticated` and granted only to `service_role`.

The browser and ordinary authenticated clients cannot select, insert, update, or delete shadow rows.

Rows are retained for at most 30 days during the pilot. The migration creates a service-only function that deletes rows older than 30 days. A daily scheduled invocation is a deployment prerequisite before `STAYSEE_MEMORY_V3_MODE=shadow` may be enabled. Reservation also performs best-effort expired-row cleanup, but that is not the retention guarantee.

Account deletion and conversation deletion remove related rows through foreign-key cascades. The existing room-deletion SQL must be checked in implementation tests so its user-data deletion contract remains complete.

## V2 contract port

The tested offline pilot modules are Node `.mjs` files and cannot be imported directly by the Deno Edge Function. Production receives a focused TypeScript port under:

```text
supabase/functions/_shared/memoryV3/
```

The port contains small, isolated modules:

- `mode.ts` — mode and exact-account eligibility;
- `messages.ts` — source-row projection and deterministic ordering;
- `contract.ts` — V2 item/evidence validation and normalization;
- `prompt.ts` — static V2 extraction instruction and request projection;
- `transport.ts` — injected-fetch OpenRouter boundary and safe response projection;
- `shadowStore.ts` — reservation and terminal database writes;
- `shadowRunner.ts` — preflight, one model call, validation, and persistence orchestration.

The TypeScript contract, prompt, enum values, required fields, relation rules, support types, date rules, layered admission language, and extractor version are locked by parity tests against the approved offline V2 sources.

The port does not import `memoryLayersV2.ts` and does not silently translate its older `facts/hypotheses/coping_patterns` model.

## Provider boundary

Use a dedicated Memory V3 transport. Do not reuse `structuredModelCall.ts`; that helper has a different response schema and may log raw provider error content.

The library boundary accepts an injected `fetchImpl`. Only the `staysee-chat` composition root supplies the runtime fetch implementation.

The request uses the validated production profile:

```text
model: google/gemini-3.7-flash
extractorVersion: memory-v3-openrouter-gemini-3.7-flash-shadow-v2
max input: 16384 tokens, enforced additionally by request-byte preflight
max output: 1200 tokens
response contract: Memory V3 V2 layered items and typed evidence
```

OpenRouter provider controls remain:

```json
{
  "require_parameters": true,
  "data_collection": "deny",
  "zdr": true
}
```

Provider fallback is permitted only between OpenRouter endpoints compatible with all required privacy and request parameters. It is not an application retry: the application makes one HTTP POST per reservation and never makes a repair or second extraction call.

The response projector accepts only the content path needed by the extractor. Telemetry may be projected into trusted nullable usage fields, but raw provider messages are never logged or stored.

## Execution algorithm

`runMemoryV3Shadow` performs these steps in order:

1. Validate the injected dependencies and safe scalar options.
2. Evaluate mode and exact user allowlist.
3. Confirm a valid user ID and conversation ID.
4. Load and validate the bounded message slice.
5. Build the V2 request and enforce the byte ceiling.
6. Compute the canonical input hash.
7. Reserve atomically in the database.
8. Stop on any result other than a new reservation.
9. Make exactly one OpenRouter POST.
10. Parse and validate the adapter response using the V2 core.
11. Complete the row as `succeeded` with normalized extraction and trusted nullable usage.
12. On a provider, parse, shape, or contract failure, complete the row as `failed` with one allowlisted diagnostic code.

There is no retry, repair, row dropping, partial acceptance, recursive model call, or fallback to the legacy memory writer.

If the terminal database update fails after a paid call, the runner emits a safe operational code and stops. The existing reservation prevents a duplicate call for the same input.

## Safe diagnostics

Public logs and stored diagnostics use a closed set of short codes. The initial set covers:

```text
disabled
user_not_allowlisted
invalid_source
prompt_too_large
duplicate
daily_cap
reservation_failed
transport_failed
transport_timeout
provider_http_4xx
provider_http_5xx
provider_response_invalid
extractor_parse_invalid
extractor_shape_invalid
extractor_contract_invalid
completion_write_failed
unknown_failure
```

Expected skips such as `disabled`, `user_not_allowlisted`, `duplicate`, and `daily_cap` need not create console noise.

Errors use module-local branding. External `error.name`, `message`, `code`, `diagnosticCode`, getters, proxies, and `cause` are not trusted. Logs must not contain dialogue, claims, model output, paths containing secrets, provider bodies, or environment values.

## Product isolation invariants

The following are hard invariants for the first pilot:

1. Memory V3 output is write-only from the chat runtime's perspective.
2. No Memory V3 table is queried by reply-context construction.
3. No Memory V3 claim is copied into `conversation_summary` or `user_memory`.
4. The current response body is byte-for-byte independent of shadow success or failure.
5. Shadow mode cannot be enabled by client input or database profile fields.
6. A non-allowlisted account causes zero reservations and zero provider calls.
7. One canonical snapshot and extractor version cause at most one provider call.
8. One allowlisted account causes at most four reservations per UTC day.
9. The implementation contains no automatic paid execution command.
10. Deployment and activation remain separate explicit approvals.

## File map for implementation

Create:

```text
supabase/functions/_shared/memoryV3/mode.ts
supabase/functions/_shared/memoryV3/mode.cases.test.ts
supabase/functions/_shared/memoryV3/messages.ts
supabase/functions/_shared/memoryV3/messages.cases.test.ts
supabase/functions/_shared/memoryV3/contract.ts
supabase/functions/_shared/memoryV3/contract.cases.test.ts
supabase/functions/_shared/memoryV3/prompt.ts
supabase/functions/_shared/memoryV3/prompt.cases.test.ts
supabase/functions/_shared/memoryV3/transport.ts
supabase/functions/_shared/memoryV3/transport.cases.test.ts
supabase/functions/_shared/memoryV3/shadowStore.ts
supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
supabase/functions/_shared/memoryV3/shadowRunner.ts
supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts
supabase/migrations/20260905120000_032_memory_v3_shadow_pilot.sql
```

Modify only where required:

```text
supabase/functions/staysee-chat/index.ts
scripts/memory-v3-pilot/README.md
```

Do not change in the first implementation:

```text
supabase/functions/_shared/memory.ts
supabase/functions/_shared/summaryRefresh.ts
supabase/functions/_shared/context.ts
supabase/functions/_shared/userLifeMemory.ts
supabase/functions/_shared/memoryLayersV2.ts
scripts/memory-v3-pilot/memory-v3-ru-golden.v1.json
scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json
```

`aiAuditVersions.ts` also remains unchanged because the active reply memory version is still the legacy version. The shadow extractor version belongs in the dedicated shadow record.

## Testing strategy

Implementation follows TDD with offline fakes only.

Required test groups:

- mode defaults off and rejects missing, malformed, wildcard, list, email, and nonmatching account values;
- message projection is deterministic, bounded, nonmutating, and rejects invalid rows before reservation;
- assistant evidence is rejected for every relation;
- V2 support-type, episode-partition, correction, date, and layered-admission rules match the approved offline contract;
- the static prompt matches the approved V2 prompt semantics and never interpolates gold data into the system instruction;
- dialogue prompt-injection text remains untrusted input;
- duplicate input, daily cap, invalid ownership, invalid dataset, oversized prompt, and database error cause zero HTTP calls;
- concurrent reservation attempts yield one new reservation and at most one provider call;
- one success stores only normalized extraction and safe metadata;
- one provider or contract failure stores only a safe diagnostic and performs no retry;
- getters, symbols, non-enumerable fields, sparse arrays, cycles, revoked proxies, and spoofed errors do not leak data;
- `staysee-chat` wiring runs only in the background summary cadence and never feeds shadow output into replies or existing memory writers;
- non-allowlisted users have zero reservation and fetch calls;
- the migration enables RLS, creates no client policy, grants service-role-only execution, enforces uniqueness/caps, and includes retention cleanup;
- existing Memory V1/V2 tests and application typecheck/lint/build remain green where dependencies are available.

Tests must use synthetic UUIDs, dialogue, API keys, provider responses, and database rows. They must not read `.env`, call OpenRouter, deploy migrations, or access production/staging.

## Review workflow

Shadow records are not self-approving. A later offline review tool may read an explicitly exported, sanitized set of rows and build a human review packet. That tool is outside the first implementation unless separately specified.

Review judges:

- whether each stored claim is supported by user-authored messages;
- whether separate event, recurrence, and hypothesis layers are justified;
- whether correction and rejection semantics were preserved;
- whether sensitive claims are warranted;
- whether assistant speculation or forbidden meaning was remembered;
- whether duplicates or unstable paraphrases appear across snapshots.

No shadow output enters replies until a separate product-integration design is approved.

## Rollout gates

1. Implement and verify everything offline. Do not deploy.
2. Review diffs, tests, migration, cost bounds, and privacy invariants; commit and push only after approval.
3. Separately authorize migration and Edge Function deployment with mode `off`.
4. Verify schema, RLS, retention scheduling, and zero calls while off.
5. Configure only Nastya's selected account UUID while mode remains off.
6. Separately authorize `shadow` activation and its paid-call exposure.
7. Collect a small number of naturally triggered runs, capped at four per UTC day.
8. Disable shadow mode and review the stored results manually.
9. Decide separately whether to continue, revise the contract, add the son's account, or design read-path integration.

Every gate can stop permanently without affecting current product memory.

## Success criteria

The pilot is successful when:

- current replies and current memory behavior remain unchanged;
- only the exact allowlisted account produces rows;
- all preflight failures produce zero provider calls;
- deduplication and the daily cap hold under concurrency;
- every provider call maps to one reservation;
- stored successful outputs pass the V2 contract;
- stored failures contain only allowlisted diagnostics;
- no raw dialogue snapshot, prompt, provider body, credential, or arbitrary error reaches the shadow table or logs;
- retention and account/conversation deletion remove pilot data as designed;
- manual review yields enough evidence for a separate integration decision.

## Rejected alternatives

### Replace the current memory immediately

Rejected because synthetic benchmarks do not justify user-facing production dependence.

### Run for all three accounts or by percentage

Rejected because the user population is too small for percentage rollout to add meaningful control. Exact account selection is clearer.

### Store output in `conversation_summary`, `user_memory`, or `ai_usage_logs`

Rejected because it would mix experimental, sensitive structured memory with current product state or analytics and could accidentally affect replies.

### Reuse `memoryLayersV2.ts`

Rejected because its older schema is not the tested Memory V3 V2 event/recurrence/hypothesis contract.

### Reuse `structuredModelCall.ts`

Rejected because its response and logging behavior do not meet the Memory V3 projection and raw-content privacy boundary.

### Retry failed extractions

Rejected because retries increase cost and duplicate-risk while hiding reliability evidence. A new attempt requires a new extractor version or an explicitly designed manual retry workflow.

## Final boundary

Approval of this document authorizes only creation of a detailed implementation plan. It does not authorize code implementation, migration deployment, environment changes, production data access, OpenRouter requests, paid calls, or use of Memory V3 in replies.
