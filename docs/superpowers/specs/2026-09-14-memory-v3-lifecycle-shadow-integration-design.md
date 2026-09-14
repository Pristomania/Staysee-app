# Memory V3 Lifecycle Shadow Integration Design

**Date:** 2026-09-14
**Status:** Approved architecture; implementation planning is the next gate
**Branch:** `codex/memory-v3-lifecycle-shadow`

## Decision

Add a second, explicitly gated Memory V3 shadow pipeline that turns per-conversation V2 extraction candidates into a durable cross-conversation lifecycle state.

The pipeline has two independent model boundaries:

1. the existing V2 extractor produces normalized candidate items and typed evidence;
2. a new lifecycle reconciler compares those candidates with the current lifecycle state and proposes only `create`, `confirm`, `revise`, `mark_stale`, `reject`, or `ignore` operations.

A deterministic TypeScript reducer validates and applies the proposal. The model never creates durable keys, increments revisions, writes database rows, or deletes memory directly.

The new mode is shadow-only. Its state is not read into replies, summaries, the current `user_memory` table, the Memory screen, or any other user-visible path. Implementation, paid synthetic evaluation, deployment with the mode off, and activation for one account remain separate gates.

## Why this is the next step

The merged synthetic lifecycle benchmark proves deterministic state transitions over 20 scenarios, 80 steps, and 240 synthetic messages. It does not prove that a model can choose the correct lifecycle operation or that production storage and concurrency are safe.

The current production shadow pilot stores independent extraction snapshots for at most 30 days. It does not maintain a durable state across conversations. Replacing current product memory would therefore skip the unresolved reconciliation, concurrency, deletion, and semantic-quality questions.

The lifecycle shadow foundation closes the storage and orchestration gap without changing replies. Because StaySEE currently has only two real users across three accounts and limited dialogue history, synthetic coverage and exact-account gates are more useful than a percentage rollout.

## Scope decomposition

This design separates three risk domains:

1. **Lifecycle shadow foundation:** production-shaped TypeScript contracts, reducer, storage, orchestration, and wiring, verified only with fakes. This is the only implementation scope authorized by this design.
2. **Model-backed lifecycle benchmark:** a later reconciler-only synthetic benchmark with a separately approved paid budget and human semantic review.
3. **Deployment and activation:** a later migration and Edge Function deployment with mode `off`, followed by another explicit decision before one-account activation.

No implementation plan may combine these domains into one automatic rollout.

## Goals

1. Preserve one deterministic lifecycle state per account across conversations.
2. Keep model output behind strict contracts and a deterministic reducer.
3. Prevent concurrent or duplicate runs from overwriting newer memory.
4. Preserve explicit forgetting as a trusted server action, never a model side effect.
5. Keep current replies and current memory behavior byte-for-byte independent of lifecycle success or failure.
6. Make storage private, auditable, bounded, and removable with the owning account.
7. Reuse the validated V2 extractor and lifecycle semantics without changing their existing offline reference files.

## Non-goals

The first implementation does not:

- enable `lifecycle_shadow` in any environment;
- deploy a migration or Edge Function;
- call OpenRouter or another provider;
- run a paid lifecycle benchmark;
- read lifecycle state into replies or prompts used to generate replies;
- replace `conversation_summary`, `user_memory`, or the current Memory screen;
- infer a trusted forget command from free-form dialogue;
- process the son's account or all accounts;
- migrate or backfill legacy memory;
- expose lifecycle state to browser clients;
- add retries, repair calls, automatic conflict retries, or fallback to the legacy writer;
- claim that scripted reducer correctness proves model reconciliation quality.

## Existing boundaries that remain authoritative

The following behavior remains unchanged:

- `supabase/functions/_shared/memory.ts`, `summaryRefresh.ts`, `context.ts`, and `userLifeMemory.ts` remain the active product-memory path.
- `supabase/functions/_shared/memoryV3/shadowRunner.ts` remains the extraction-only shadow pipeline for the exact mode `shadow`.
- `memory_v3_shadow_identities` and `memory_v3_shadow_runs` retain their current at-most-once and 30-day payload semantics.
- The existing `shadow` mode continues to make at most one provider call per reservation.
- The merged Node lifecycle modules and `memory-v3-synthetic-lifecycle-v1` dataset remain the reference oracle and are not imported by Deno production code.

