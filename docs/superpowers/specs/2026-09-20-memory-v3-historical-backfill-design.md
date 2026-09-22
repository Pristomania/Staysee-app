# Memory V3 Historical Backfill Design

Date: 2026-09-20
Branch: `codex/memory-v3-history-backfill`
HEAD at design: `657d42a5a412f1d53551f470fa02c7ba1a32f89f`
Status: **design only; not implemented; not a paid or production-write authorization**

Related:

- `docs/superpowers/specs/2026-09-14-memory-v3-lifecycle-shadow-integration-design.md`
- `docs/superpowers/specs/2026-09-19-memory-v3-synthetic-lifecycle-model-benchmark-design.md`
- `docs/superpowers/specs/2026-09-20-memory-v3-lifecycle-read-canary-design.md`
- `supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql`
- `supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql`

## Decision

**ADOPT_OFFLINE_REVIEWED_HISTORICAL_BACKFILL_WITH_ATOMIC_INITIAL_IMPORT**

Memory V3 will not learn the existing account history through repeated live canary calls. A dedicated offline backfill will read one explicitly selected user's complete eligible message history up to a frozen cutoff, split it into deterministic single-conversation chunks, run the existing extractor and reconciler sequentially against an in-memory draft state, and produce one sensitive review artifact.

The draft is not written incrementally to production. Production receives it only through a separate service-role-only atomic import after:

1. offline synthetic tests pass;
2. a provider-free source inspection freezes the exact chunk manifest and budget inputs;
3. Nastya separately authorizes one paid execution with a hard maximum budget;
4. the resulting normalized memories receive an explicit human semantic review;
5. Nastya separately authorizes the production import.

The lifecycle read canary stays `off` until the imported state is verified. Implementation of this document does not authorize reading real dialogue, calling a provider, paying for a run, importing state, enabling the canary, or deploying.

## Why this is needed

The existing online lifecycle runner processes one conversation per run. Its message loader requests the newest 60 rows for that conversation and then restores chronological order. It does not scan the user's other conversations and it does not retrieve earlier messages beyond that limit.

The production inspection on 2026-09-20 found that the selected main account had five conversations and substantially more than 60 messages in total, with two conversations longer than 60 messages. Therefore the earlier empty lifecycle result was not evidence that the complete history contained no durable memories. It evaluated only one bounded recent window.

The exact account identifiers and raw messages are intentionally absent from this document.

## Goals

- Evaluate every eligible message in every conversation owned by one explicitly selected user, up to one immutable cutoff.
- Preserve chronological and deterministic processing while keeping each extraction chunk bound to one conversation.
- Reuse the current Memory V3 lifecycle prompt, contracts, model transport, and reducer semantics.
- Keep the draft state outside production until the entire run and human review succeed.
- Bound message count, request bytes, provider calls, concurrency, and total authorized spend before paid execution.
- Keep raw dialogue, prompts, provider bodies, API keys, and Authorization headers out of saved artifacts and public errors.
- Import the reviewed state in one database transaction or make no production change.
- Preserve immediate rollback to legacy memory by leaving the lifecycle read mode off until final activation.

## Non-goals

- Do not turn the live chat path into a history scanner.
- Do not use repeated production conversations as the backfill mechanism.
- Do not copy the existing `user_memory` text directly into V3 state.
- Do not let a runtime JSON profile choose arbitrary models, prices, HTTP caps, users, or schemas.
- Do not mix real-history execution with implementation tests.
- Do not automatically retry, repair, fall back, parallelize, import, deploy, or activate the canary.
- Do not claim that structural validation proves semantic correctness.
- Do not store raw historical dialogue in the backfill artifact, logs, stdout, stderr, or git.
- Do not modify Golden V1/V2 or reinterpret the synthetic benchmark as evidence about the real account.

## Rejected alternatives

### Wait for the live writer

The live runner sees only a bounded recent window in one conversation. Waiting would be slow, incomplete, and dependent on future activity. Old conversations could remain permanently unseen.

### Import legacy `user_memory`

