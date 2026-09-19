# Memory V3 Lifecycle Read Canary Design

**Date:** 2026-09-20
**Status:** Approved direction; implementation planning is the next gate
**Branch:** `codex/memory-v3-lifecycle-read-canary`

## Decision

Add an explicitly gated, read-only product canary that replaces only the legacy cross-conversation `user_memory` prompt block with the current Memory V3 lifecycle state for exactly one allowlisted StaySEE account.

The canary does not replace per-conversation `conversation_summary`, recent messages, durable corrections, archive retrieval, weekly reflections, or any other context source. It does not modify the Memory screen, write to `user_memory`, trigger a provider request, or expose lifecycle records to the browser.

The feature is fail-closed for eligibility and fail-open for reply continuity:

- missing, invalid, or disabled canary configuration performs zero lifecycle reads and preserves the existing prompt;
- a technical read/projection failure preserves the existing legacy cross-memory prompt;
- a successfully loaded lifecycle state is authoritative, including an empty eligible-item list, and suppresses legacy cross-memory for that response;
- all non-allowlisted accounts preserve the existing product behavior byte-for-byte.

## Why this is the next step

The lifecycle foundation, storage, production wiring, paid synthetic benchmark, prompt admission fix, and order-independent benchmark evaluator are complete. The corrected paid result passes all structural gates over 12 synthetic scenarios with item and evidence precision/recall/F1 equal to 1.0. The lifecycle state still remains intentionally invisible to replies.

StaySEE has two real users across three accounts and limited natural dialogue history. A percentage rollout is not useful. An exact-account canary with deterministic simulated-dialogue coverage is the smallest meaningful product integration.

## Considered approaches

### Selected: replace only cross-conversation prompt memory for one account

On a successful lifecycle read, the V3 block replaces the legacy `user_memory` block. Per-conversation memory remains unchanged. A technical failure falls back to legacy cross-memory.

This avoids duplicate and contradictory memory while preserving the mature conversation-continuity path.

### Rejected: inject legacy and V3 cross-memory together

This is mechanically simple but can present the model with duplicated, stale, or contradictory claims. Prompt instructions cannot reliably reconcile two competing memory stores.

### Rejected: replace all memory immediately

Replacing summaries, archive context, corrections, and cross-memory together has a much larger blast radius and is not supported by the lifecycle benchmark.

### Rejected: continue shadow-only indefinitely

Shadow-only storage cannot demonstrate whether the verified state improves replies. It postpones the product question without producing new evidence.

## Configuration and exact-account gate

Introduce two independent server-only environment values:

```text
STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE=off|canary
STAYSEE_MEMORY_V3_LIFECYCLE_READ_USER_ID=<one canonical UUID>
```

Rules:

- missing, empty, or unknown mode means `off`;
- `canary` is the only value that permits a read;
- the configured user ID and authenticated user ID must be the same canonical lowercase UUID;
- object, accessor, inherited, symbolic, sparse, cyclic, proxied, or otherwise non-data inputs are rejected without executing getters;
- read eligibility is independent from `STAYSEE_MEMORY_V3_MODE`, so background lifecycle writing and reply reading can be stopped separately;
- the existing `STAYSEE_MEMORY_V3_SHADOW_USER_ID` is not reused as implicit read authorization;
- the son's account and every other account remain outside the read canary.

## Data source and security boundary

Add one migration with a service-only function:

```sql
public.load_memory_v3_lifecycle_read_context(p_user_id uuid) returns jsonb
```

The function:

1. uses `SECURITY DEFINER SET search_path = ''`;
2. uses only schema-qualified objects and functions;
3. returns `null` when no lifecycle head exists for the user;
4. returns one closed JSON object when a head exists;
5. includes only the head revision and eight bounded prompt fields from current items;
6. excludes evidence rows, message IDs, conversation IDs, memory keys, run audit, provider usage, model output, prompts, credentials, and raw dialogue;
7. sorts items by `updated_at DESC`, then `memory_key COLLATE "C"` before applying the cap;
8. is revoked from `PUBLIC`, `anon`, and `authenticated` and granted only to `service_role`.

No lifecycle table receives an authenticated-client policy. `context.ts` continues to use the user's JWT for its existing reads. Only `staysee-chat` may call the new service-only function through an injected service client after authentication and exact-account eligibility succeed.

## Read projection

The RPC returns exactly:

```ts
interface MemoryV3LifecycleReadContext {
  schemaVersion: "memory-v3-lifecycle-read-context-v1";
  stateRevision: number;
  items: Array<{
    kind: "event" | "recurrence" | "hypothesis";
    claim: string;
    status: "active" | "supported";
    sensitivity: "normal" | "sensitive";
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    alternative: string | null;
    updatedAt: string;
  }>;
}
```

Eligibility by kind is closed:

- `event`: only `active`;
- `recurrence`: only `active`;
- `hypothesis`: only `supported`;
- `candidate`, `corrected`, `stale`, and `rejected` never enter the read projection.

The maximum is 12 items. Each claim and alternative keeps the lifecycle contract limit, and the final formatted block is capped at 6,000 UTF-8 bytes. Any invalid field, unknown field, duplicate field, invalid date, unsupported status, over-cap array, accessor, symbol, sparse array, cycle, proxy failure, or oversized block invalidates the entire V3 read for that response and triggers legacy fallback.

The server-side projector clones all data. Database-returned arrays or objects are never exposed by alias.

## Authoritative empty versus unavailable

The read path has three outcomes:

```ts
type MemoryV3LifecycleReadOutcome =
  | { status: "disabled" }
  | { status: "unavailable"; diagnosticCode: "load_failed" | "invalid_shape" | "too_large" }
  | { status: "loaded"; context: MemoryV3LifecycleReadContext };
```

Prompt selection is exact:

- `disabled`: use legacy cross-memory;
- `unavailable`: use legacy cross-memory and emit only a closed server diagnostic;
- `loaded` with items: suppress legacy cross-memory and inject the V3 block;
- `loaded` with `items: []`: suppress legacy cross-memory and inject no cross-memory block.

The last rule prevents a rejected or corrected legacy claim from reappearing merely because the authoritative V3 state is empty.

## Prompt format and epistemic rules

The formatter groups the bounded items under one server-only section:

```text
[MEMORY V3 — CROSS-CONVERSATION CONTEXT]
Confirmed events:
- Пользователь вернулся к работе после отпуска.
Recurring patterns:
- При бытовой неопределённости заранее перепроверяет планы.
Supported hypotheses (tentative, not facts):
- Hypothesis: Юмор помогает дозировать уязвимость. Alternative: Юмор помогает поддержать окружающих.
[/MEMORY V3 — CROSS-CONVERSATION CONTEXT]
```

Instructions inside the block state:

- use this context only when relevant to the current user message;
- never reveal that a hidden memory store or lifecycle system exists;
- current explicit user statements and durable corrections override stored context;
- supported hypotheses are tentative and must not be asserted as facts;
- sensitive items must not be surfaced unexpectedly or used to label the user;
- do not infer childhood causes, diagnoses, motives, or forbidden meaning from the stored text;
- do not use another conversation's wording as a quote;
- an empty authoritative state means no cross-conversation claims are supplied.

The block contains no memory key, evidence source, database metadata, status revision, or account identifier.

## Context integration

The existing `buildContextPacket` remains responsible for user-JWT reads and continues to load legacy `memoryItems`. That preserves a ready fallback without giving authenticated clients access to lifecycle tables.

Before `buildContextPrompt` is called, `staysee-chat`:

1. resolves read-canary eligibility from server configuration and authenticated user ID;
2. when disabled, performs zero lifecycle database work;
3. when eligible, calls the injected lifecycle read store once;
4. converts the result into the closed read outcome;
5. passes the loaded context or fallback decision into prompt construction.

`buildContextPrompt` receives an optional trusted replacement object. When the object is loaded, it:

- excludes legacy `memoryItems` from `formatCrossMemoryForPrompt`;
- excludes legacy `memoryItems` from `buildNarrativeContext`;
- inserts the V3 block when it is non-empty;
- keeps conversation summary, recent conversation context, corrections, weekly reflections, evidence, and archive blocks unchanged.

When V3 is authoritative, the reply path does not call `stampMemoryUsed` for suppressed legacy row IDs. Background summary and legacy writers remain unchanged.

## Failure and diagnostics

The read path never fails the chat response. All failures become a closed outcome and legacy fallback.

Allowed server diagnostics are exactly:

```text
load_failed
invalid_shape
too_large
```

Logs use only `[memory-v3-lifecycle-read] <code>`. They contain no claim, hypothesis, alternative, user ID, memory key, database response, raw error, property name, credential, prompt, or cause.

No automatic retry is added. One response performs at most one lifecycle read RPC.

## Cost and performance boundary

The canary adds:

- at most one bounded database RPC per eligible response;
- zero lifecycle provider calls;
- zero additional background work;
- at most 6,000 UTF-8 bytes of V3 prompt context;
- no database writes.

The main reply model may receive a somewhat larger prompt, so normal chat token billing can increase slightly. This is not a new paid benchmark or a new provider request.

## Product and privacy boundaries

- The Memory screen remains unchanged and continues to show legacy product memory.
- No V3 state is returned in HTTP response bodies or client analytics.
- No raw dialogue or evidence is copied into the read projection.
- Existing lifecycle RLS and service-role restrictions remain intact.
- Account and source-message deletion behavior remains owned by the existing lifecycle schema.
- The read path never creates, confirms, revises, rejects, forgets, or deletes memory.
- The canary cannot be enabled for multiple accounts by a list or wildcard.

## Files and module boundaries

Create:

```text
supabase/functions/_shared/memoryV3/lifecycleReadMode.ts
supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts
supabase/functions/_shared/memoryV3/lifecycleReadStore.ts
supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts
supabase/functions/_shared/memoryV3/lifecycleReadPrompt.ts
supabase/functions/_shared/memoryV3/lifecycleReadPrompt.cases.test.ts
supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts
supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql
```

Modify only as required:

```text
supabase/functions/_shared/context.ts
supabase/functions/staysee-chat/index.ts
scripts/memory-v3-pilot/README.md
```

The read modules do not import `Deno.env`, `globalThis.fetch`, OpenRouter adapters, lifecycle writers, or legacy memory writers. Environment reads and service-client construction stay in the composition root `staysee-chat/index.ts`.

## Frozen paths

The first read canary does not modify:

```text
supabase/functions/_shared/memoryV3/lifecycleContract.ts
supabase/functions/_shared/memoryV3/lifecycleReducer.ts
supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
supabase/functions/_shared/memoryV3/lifecycleTransport.ts
supabase/functions/_shared/memoryV3/lifecycleStore.ts
supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts
supabase/functions/_shared/memoryV3/shadowRunner.ts
supabase/functions/_shared/memoryV3/shadowStore.ts
supabase/functions/_shared/memory.ts
supabase/functions/_shared/summaryRefresh.ts
supabase/functions/_shared/userLifeMemory.ts
supabase/functions/_shared/memoryLayersV2.ts
supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql
supabase/migrations/20260915010000_035_memory_v3_lifecycle_shadow_development_cap.sql
scripts/memory-v3-pilot/memory-v3-ru-golden.v1.json
scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json
```

Existing untracked benchmark artifacts and `supabase/.temp/cli-latest` remain untouched and unstaged.

## Testing strategy

Implementation follows TDD with synthetic data and injected fakes only.

Required coverage:

- exact read-mode and one-account eligibility matrix with zero side effects for every rejected input;
- closed RPC result projection, current-status filtering, deterministic order, item cap, byte cap, clone/no-alias behavior, and authoritative empty state;
- getters, setter-only fields, symbols, non-enumerable fields, inherited fields, sparse arrays, cycles, revoked proxies, stateful traps, spoofed errors, and stolen brands at every public boundary;
- SQL function shape, service-role-only grants, empty search path, schema qualification, no evidence/message/run fields, and unchanged table RLS;
- prompt grouping, hypothesis labels and alternatives, sensitive-use instruction, current-user precedence, forbidden-meaning instruction, and absence of internal identifiers;
- disabled and non-allowlisted users perform zero lifecycle RPC calls;
- technical/shape/size failure preserves legacy cross-memory;
- loaded non-empty V3 suppresses legacy prompt and narrative cross-memory;
- loaded empty V3 suppresses legacy prompt and narrative cross-memory;
- suppressed legacy row IDs are not stamped as used;
- conversation summary, corrections, archive, weekly reflection, and recent-message behavior remains unchanged;
- no V3 content reaches response JSON, logs, summaries, `user_memory`, analytics, or UI;
- all existing Memory V1/V2, shadow, lifecycle, benchmark, application typecheck, lint, and build gates remain green where locally available.

Tests do not read `.env`, call a provider, access a deployed database, deploy a migration, or use real account IDs or dialogue.

## Deployment gates

1. Complete and independently review the offline implementation. Do not deploy.
2. Run the full local Memory V3 and application regression gates.
3. Commit and merge the reviewed implementation separately.
4. Separately authorize and deploy migration 036 while read mode remains `off`.
5. Verify function grants, unchanged table RLS, and zero V3 reads while off.
6. Configure exactly Nastya's selected app account while mode remains `off`.
7. Separately authorize `canary` activation.
8. Run synthetic dialogue checks through the deployed application path.
9. Review reply quality and safe diagnostics, then turn the read mode off.
10. Decide separately whether to revise, continue the canary, expose memory controls, or replace legacy cross-memory generally.

No step in this design authorizes deployment, environment changes, provider calls, paid runs, additional accounts, UI exposure, or deletion controls.

## Success criteria

The implementation is ready for a separately authorized deployment when:

- only the exact canary account can load V3;
- disabled and non-allowlisted requests perform zero lifecycle reads;
- a valid V3 state replaces only legacy cross-conversation prompt memory;
- authoritative empty state cannot resurrect legacy claims;
- any technical failure keeps replies available through legacy fallback;
- no lifecycle write behavior changes;
- no V3 content reaches clients, logs, analytics, or legacy storage;
- no new provider call or retry exists;
- full regression tests pass;
- the feature remains off by default.

## Final boundary

Approval of this design authorizes an offline implementation plan and TDD implementation only. It does not authorize deployment, migration application, environment changes, activation, provider calls, paid benchmarks, UI changes, or multi-account rollout.