## Operating modes

`STAYSEE_MEMORY_V3_MODE` accepts exactly:

```text
off
shadow
lifecycle_shadow
```

Rules:

- missing, empty, malformed, or unknown values resolve to `off`;
- `shadow` preserves the existing extraction-only behavior;
- `lifecycle_shadow` selects only the new lifecycle pipeline;
- the two pipelines never run for the same chat turn;
- `STAYSEE_MEMORY_V3_SHADOW_USER_ID` remains one canonical server-side UUID;
- only an authenticated `userId` exactly equal to that UUID is eligible;
- clients, profile rows, request bodies, and query parameters cannot select a mode or account;
- implementation and first deployment keep the mode `off`.

## Architecture

```text
normal StaySEE reply ───────────────────────────────────────────────► client
         │
         └─ background cadence after reply
              │
              ├─ exact mode + account gate
              ├─ load bounded source messages
              ├─ reserve one lifecycle input identity
              ├─ V2 extractor call
              ├─ project the state snapshot returned by reservation
              ├─ lifecycle reconciler call
              ├─ validate proposal
              ├─ deterministic reducer
              └─ atomic compare-and-swap persistence

lifecycle state ──X──► reply context / current memory / client response
```

The user-facing response is completed independently. Every lifecycle failure resolves inside the background task and emits only an allowlisted code.

## Logical state

One account has one logical lifecycle state:

```ts
interface MemoryV3LifecycleState {
  schemaVersion: "memory-v3-lifecycle-state-v1";
  userId: string;
  stateRevision: number;
  nextMemoryOrdinal: number;
  items: MemoryV3LifecycleItem[];
}
```

Each item contains the offline lifecycle material fields:

```text
memoryKey
kind
claim
status
sensitivity
eventTimeStart
eventTimeEnd
alternative
firstSeenAt
updatedAt
revision
evidence
```

Production replaces the synthetic `scenarioId` identity namespace with the authenticated `userId`. A new `memoryKey` is lowercase SHA-256 of the canonical payload:

```json
{
  "namespace": "memory-v3-production-lifecycle-v1",
  "userId": "canonical authenticated user id",
  "ordinal": 1
}
```

`nextMemoryOrdinal` never decreases or reuses an ordinal after forgetting. The model cannot provide `memoryKey`, `stateRevision`, `nextMemoryOrdinal`, `firstSeenAt`, `updatedAt`, or `revision`.

## Physical storage

The logical state is normalized into service-only tables so account, conversation, and message deletion can be enforced with foreign keys.

### `memory_v3_lifecycle_shadow_heads`

One row per user:

```text
user_id uuid primary key references profiles(id) on delete cascade
schema_version text fixed to memory-v3-lifecycle-state-v1
state_revision bigint nonnegative
next_memory_ordinal bigint positive
created_at timestamptz
updated_at timestamptz
```

### `memory_v3_lifecycle_shadow_items`

One row per durable item, keyed by `(user_id, memory_key)`. It stores only validated material fields and reducer-owned timestamps/revision. Status and alternative constraints mirror the lifecycle contract.

### `memory_v3_lifecycle_shadow_evidence`

Typed user evidence keyed by the durable evidence identity. It references the owning item, source message, and source conversation. Assistant evidence is impossible by contract. Deleting an account cascades all lifecycle data. Migration 034 installs schema-owned deletion triggers: before a source message or conversation is deleted, they delete every lifecycle item that cites the removed source; item deletion then cascades all remaining evidence. This favors privacy over retention and does not rely on application code.

### `memory_v3_lifecycle_shadow_identities`

A separate durable no-content ledger owns the primary key `(user_id, conversation_id, pipeline_version, input_hash)`. It stores only those identity fields and `created_at`. It is not the existing extraction-only identity table and is not removed by the 30-day run purge. Account or conversation deletion removes it through foreign-key cascades.

### `memory_v3_lifecycle_shadow_runs`