The legacy summary does not carry typed evidence, source message ownership, recurrence episode structure, or the lifecycle state transitions required by V3. Importing it would preserve unknown historical errors and would not validate the new system.

### Backfill directly into production one chunk at a time

This would expose partial state if chunk 8 failed after chunks 1-7 succeeded. It would also make semantic review and rollback harder. The production database must not change until the complete draft is available and reviewed.

### Put messages from different conversations into one extractor request

Lifecycle evidence is bound to a conversation and the reducer receives one `conversationId` per step. Mixed-conversation chunks would weaken ownership checks and make source deletion semantics ambiguous.

## Safety gates

The workflow has five independent gates. A later gate never implies permission for an earlier or later one.

| Gate | External effect | Required authorization |
|---|---|---|
| implementation and synthetic tests | local code/tests only | approval of implementation plan |
| source inspection | read-only Supabase access; no provider | explicit source-inspection command |
| paid backfill | provider sends selected historical chunks | explicit paid approval naming the hard maximum budget |
| atomic import | one production database transaction | explicit import approval naming artifact digest and target |
| canary activation | lifecycle state becomes readable by the selected account | explicit activation approval after verification |

No command advances automatically from one gate to the next.

## Architecture

The implementation will have four boundaries.

```text
trusted frozen profile + validated synthetic fixtures
                         |
read-only source adapter | provider adapter
              \          |          /
               historical backfill engine
               (chunking + sequential state)
                         |
              sensitive review artifact
                         |
          separately authorized import verifier
                         |
             service-role atomic SQL RPC
```

### Shared lifecycle dependencies

The engine reuses these production semantics rather than creating a second memory model:

- `lifecyclePrompt.ts` for extractor and reconciler requests;
- `lifecycleContract.ts` for schema, proposal, item, evidence, and size limits;
- `lifecycleReducer.ts` for deterministic state transitions and memory keys;
- `openrouter-adapter.mjs` plus `openrouter-fetch-transport.mjs` for the
  history-only extractor provider boundary;
- `lifecycleTransport.ts` for the reconciler provider boundary and safe diagnostics.

The normal production extractor `transport.ts` remains frozen at 1,200 output
tokens. It is not widened for the backfill. The history-only extractor uses the
same layered response contract, `reasoning: { effort: "low" }`, and privacy
routing, but allows 4,096 output tokens. This is required because the selected
Gemini model has mandatory reasoning and a real backfill response exhausted the
1,200-token combined reasoning/output allowance with `finish_reason: "length"`.

It does not call `runMemoryV3LifecycleShadow`, `reserve_memory_v3_lifecycle_shadow_run`, or `apply_memory_v3_lifecycle_shadow_state` during draft construction because those are production persistence boundaries.

Both provider calls preserve the current exact routing privacy fields: `require_parameters: true`, `data_collection: "deny"`, and `zdr: true`.

### Proposed local modules

- `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts`
- `scripts/memory-v3-pilot/lifecycle-history-backfill-source.ts`
- `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts`
- `scripts/memory-v3-pilot/lifecycle-history-backfill-cli.ts`
- `scripts/memory-v3-pilot/lifecycle-history-backfill-run.ts`
- matching focused tests and synthetic fixtures

Names are frozen by the later implementation plan, not by creating code in this design step.

## Trusted profile

The profile is a deeply frozen code constant. It fixes:

- profile ID and version;
- lifecycle schema, pipeline, extractor, and reconciler versions;
- exact model;
- maximum 60 source messages per chunk;
- history-only 40,000-byte extractor request cap; the normal live lifecycle
  request cap remains 20,000 bytes;
- history-only 4,096-token maximum output allowance for the extractor; the
  normal live extractor and reconciler remain capped at 1,200 tokens;
- exact 80,000-byte reconciler request cap;
- maximum 100 state items and 500 total evidence rows;
- maximum two provider calls per chunk;
- sequential concurrency of one;
- no retry, repair, or fallback;
- privacy routing parameters already used by the lifecycle transport.

No file, argv value, environment value, database row, or test double may raise these limits. Tests may inject adapters, clocks, and source rows through explicit dependency interfaces, but may not replace the trusted profile with a clone.

Pricing is not treated as timeless profile data. A paid execution requires a fresh, cited price snapshot and a separately authorized hard budget as described below.

## Source selection

### Target identity

The target user ID comes from a dedicated secret or injected run dependency, not from positional argv and not from source data. Public output and errors never echo it. The engine accepts only a canonical UUID after a data-descriptor-safe boundary check.

The read-only adapter verifies that every selected conversation belongs to the target user and every message belongs to its stated conversation. It does not infer the user from whichever row happens to be returned first.

### Frozen cutoff

Source inspection captures one UTC `sourceCutoff`. Only messages with `created_at <= sourceCutoff` are eligible. Messages created later remain for normal live processing and cannot silently change an already reviewed backfill.

The adapter reads all eligible conversations and messages with stable pagination. Each page uses an explicit deterministic order. Pagination must not depend on offset alone when concurrent inserts are possible; it uses a keyset over `(created_at, id)` under the frozen cutoff.

### Eligible rows

Eligible rows are the user and assistant chat messages that the current lifecycle dialogue contract accepts. Unknown sender values, invalid timestamps, invalid UUIDs, sparse arrays, accessors, proxies, duplicate IDs, or rows outside the owned conversation fail source inspection before any provider call.

The source adapter does not truncate message text, silently drop oversized messages, or substitute legacy summaries.

### Source manifest

Provider-free inspection returns a manifest containing only:

- profile and pipeline versions;
- cutoff;
- conversation count, message count, and user-message count;
- per-conversation counts and time ranges identified by opaque local ordinals;
- deterministic chunk metadata and request byte counts;
- SHA-256 digest of the canonical source snapshot;
- maximum provider calls and budget inputs.

The digest is calculated over canonical conversation IDs and message `{id, role, text, createdAt}` values in deterministic order. The manifest exposes the digest but not the raw material used to compute it.

## Deterministic chunking

### Per-conversation chunks

Messages are sorted inside each conversation by `createdAt` ascending, then message ID by UTF-16 code-unit order. A chunk never crosses a conversation boundary.

For each conversation, the chunker repeatedly selects the largest next contiguous prefix that satisfies all of the following:

- at most 60 messages;
- at least one user message;
- the exact serialized extractor request is at most 40,000 UTF-8 bytes for
  historical backfill; the normal live lifecycle path remains capped at 20,000
  bytes;
- every included row is valid under the existing dialogue contract.

The byte count is computed from the real extractor request builder with `TextEncoder`, not from character count and not from a hand-written estimate.

If no valid chunk can include the next unprocessed rows, source inspection fails closed. It does not truncate a message, skip an assistant-only prefix, or send an oversized request.

The wider historical envelope is required because a complete source history can
contain one indivisible user message whose exact extractor request exceeds the
normal live cap after the system prompt is included. It does not raise the live
cap, and it remains below the profile's 32,768-token accounting reservation.

### Global processing order

Each chunk receives:

- conversation ordinal;
- chunk ordinal within that conversation;
- first and last message timestamps and IDs;
- exact message and user-message counts;
- extractor request byte count;
- a digest over the chunk source.

Chunks are merged into one processing sequence by:

1. last message timestamp;
2. last message ID;
3. conversation ordinal;
4. chunk ordinal.

This keeps lifecycle step times nondecreasing while retaining contiguous context inside each conversation. Chunk IDs and ordering are deterministic for the same frozen source snapshot.

## Draft execution

### Initial state

The v1 backfill always begins with `createEmptyMemoryV3LifecycleState({ userId })`. It is an initial import, not a merge into an existing nonempty lifecycle state.

### Per-chunk algorithm

For each manifest chunk in canonical order:

1. Rebuild the exact extractor request and recheck its digest and byte length.
2. Call the extractor once through a bounded adapter.
3. Validate and normalize the extraction with the existing contract.
4. Build the reconciler request from the current in-memory state, current chunk, and extraction.
5. Reject if the exact reconciler request exceeds 80,000 UTF-8 bytes.
6. Call the reconciler once through the bounded adapter.
7. Validate the proposal against the current state and extraction.
8. Apply it with `applyMemoryV3LifecycleStep` at the chunk's last message time.
9. Validate the resulting state, item/evidence limits, monotonic revision, and evidence ownership metadata.
10. Append a safe chunk result and continue only on success.

The engine runs one chunk at a time with `maxActive = 1`. A failed extraction, reconciliation, validation, reducer step, byte check, or cap check stops the whole execution. There is no automatic second attempt and no partial artifact eligible for import.

### Provider cap

For `N` chunks, the absolute application-layer cap is `2 * N` provider requests. The bounded adapter checks the cap before incrementing. A blocked request neither increments the count nor invokes the inner transport. A transport rejection still counts as an attempted request.

The engine verifies after success that:

- completed chunks equal `N`;
- provider calls are at most `2 * N` and match recorded call stages;
- concurrency never exceeded one;
- retry, repair, and fallback counts are zero.

## Budget contract

### Fresh price requirement

No dollar price in an older benchmark, spec, artifact, or conversation is accepted as current. Before a paid run, the operator records a fresh price snapshot from the provider's current public model listing, including model ID, input price, output price, URL, and observation time.

The snapshot expires after 24 hours or immediately if the provider changes the model route. An expired or mismatched snapshot blocks execution.

### Ceiling

Source inspection determines the exact chunk count without provider calls. The configured worst-case ceiling is calculated from:

- exact chunk count;
- maximum two calls per chunk;
- frozen reserved input tokens per call;
- the history profile's conservative maximum of 4,096 output tokens per call,
  applied to every possible call in the ceiling even though the reconciler
  remains capped at 1,200;
- the fresh input and output prices.

The CLI requires an explicit decimal `--max-budget-usd`. Paid execution is permitted only when:

- it includes the dedicated execute flag;
- the authorized maximum is at least the calculated ceiling;
- the authorized maximum is no greater than the amount explicitly approved by Nastya;
- model, profile, source digest, cutoff, chunk count, and price snapshot match the reviewed dry run exactly.

Actual usage and actual cost remain `null` unless every successful provider response contains validated usage data. Missing usage is never reconstructed from the ceiling and the ceiling is never described as actual billing.

## Privacy and artifact

### What may be sent to the provider

Only the current chunk and the normalized lifecycle state required by the frozen extractor/reconciler requests are sent. Provider privacy parameters stay equal to the existing lifecycle transport contract. No unrelated conversations, environment values, database credentials, or legacy memory rows are included.

### What is never saved

The artifact, stdout, stderr, and public diagnostics exclude:

- raw source messages and assistant replies;
- extractor or reconciler prompts;
- raw provider responses;
- Authorization headers, API keys, database URLs, and service-role keys;
- exact user ID and conversation IDs in public summaries;
- thrown `cause`, proxy trap text, getters, or untrusted property names.

### Review artifact

The opt-in safe-output artifact contains:

- profile/version metadata, cutoff, source digest, and chunk manifest metadata;
- final validated lifecycle state with normalized claims and evidence source IDs;
- per-chunk success/failure stage, safe diagnostic, transitions, and validated usage totals;
- counts, caps, provider call count, concurrency, and budget results;
- semantic review fields initialized to `null`;
- a canonical payload SHA-256 digest.

Normalized claims and evidence IDs are personal data even without raw dialogue. The file is therefore sensitive, untracked, excluded from commits, and written only to an explicit safe-output path using no-clobber creation. It is never created by a dry run unless the operator explicitly requests safe output.

Temporary files use ownership-aware cleanup: only a temp file successfully created by the current process may be removed. Existing target or temp files cause a failure before source reads, environment reads, or provider calls.

## Human semantic review

Structural contracts can prove schema, ownership, evidence form, limits, and deterministic transitions. They cannot prove that a real-life claim is true, useful, appropriately sensitive, or phrased safely.