A separate transient run table has one foreign-keyed row per lifecycle identity. It records `reserved`, `succeeded`, or `failed`; safe diagnostic; expected and resulting state revisions; normalized extraction; sanitized operation rows; item/evidence/transition counts; trusted nullable usage for both calls; source boundary; and timestamps. The lifecycle reservation limit counts this table, not the existing extraction-only run table.

Lifecycle run payloads use the existing 30-day shadow retention duration through a new service-only purge function. Migration 034 creates a separate `pg_cron` job named `memory-v3-lifecycle-shadow-purge-daily` at `29 3 * * *`; it does not alter or replace the existing extraction-only retention job from migration 033. Durable identities, heads, items, and evidence are not time-purged.

Run audit never contains raw dialogue snapshots, system prompts, provider envelopes, raw model strings, credentials, request headers, or arbitrary exceptions.

All lifecycle tables enable RLS, create no `anon` or `authenticated` policy, revoke access from `PUBLIC`, `anon`, and `authenticated`, and grant only `service_role`. Security-definer functions use an empty `search_path` and schema-qualified names.

## Reconciler input boundary

The reconciler receives only:

```ts
{
  schemaVersion: "memory-v3-lifecycle-reconcile-request-v1";
  userLanguage: "ru";
  session: {
    conversationId: string;
    sourceLastMessageId: string;
    sourceLastCreatedAt: string;
  };
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: string }>;
  currentItems: Array<{
    memoryRef: string;
    kind: "event" | "recurrence" | "hypothesis";
    claim: string;
    status: string;
    sensitivity: "normal" | "sensitive";
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    alternative: string | null;
    revision: number;
    evidence: Array<{
      sourceMessageId: string;
      relation: string;
      supportType: string | null;
      episodeKey: string | null;
      mentionTime: string;
    }>;
  }>;
  candidates: Array<{
    candidateRef: string;
    kind: string;
    claim: string;
    status: string;
    sensitivity: string;
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    alternative: string | null;
    evidence: Array<{
      sourceMessageId: string;
      relation: string;
      supportType: string | null;
      episodeKey: string | null;
      mentionTime: string;
    }>;
  }>;
}
```

`memoryRef` and `candidateRef` are request-local opaque references. Durable `memoryKey` and extractor `localItemKey` are not exposed as writable model identity fields. Current items and evidence are sorted deterministically before projection. Gold data, evaluator output, legacy memory, provider metadata, and database row metadata are excluded.

Dialogue and stored claims are untrusted data. They cannot change the response schema, authorize forgetting, request hidden instructions, or create additional fields.

## Reconciler response boundary

The response is one JSON object with exactly:

```ts
{
  operations: Array<{
    type: "create" | "confirm" | "revise" | "mark_stale" | "reject" | "ignore";
    candidateRef: string;
    targetMemoryRef: string | null;
  }>;
}
```

Rules:

- every candidate appears exactly once;
- `create` and `ignore` require `targetMemoryRef: null`;
- `confirm`, `revise`, `mark_stale`, and `reject` require one existing compatible target;
- two target-changing operations cannot address the same target in one run;
- kind conversion is forbidden;
- proposal order cannot change the reducer result;
- unknown, sparse, accessor, symbolic, inherited, cyclic, or non-data fields are rejected;
- invalid or unresolved references reject the entire proposal;
- there is no partial row acceptance;
- `forget` is not a model operation.

## Explicit forgetting

Conversation text is not a trusted deletion command. The lifecycle background runner passes an empty trusted-forget list.

Only a future authenticated server action may provide durable `memoryKey` values to the reducer after an explicit user confirmation. That action requires a separate product/API design and is outside this implementation. Until then, the new shadow state cannot be deleted by model output.

The reducer and storage contract still implement trusted forgetting so it remains covered by the merged synthetic reference benchmark. A trusted forget deletes the item and all evidence atomically, emits no content-bearing audit, and prevents automatic resurrection from an already processed input identity.

## Reservation, concurrency, and atomic apply

Before either provider call, a service-only reservation function:

1. validates account and conversation ownership;
2. takes a transaction-scoped advisory lock for the user and UTC date;
3. rejects a previously claimed pipeline-version/input-hash identity;
4. enforces at most one lifecycle reservation per allowed user per UTC day;
5. reads or creates the state head;
6. records `expectedStateRevision` and a bounded state snapshot;
7. inserts one reserved lifecycle run;
8. returns the run ID, expected revision, and state snapshot.

The canonical input hash includes the lifecycle pipeline version, authenticated user, conversation, and ordered source messages. It does not include credentials, prompt wrappers, provider data, or current state revision. Once claimed, the same input is never automatically retried, including after failure or conflict.

After both model boundaries and deterministic reduction succeed, one service-only compare-and-swap function:

1. locks the state head;
2. verifies `state_revision === expectedStateRevision`;
3. validates the fixed state envelope and limits;
4. replaces the user's normalized items and evidence in one transaction;
5. increments `state_revision` only when state content changes;
6. records the sanitized transition audit and terminal run status;
7. commits everything together.

If the revision changed, the function records `state_conflict`, changes no lifecycle state, and performs no automatic retry or additional model call. A later genuinely new dialogue snapshot may reconcile against the newer state.

## Limits and cost boundary

Hard implementation limits:

```text
model for both calls: google/gemini-3.7-flash
source messages per run: 1..60
current lifecycle items: 0..100
current lifecycle evidence rows: 0..500
extractor request: at most 20,000 UTF-8 bytes
reconciler request: at most 80,000 UTF-8 bytes
configured input reservation per call: 32,768 tokens
maximum output per call: 1,200 tokens
model calls per reserved lifecycle run: at most 2
lifecycle reservations per allowed user per UTC day: at most 1
automatic retry/repair calls: 0
```

The extractor request is validated before reservation where possible. The complete reconciler request can be checked only after extraction; overflow then fails the reserved run without making the second call.

Using the previously reviewed historical planning ceiling of `$0.029076` per call, two calls imply `$0.058152` per lifecycle run. A provisional hard gate is `$0.065` for one daily run. These values are not actual billing and do not authorize spending. Model availability and a fresh allowlisted price snapshot must be verified in the separately approved paid-benchmark design before any paid execution or activation.

Both provider requests preserve the reviewed privacy controls:

```json
{
  "require_parameters": true,
  "data_collection": "deny",
  "zdr": true
}
```

Provider fallback is allowed only between endpoints satisfying every required parameter and privacy control. It is not an application retry: the application sends one POST for extraction and one POST for reconciliation at most.

## Execution algorithm

`runMemoryV3LifecycleShadow` performs this exact order:

1. Inspect top-level options without executing accessors or trusting prototypes.
2. Resolve exact mode and account eligibility.
3. Return a normal skip with zero database/provider work unless mode is `lifecycle_shadow` and the account matches.
4. Validate identifiers, injected dependencies, and API-key presence.
5. Load and validate the bounded source-message slice.
6. Build the extractor request and enforce its byte cap.
7. Compute the canonical input identity.
8. Reserve atomically and receive the validated current state snapshot.
9. Stop on duplicate, daily cap, ownership failure, reservation error, or oversized state.
10. Make exactly one extractor call.
11. Parse and normalize the V2 layered extraction.
12. Build the reconciler request from the trusted state projection, normalized candidates, and source dialogue.
13. Enforce state/count/request limits.
14. Make exactly one reconciler call.
15. Parse and validate the complete proposal.
16. Apply the deterministic reducer with `trustedForgetMemoryKeys: []`.
17. Compare-and-swap the complete state and terminal run audit.
18. Resolve a sanitized background result without affecting the response path.

No failure repeats steps 10 or 14. No failure invokes the legacy memory writer.

## Safe diagnostics

The lifecycle pipeline uses module-local branding and a closed diagnostic set:

```text
disabled
user_not_allowlisted
duplicate
daily_cap
invalid_source
state_too_large
extractor_transport_failed
extractor_parse_invalid
extractor_shape_invalid
extractor_contract_invalid
reconciler_request_too_large
reconciler_transport_failed
reconciler_parse_invalid
reconciler_shape_invalid
reconciler_contract_invalid
state_conflict
state_write_failed
reservation_failed
unknown_failure
```

External names, messages, codes, getters, proxies, and causes are never trusted. Logs and stored diagnostics contain no dialogue, claim, model output, provider body, prompt, credential, state payload, database response, or attacker-controlled property name.

## Product isolation invariants

1. Lifecycle output is write-only from the reply runtime's perspective.
2. No lifecycle table is queried by reply-context construction.
3. No lifecycle claim is copied into `conversation_summary` or `user_memory`.
4. Shadow success, failure, conflict, and timeout cannot change the current HTTP response.
5. Non-allowlisted accounts cause zero reservations and zero provider calls.
6. One input identity causes at most one reserved lifecycle run.
7. One lifecycle run causes at most one extractor and one reconciler call.
8. At most one lifecycle reservation is allowed per UTC day.
9. Model output cannot delete memory or supply durable identity/revision fields.
10. Time passage alone never changes or deletes durable lifecycle state.
11. Thirty-day retention applies only to run/audit payloads, never to current lifecycle items.
12. Deployment, environment configuration, activation, paid evaluation, and reply integration require separate approvals.

## Offline implementation boundary

Create focused TypeScript modules under `supabase/functions/_shared/memoryV3/`:

```text
lifecycleContract.ts
lifecycleContract.cases.test.ts
lifecycleReducer.ts
lifecycleReducer.cases.test.ts
lifecyclePrompt.ts
lifecyclePrompt.cases.test.ts
lifecycleTransport.ts
lifecycleTransport.cases.test.ts
lifecycleStore.ts
lifecycleStore.cases.test.ts
lifecycleShadowRunner.ts
lifecycleShadowRunner.cases.test.ts
lifecycleWiring.cases.test.ts
```

Create one unapplied migration:

```text
supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql
```

Modify only as required:

```text
supabase/functions/_shared/memoryV3/mode.ts
supabase/functions/_shared/memoryV3/mode.cases.test.ts
supabase/functions/staysee-chat/index.ts
scripts/memory-v3-pilot/README.md
```

The wiring supplies injected store and model adapters only inside the existing background cadence. It must not modify the response, current context assembly, summary refresh, current memory writers, or client-visible types.

## Frozen paths

The first implementation does not modify:

```text
scripts/memory-v3-pilot/lifecycle-contract.mjs
scripts/memory-v3-pilot/lifecycle-reducer.mjs
scripts/memory-v3-pilot/lifecycle-evaluator.mjs
scripts/memory-v3-pilot/lifecycle-runner.mjs
scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json
scripts/memory-v3-pilot/memory-v3-ru-golden.v1.json
scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json
supabase/functions/_shared/memory.ts
supabase/functions/_shared/summaryRefresh.ts
supabase/functions/_shared/context.ts
supabase/functions/_shared/userLifeMemory.ts
supabase/functions/_shared/memoryLayersV2.ts
supabase/functions/_shared/memoryV3/shadowRunner.ts
supabase/functions/_shared/memoryV3/shadowStore.ts
supabase/migrations/20260905120000_032_memory_v3_shadow_pilot.sql
supabase/migrations/20260914193000_033_memory_v3_shadow_retention_schedule.sql
```

Existing protected benchmark artifacts remain untracked and untouched.

## Testing strategy

Implementation follows TDD with synthetic inputs and injected fakes only.

Required groups:

- exact parity between the TypeScript lifecycle contract/reducer and the merged Node reference over all 20 scenarios and 80 steps;
- all operation effects, stable identity, revision behavior, ordering, atomic rollback, no-op stability, and trusted forgetting;
- reconciler request/response closed schemas, local references, candidate consumption, kind/target rules, and prompt-injection resistance;
- getter, setter-only, symbol, non-enumerable, inherited, sparse, cyclic, revoked-proxy, stateful-trap, spoofed-error, and stolen-brand matrices at every public boundary;
- source-message, state-item, evidence-row, prompt-byte, model-call, daily-reservation, and cost gates;
- duplicate identity, concurrent reservation, compare-and-swap conflict, state-write failure, and no-retry behavior;
- account, conversation, and source-message deletion behavior, including conservative deletion of items citing removed sources;
- RLS, grants, empty search paths, schema qualification, terminal row constraints, 30-day run cleanup, and no time purge of durable state;
- exact-account and exact-mode gates with zero work for all other accounts;
- wiring source locks proving lifecycle output cannot reach replies, summaries, current memory, UI payloads, or analytics;
- full existing Memory V1/V2, shadow, lifecycle, application typecheck, lint, and build gates where locally available.