The review packet lists every final item with its normalized claim, kind, status, sensitivity, alternative where applicable, evidence metadata, and source time range. It does not include raw dialogue.

Every active event, active recurrence, and supported hypothesis must receive an explicit semantic verdict. Candidate, stale, corrected, and rejected rows are also inspected for unsafe or falsely retained meaning. The run is importable only if the whole artifact receives one explicit `PASS` tied to its payload digest.

If any item is questionable, v1 does not hand-edit, filter, or partially import the artifact. The artifact is rejected. Prompt, fixture, or engine changes require a new offline review and, if another provider run is desired, another explicit paid authorization.

## Atomic production import

### Database additions

A new migration will add:

- `memory_v3_lifecycle_backfill_imports`, a service-role-only audit table;
- `import_memory_v3_lifecycle_backfill_state`, a `SECURITY DEFINER` RPC with an empty search path;
- RLS, revoked public/anon/authenticated access, and exact service-role grants;
- deterministic tests for success, idempotency, ownership rejection, revision mismatch, and transaction rollback.

The audit row records an opaque import ID, target user, artifact payload digest, source snapshot digest, cutoff, profile/pipeline/schema versions, expected and resulting revisions, item/evidence counts, and timestamp. It does not store raw dialogue or provider bodies.

### Initial-import-only contract

The v1 RPC is intentionally narrower than a general restore tool. It succeeds only when:

- target user is explicit and canonical;
- the lifecycle head exists at revision `0` with zero items, or is created empty in the same transaction;
- no prior import exists for the target or artifact digest;
- artifact schema, pipeline, extractor, and reconciler versions exactly match the deployed code;
- state user matches the target;
- state revision and next ordinal are valid and internally consistent;
- there are at most 100 items and 500 total evidence rows;
- every evidence message exists, belongs to its stated conversation, and that conversation belongs to the target user;
- every item and evidence field passes the same enum, date, relation, support type, episode, and status rules as the TypeScript contract;
- the caller supplies the reviewed payload digest and exact expected current revision.

The RPC locks the target head, validates everything, replaces zero existing items with the reviewed state, updates the head revision and next ordinal, and inserts the audit row in one transaction. Any error rolls back all changes.

The supplied artifact digest is an audit and idempotency key, not a substitute for server-side state and ownership validation.

### Pre-import revalidation

Immediately before RPC invocation, the import command performs a fresh read-only source inspection at the same cutoff and requires the source snapshot digest to equal the artifact. If any historical source row was added, changed, deleted, or reassigned inside the frozen snapshot, import stops before the RPC.

The import command also reloads the production lifecycle head and confirms the expected empty revision. It never invokes a provider.

## Read-canary activation and rollback

After import, a provider-free verification checks:

- the audit row and state counts;
- exact head revision and next ordinal;
- item/evidence ownership and caps;
- `load_memory_v3_lifecycle_read_context` returns only active/supported items;
- projection size remains within the existing 12-item read limit;
- legacy memory remains available as fallback.

Only then may a separate action set lifecycle read mode to canary for the exact reviewed user. The first canary smoke is a non-sensitive simulated or operator-authored dialogue; it must not trigger another historical backfill.

If read behavior is wrong, the immediate rollback is to set lifecycle read mode to `off`. That restores legacy reads without deleting the imported audit/state. Destructive state deletion is not part of automatic rollback.

## Diagnostics

Public stages are limited to:

- `source`
- `chunking`
- `budget`
- `extractor_transport`
- `extractor_parse`
- `extractor_contract`
- `reconciler_request`
- `reconciler_transport`
- `reconciler_parse`
- `reconciler_contract`
- `reducer`
- `artifact`
- `review`
- `import_preflight`
- `import`

Diagnostics use fixed allowlisted codes. Errors are branded through module-local identity, contain no `cause`, and do not trust spoofed `name`, prefix, or `diagnosticCode`. Accessors, symbols, non-enumerable fields, sparse arrays, cycles, proxies, and revoked proxies are rejected without executing getters or copying raw error text.

## Testing strategy

### Pure unit tests