Tests must not read `.env`, call a provider, access a deployed database, deploy migrations, or use real user identifiers or dialogue.

## Model-backed benchmark gate

The later paid benchmark evaluates only the reconciler. It feeds the human-approved extraction and prior state from each of the 80 synthetic steps, avoiding a redundant extractor call. It must use a frozen profile, exact request cap, exact model-call cap, safe output file, and separately approved maximum budget.

Admission requires:

- zero forbidden-memory violations;
- zero assistant-only memories;
- zero model-authorized deletions;
- zero deleted-memory resurrection;
- zero duplicate active items;
- zero no-op revision churn;
- exact correction, rejection, and recurrence-partition safety gates;
- human semantic review of every mismatch;
- no raw dialogue, prompt, provider response, or credential in the public report.

Passing reducer tests alone does not satisfy this gate.

## Deployment and activation gates

1. Complete and review the offline implementation. Do not deploy.
2. Complete the paid reconciler-only synthetic benchmark under separate authorization.
3. Review semantic failures and revise until all absolute safety gates pass.
4. Separately deploy the migration and Edge Function with `STAYSEE_MEMORY_V3_MODE=off`.
5. Verify schema, RLS, deletion behavior, retention, and zero provider calls while off.
6. Configure only Nastya's selected account UUID while mode remains off.
7. Separately authorize `lifecycle_shadow` and its maximum two provider calls per daily reservation.
8. Collect a small bounded sample, then turn the mode off.
9. Review stored state and run audit manually.
10. Decide separately whether to revise, continue shadowing, or design a product read path.

The son's account and other account remain outside the rollout unless separately authorized.

## Success criteria

The offline foundation is successful when:

- TypeScript contract and reducer match all 80 reference transitions;
- every invalid preflight produces zero model calls;
- every reserved execution performs at most two model calls with no retry;
- all writes are atomic and stale revisions cannot overwrite newer state;
- model output cannot delete memory or control durable identity;
- state is private and survives run-payload retention;
- account/source deletion removes derived private data conservatively;
- current replies and current memory behavior remain unchanged;
- all existing tests remain green;
- no migration, provider call, environment change, or deployment occurred.

This does not constitute production-readiness or authorization to use lifecycle memory in replies.

## Rejected alternatives

### Replace current memory immediately

Rejected because model reconciliation quality and real concurrency have not been established.

### One combined extraction-and-reconciliation model call

Rejected for the first lifecycle shadow because it couples two independently testable responsibilities, invalidates the reviewed extractor boundary, and makes failures harder to classify. Two calls cost more but preserve auditability.

### Deterministic text similarity as the reconciler

Rejected because paraphrases, corrections, recurrence boundaries, and hypotheses require semantic judgment. Deterministic code remains the validator and applier, not the semantic decision maker.

### Let the model delete memory from dialogue

Rejected because free-form model interpretation is not a trusted destructive authorization.

### Store the whole state as one JSON row

Rejected because nested source references cannot participate safely in message/conversation cascade deletion. A logical per-user state is retained through normalized head, item, and evidence tables.

### Reuse `user_memory`

Rejected because it would make experimental state user-visible and mix incompatible schemas before quality approval.

### Retry on state conflict

Rejected because it can repeat paid calls and hide concurrency evidence. A later new dialogue snapshot may reconcile against the current state.

## Final boundary

Approval of this design authorizes writing a detailed offline implementation plan after the design document is reviewed and committed. It does not authorize implementation, database deployment, environment changes, real-user access, provider calls, paid benchmarks, shadow activation, product read-path integration, or memory deletion UI/API work.