- exact trusted profile values and deep freeze;
- JSON-data-only boundaries and proxy/getter non-execution;
- stable ordering by timestamps, IDs, conversation ordinal, and chunk ordinal;
- 60-message and exact UTF-8 byte boundaries;
- single oversized or unusable sequence fails without truncation;
- source digest changes for any content, role, ID, time, or conversation change;
- no raw messages in manifest or artifact projection;
- HTTP cap blocks request `2N + 1` before inner transport;
- inner transport failure counts once and stops the run;
- exact no-retry, no-repair, no-fallback, `maxActive = 1` behavior.

### Synthetic history scenarios

Fixtures use only invented UUIDs and dialogue. They cover:

- more than 60 messages in one conversation;
- several conversations whose chunks interleave by time;
- a durable event created in an old chunk and corrected later;
- recurrence evidence across separate conversations;
- a hypothesis that is later rejected;
- assistant speculation explicitly denied by the user;
- prompt injection and forbidden remembered meaning;
- empty/no-worthy-memory chunks;
- state reaching but not exceeding item/evidence caps;
- failure on a middle chunk with no importable partial output.

The expected final state is authored and reviewed independently of model output. Fake adapters drive deterministic TDD. No real user dialogue appears in repository fixtures.

### Source-adapter tests

An injected fake Supabase client proves keyset pagination, cutoff enforcement, ownership checks, duplicate rejection, and zero provider calls. Production source inspection is tested separately from the paid engine.

### SQL migration tests

The migration suite proves:

- service-role-only permissions and RLS;
- successful initial import;
- duplicate import idempotency rejection;
- nonzero or changed head rejection;
- wrong user/conversation/message ownership rejection;
- invalid status, evidence, revision, limits, or versions rejection;
- a forced middle insert failure leaves head, items, evidence, and audit unchanged;
- read projection contains only eligible active/supported items.

### Full regression gates

Before any commit or deployment:

- all Memory V3 TypeScript tests;
- all Memory V3 MJS tests;
- migration cases tests;
- project typecheck, lint, production build, and bundle verifier;
- frozen hashes for Golden datasets and unrelated lifecycle contracts;
- `git diff --check`;
- privacy scan for keys, raw dialogue, user IDs, provider bodies, and committed `_tmp` artifacts.

## Implementation sequence

1. Freeze characterization tests and hashes for current lifecycle contracts, reducer, prompts, transports, migration 034, migration 036, and read-canary behavior.
2. Implement the trusted backfill profile, source contract, and deterministic chunk planner through TDD.
3. Implement provider-free source inspection and dry-run manifest through injected clients.
4. Implement the offline sequential engine with fake-adapter tests only.
5. Implement safe CLI/run composition and sensitive no-clobber artifact output.
6. Implement the atomic import migration, RPC, and SQL tests without deploying it.
7. Add README operator documentation and run the full offline/privacy gate.
8. Stop for review. Source inspection, paid execution, migration deployment, import, and canary activation remain separate actions.

Each implementation task ends with a review checkpoint. A later task does not start automatically after a failed gate.

## Success criteria

The design is successfully implemented when:

- synthetic histories prove complete deterministic processing beyond 60 messages and across conversations;
- dry run reports the exact source digest, chunks, provider cap, and current-price ceiling with zero provider calls;
- paid execution is impossible without its exact flag and explicit budget;
- one failed chunk cannot produce an importable artifact or mutate production;
- the saved artifact contains normalized reviewable state but no raw dialogue, prompts, provider bodies, or credentials;
- semantic review is tied to the artifact digest;
- import is initial-only, service-only, atomic, ownership-checked, and idempotency-guarded;
- read mode remains off until a separately approved post-import activation;
- rollback to legacy reads requires only setting read mode back to off.

## Design conclusion

The previous empty canary result was a sampling result, not a verdict on the complete history. The correct next step is not to loosen admission or keep querying production. It is to build a bounded offline backfill that can evaluate the whole frozen history, expose the proposed long-term memories for review, and import them atomically only after separate approvals.
