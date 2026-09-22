# Memory V3 Dialogue Live Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-deployed dialogue-scoped Memory V3 storage foundation into the live `staysee-chat` pipeline, gated to one canary account, so that account's dialogues start building genuinely separate "smart" memory notebooks instead of one shared account-wide notebook.

**Architecture:** Mirror the existing account-wide pipeline (`lifecycleReducer.ts` → `lifecyclePrompt.ts` → `lifecycleTransport.ts` → `lifecycleShadowRunner.ts`) into new dialogue-scoped equivalents that call the already-built `dialogueContract.ts` / `dialogueStore.ts` / `dialogueReadStore.ts` instead of their lifecycle counterparts. Wire the new runner into `staysee-chat/index.ts`'s write path (mutually exclusive with the lifecycle runner, per account) and the new read store into the read path (additive, alongside the lifecycle read).

**Tech Stack:** Deno Edge Functions (TypeScript), Postgres/Supabase (SQL migrations, SECURITY DEFINER RPCs), Node's built-in test runner via `npx tsx --test`.

## Global Constraints

- Every new/changed `*.ts` file must type-check with `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config <file>` at exactly the same error count as a clean `main` baseline (compare via `git stash` or a pre-change run) — zero new errors, ever.
- Every new `*.cases.test.ts` file runs via `npx tsx --test <file>` (Node's built-in test runner). No live Supabase/network/provider calls in any test — fakes only.
- Follow this codebase's adversarial-input-hardening convention exactly as seen in every file this plan mirrors: `inspectRecord`/`fail()`/`OWN_ERRORS` WeakSet pattern, exact-field-set checks (no extra/missing keys), enumerable-own-descriptor checks (never trust getters), Proxy/revoked-Proxy safety.
- Do not touch `memory_v3_lifecycle_shadow_*` tables, `lifecycleStore.ts`, `lifecycleReducer.ts`, `lifecyclePrompt.ts`, `lifecycleTransport.ts`, or `lifecycleShadowRunner.ts` in any way — they stay exactly as shipped today. Every new file in this plan is a **new, separate file**.
- Do not touch `сквозная память` (`profiles.cross_memory_enabled`, `user_memory` table) — the existing `fetchCrossMemoryEnabled` gate in `staysee-chat/index.ts` already covers both the lifecycle and (once wired) dialogue paths unchanged.
- No UI/screen work, no per-dialogue toggle, no new-dialogue-creation UX — explicitly out of scope per the design doc's non-goals.
- Cannot merge PRs without the user's explicit real-time "yes, merge" and cannot deploy to production under any circumstances — this plan's last task stops at "PR opened."

---

### Task 1: Port the message-count trigger to the dialogue-scoped reservation RPC

**Files:**
- Create: `supabase/migrations/20260923110000_041_memory_v3_dialogue_message_count_trigger.sql`
- Create: `supabase/functions/_shared/memoryV3/dialogueMessageCountTriggerMigration.cases.test.ts`

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: `reserve_memory_v3_dialogue_run` now gates on 10 new messages since the user's last dialogue-scoped reservation (across all their dialogues) instead of a calendar day. No later task depends on this migration directly — it only changes production database behavior once deployed.

Today's account-wide fix (`supabase/migrations/20260923090000_039_memory_v3_lifecycle_message_count_trigger.sql`) already exists as the template. The dialogue RPC (`reserve_memory_v3_dialogue_run`, defined in `supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql`) still has the old calendar-day gate. Read that file's current `reserve_memory_v3_dialogue_run` function in full before writing this migration — it already has the shared-budget fix (advisory lock salted with `1`, `conversation_id` excluded from the count query) baked in; **do not touch that part**, only the trigger condition.

- [ ] **Step 1: Write the failing structural test**

```typescript
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923110000_041_memory_v3_dialogue_message_count_trigger.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 041 must exist");
  return readFileSync(MIGRATION_URL, "utf8");
}

function functionBlock(sql: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?\\$function\\$;`,
    "iu",
  ));
  assert.ok(match, `${name} function block must be extractable`);
  return match[0];
}

describe("Memory V3 dialogue message-count trigger migration", () => {
  it("drops the calendar-day cap and gates on 10 new messages across all of the user's dialogues", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.doesNotMatch(body, /date_trunc\('day'/iu);
    assert.match(body, /v_new_message_count integer;/iu);
    assert.match(body, /IF v_new_message_count < 10 THEN/iu);
  });

  it("keeps the existing shared-budget lock and per-conversation lock untouched", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.equal(
      (body.match(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/g) ?? []).length,
      2,
      "must still have the two-lock pair from the shared-budget fix",
    );
    const countIndex = body.indexOf("SELECT pg_catalog.count(*)::integer INTO v_new_message_count");
    assert.ok(countIndex >= 0);
    const countQuery = body.slice(countIndex, body.indexOf(";", countIndex) === -1 ? undefined : body.indexOf("IF v_new_message_count", countIndex));
    assert.equal(countQuery.includes("conversation_id"), false, "count must stay shared across dialogues, not per-conversation");
  });

  it("still allows the very first-ever dialogue reservation for a user through immediately", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor");
    const gateIndex = body.indexOf("IF v_last_cursor IS NOT NULL THEN");
    assert.ok(watermarkIndex >= 0 && watermarkIndex < gateIndex);
  });

  it("adds no new table and changes no other RPC", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueMessageCountTriggerMigration.cases.test.ts`
Expected: FAIL — migration file does not exist yet.

- [ ] **Step 3: Write the migration**

First read `supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql`'s current `reserve_memory_v3_dialogue_run` function in full (it is long — the shared-budget fix added a second advisory lock and an `identities` check before the count query; copy that structure exactly). Then write a new `CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run(...)` migration that is byte-identical to the current one **except**: replace the calendar-day count block

```sql
  SELECT pg_catalog.count(*)::integer INTO v_daily_count
  FROM public.memory_v3_dialogue_runs
  WHERE user_id = p_user_id
    AND created_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_daily_count >= 1 THEN
```

with the message-count block (mirroring `20260923090000_039_memory_v3_lifecycle_message_count_trigger.sql`'s pattern exactly, but querying `memory_v3_dialogue_runs` instead of `memory_v3_lifecycle_shadow_runs`):

```sql
  SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor
  FROM public.memory_v3_dialogue_runs
  WHERE user_id = p_user_id;

  IF v_last_cursor IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_new_message_count
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.user_id = p_user_id AND m.created_at > v_last_cursor;
    IF v_new_message_count < 10 THEN
```

Declare `v_last_cursor timestamptz;` and `v_new_message_count integer;` in place of `v_daily_count integer;`. Keep the result string as `'daily_cap'` for wire compatibility, exactly as the account-wide fix did — do not rename it. Keep the two-advisory-lock pair, the `identities` duplicate check, and every line after the cap check completely unchanged. End the file with the same `REVOKE ALL` / `GRANT EXECUTE` pair the current dialogue RPC migration ends with, targeting `reserve_memory_v3_dialogue_run`'s exact parameter list (copy it from the existing migration — do not guess it).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueMessageCountTriggerMigration.cases.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260923110000_041_memory_v3_dialogue_message_count_trigger.sql supabase/functions/_shared/memoryV3/dialogueMessageCountTriggerMigration.cases.test.ts
git commit -m "feat: port the 10-message trigger to the dialogue-scoped reservation RPC"
```

---

### Task 2: `dialogueReducer.ts` — the state-transition algorithm, mirrored

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueReducer.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`

**Interfaces:**
- Consumes: `dialogueContract.ts`'s `MEMORY_V3_DIALOGUE_SCHEMA_VERSION`, `MemoryV3DialogueEvidence`, `MemoryV3DialogueItem`, `MemoryV3DialogueOperationType`, `MemoryV3DialogueProposal`, `MemoryV3DialogueState`, `projectSafeMemoryV3DialogueContractDiagnostic`, `validateMemoryV3DialogueProposal`, `validateMemoryV3DialogueState`, `validateMemoryV3DialogueTrustedForgetKeys` (all already exported today).
- Produces: `createEmptyMemoryV3DialogueState(input: { userId: string; conversationId: string })`, `applyMemoryV3DialogueStep(input: { state, at, conversationId, extraction, proposal, trustedForgetMemoryKeys }): Promise<{ state, transitions, changed }>`, `projectSafeMemoryV3DialogueReducerDiagnostic(error: unknown): Diagnostic | null`. Task 6 (the runner) imports these.

Read `supabase/functions/_shared/memoryV3/lifecycleReducer.ts` in full (528 lines) before starting — it is the exact template. Copy it to the new file and apply this substitution table, changing nothing else (every helper function, every check, every ordering stays identical):

| In `lifecycleReducer.ts` | Becomes in `dialogueReducer.ts` |
|---|---|
| `import ... from "./lifecycleContract.ts"` | `import ... from "./dialogueContract.ts"` |
| `MEMORY_V3_LIFECYCLE_SCHEMA_VERSION` | `MEMORY_V3_DIALOGUE_SCHEMA_VERSION` |
| `MemoryV3LifecycleEvidence` | `MemoryV3DialogueEvidence` |
| `MemoryV3LifecycleItem` | `MemoryV3DialogueItem` |
| `MemoryV3LifecycleOperationType` | `MemoryV3DialogueOperationType` |
| `MemoryV3LifecycleProposal` | `MemoryV3DialogueProposal` |
| `MemoryV3LifecycleState` | `MemoryV3DialogueState` |
| `projectSafeMemoryV3LifecycleContractDiagnostic` | `projectSafeMemoryV3DialogueContractDiagnostic` |
| `validateMemoryV3LifecycleProposal` | `validateMemoryV3DialogueProposal` |
| `validateMemoryV3LifecycleState` | `validateMemoryV3DialogueState` |
| `validateMemoryV3TrustedForgetKeys` | `validateMemoryV3DialogueTrustedForgetKeys` |
| `"lifecycle_reducer_invalid_input"` / `"lifecycle_reducer_transition_invalid"` | `"dialogue_reducer_invalid_input"` / `"dialogue_reducer_transition_invalid"` |
| `"MemoryV3LifecycleReducerError"` | `"MemoryV3DialogueReducerError"` |
| `"[memory-v3:lifecycle-reducer] value is invalid"` | `"[memory-v3:dialogue-reducer] value is invalid"` |
| `KEY_NAMESPACE = "memory-v3-production-lifecycle-v1"` | `KEY_NAMESPACE = "memory-v3-production-dialogue-v1"` (this changes the SHA-256 memory-key derivation namespace so dialogue-scoped memory keys can never collide with lifecycle-scoped ones even for the same user) |
| `createEmptyMemoryV3LifecycleState` | `createEmptyMemoryV3DialogueState` |
| `applyMemoryV3LifecycleStep` | `applyMemoryV3DialogueStep` |
| `projectSafeMemoryV3LifecycleReducerDiagnostic` | `projectSafeMemoryV3DialogueReducerDiagnostic` |

**One structural addition, not just renaming:** `createEmptyMemoryV3DialogueState`'s input and `validateMemoryV3DialogueState`'s call sites need `conversationId` threaded through, since the dialogue contract's validator takes three arguments where the lifecycle one takes two:

- Change `EMPTY_FIELDS = ["userId"] as const;` to `EMPTY_FIELDS = ["userId", "conversationId"] as const;`.
- In `createEmptyMemoryV3DialogueState`, add a `conversationId` check (`typeof projected.conversationId !== "string" || projected.conversationId.trim().length === 0`) alongside the existing `userId` UUID check, and add `conversationId: projected.conversationId` to the returned state object literal.
- Every call to `validateMemoryV3LifecycleState(x, userId)` becomes `validateMemoryV3DialogueState(x, userId, conversationId)` — there are three such call sites in the original file (`createEmptyMemoryV3LifecycleState`'s return, `applyMemoryV3LifecycleStep`'s `originalState` derivation, and its final `state` derivation). In `applyMemoryV3DialogueStep`, `conversationId` is already available as `projected.conversationId` (it is already one of `STEP_FIELDS`), so pass that.
- `MemoryV3DialogueState` (check `dialogueContract.ts`) already carries its own `conversationId` field on the state object itself — when building the `working`/intermediate state object literals inside `applyMemoryV3DialogueStep`, add `conversationId: originalState.conversationId` alongside the existing `schemaVersion`/`userId`/`stateRevision`/`nextMemoryOrdinal`/`items` fields.

- [ ] **Step 1: Write the failing tests**

Read `supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts` in full and copy it to `dialogueReducer.cases.test.ts`, applying the same substitution table above to every import, type name, and diagnostic string, plus adding `conversationId` to every `createEmptyMemoryV3LifecycleState`/state-literal call site the same way the source file changed. Keep every test case (empty-state creation, create/confirm/revise/mark_stale/reject/ignore transitions, forget-key handling, evidence merging conflicts, adversarial-input rejection) — do not drop any.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`
Expected: FAIL — `dialogueReducer.ts` does not exist yet.

- [ ] **Step 3: Write `dialogueReducer.ts`**

Apply the full substitution table and structural addition above to a copy of `lifecycleReducer.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`
Expected: PASS, same test count as the source file.

- [ ] **Step 5: Type-check and compare to baseline**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialogueReducer.ts`
Expected: no new errors versus a `git stash`d baseline check of the same command (the file is new, so baseline is "file does not exist" — confirm the check passes cleanly or with only pre-existing cross-module errors, matching `dialogueContract.ts`'s own baseline).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueReducer.ts supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts
git commit -m "feat: add dialogueReducer.ts, mirroring lifecycleReducer.ts for dialogue-scoped state"
```

---

### Task 3: `dialoguePrompt.ts` — the reconciler request builder, mirrored

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialoguePrompt.ts`
- Create: `supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts`

**Interfaces:**
- Consumes: `dialogueContract.ts`'s `MemoryV3DialogueReferenceBindings`, `MemoryV3DialogueState`, `validateMemoryV3DialogueProposal`, `validateMemoryV3DialogueState`; `contract.ts`'s `MemoryV3Extraction`, `validateMemoryV3Dialogue` (unchanged, shared); `messages.ts`'s `MemoryV3DialogueMessage` (unchanged, shared).
- Produces: `MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION`, `MemoryV3DialogueReconcileRequest` (type), `MemoryV3DialogueReconcileBundle` (type), `buildMemoryV3DialogueReconcileRequest(input: { userId, conversationId, messages, state, extraction }): MemoryV3DialogueReconcileBundle`. Tasks 4 and 6 depend on these exact names.

Read `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts` in full (362 lines) before starting. Copy it and apply:

| In `lifecyclePrompt.ts` | Becomes in `dialoguePrompt.ts` |
|---|---|
| `import ... from "./lifecycleContract.ts"` | `import ... from "./dialogueContract.ts"` |
| `MemoryV3LifecycleReferenceBindings` | `MemoryV3DialogueReferenceBindings` |
| `MemoryV3LifecycleState` | `MemoryV3DialogueState` |
| `validateMemoryV3LifecycleProposal` | `validateMemoryV3DialogueProposal` |
| `validateMemoryV3LifecycleState` | `validateMemoryV3DialogueState` |
| `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION` | `MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION` |
| First line of the system instruction text: `"You reconcile validated StaySEE Memory V3 candidates with existing lifecycle memory."` | `"You reconcile validated StaySEE Memory V3 candidates with this dialogue's existing memory."` (the only wording change — everything else in the 27 numbered rules stays byte-identical, they don't reference account vs. dialogue scope) |
| `MemoryV3LifecycleProjectedEvidence` / `MemoryV3LifecycleProjectedItem` / `MemoryV3LifecycleProjectedCandidate` | `MemoryV3DialogueProjectedEvidence` / `MemoryV3DialogueProjectedItem` / `MemoryV3DialogueProjectedCandidate` |
| `MemoryV3LifecycleReconcileRequest` / `MemoryV3LifecycleReconcileBundle` | `MemoryV3DialogueReconcileRequest` / `MemoryV3DialogueReconcileBundle` |
| `"memory-v3-lifecycle-reconcile-request-v1"` | `"memory-v3-dialogue-reconcile-request-v1"` |
| `"[memory-v3:lifecycle-prompt] invalid input"` / `"MemoryV3LifecyclePromptError"` | `"[memory-v3:dialogue-prompt] invalid input"` / `"MemoryV3DialoguePromptError"` |
| `buildMemoryV3LifecycleReconcileRequest` | `buildMemoryV3DialogueReconcileRequest` |

**One call-site change, not just renaming:** the one call to `validateMemoryV3LifecycleState(cloneJsonData(token, projected.state), userId)` becomes `validateMemoryV3DialogueState(cloneJsonData(token, projected.state), userId, conversationId)` — `conversationId` is already in scope at that point in the function (it was validated a few lines earlier from `projected.conversationId`).

- [ ] **Step 1: Write the failing tests**

Read `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` in full and copy it to `dialoguePrompt.cases.test.ts` with the same substitution table plus the `validateMemoryV3DialogueState` three-argument call-site change wherever the test constructs expected state directly. Keep every existing test case.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write `dialoguePrompt.ts`**

Apply the substitution table and the one call-site change above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts`
Expected: PASS, same test count as the source file.

- [ ] **Step 5: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialoguePrompt.ts`

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialoguePrompt.ts supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts
git commit -m "feat: add dialoguePrompt.ts, mirroring lifecyclePrompt.ts for dialogue-scoped state"
```

---

### Task 4: `dialogueTransport.ts` — the reconciler's OpenRouter call, mirrored

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueTransport.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts`

**Interfaces:**
- Consumes: `dialoguePrompt.ts`'s `MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION`, `MemoryV3DialogueReconcileRequest` (Task 3); `contract.ts`'s `MEMORY_V3_MAX_SOURCE_MESSAGES` (unchanged, shared).
- Produces: `MemoryV3DialogueTransportResult`, `MemoryV3DialogueModelAdapter`, `MemoryV3DialogueOpenRouterAdapterOptions`, `createMemoryV3DialogueOpenRouterAdapter(options): MemoryV3DialogueModelAdapter`, `projectSafeMemoryV3DialogueTransportDiagnostic(error): DiagnosticCode | null`. Task 6 depends on these exact names.

Read `supabase/functions/_shared/memoryV3/lifecycleTransport.ts` in full (~470 lines) before starting. Copy it and apply:

| In `lifecycleTransport.ts` | Becomes in `dialogueTransport.ts` |
|---|---|
| `import { MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION, type MemoryV3LifecycleReconcileRequest } from "./lifecyclePrompt.ts"` | `import { MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION, type MemoryV3DialogueReconcileRequest } from "./dialoguePrompt.ts"` |
| `MemoryV3LifecycleTransportResult` | `MemoryV3DialogueTransportResult` |
| `MemoryV3LifecycleModelAdapter` | `MemoryV3DialogueModelAdapter` |
| `MemoryV3LifecycleOpenRouterAdapterOptions` | `MemoryV3DialogueOpenRouterAdapterOptions` |
| `MemoryV3LifecycleReconcileRequest` (every occurrence, including the two call sites `projectRequest(token, unsafeRequest: MemoryV3LifecycleReconcileRequest)` and the returned adapter's parameter type) | `MemoryV3DialogueReconcileRequest` |
| `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION` (used when building the request body's `system` field or validating it against the expected constant — check both `projectRequest` and wherever the constant is compared) | `MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION` |
| `"MemoryV3LifecycleTransportError"` | `"MemoryV3DialogueTransportError"` |
| `projectSafeMemoryV3LifecycleTransportDiagnostic` | `projectSafeMemoryV3DialogueTransportDiagnostic` |
| `createMemoryV3LifecycleOpenRouterAdapter` | `createMemoryV3DialogueOpenRouterAdapter` |

Everything else — the timeout/abort-controller machinery, `projectUsage`, `projectProviderBody`, byte caps, error-code mapping — stays byte-identical; none of it references lifecycle-specific types.

- [ ] **Step 1: Write the failing tests**

Read `supabase/functions/_shared/memoryV3/lifecycleTransport.cases.test.ts` in full and copy it to `dialogueTransport.cases.test.ts` with the substitution table above. Keep every test case (successful call, timeout handling, HTTP error mapping, malformed-response rejection, usage parsing).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write `dialogueTransport.ts`**

Apply the substitution table above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts`
Expected: PASS, same test count as the source file.

- [ ] **Step 5: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialogueTransport.ts`

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueTransport.ts supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts
git commit -m "feat: add dialogueTransport.ts, mirroring lifecycleTransport.ts for dialogue-scoped reconciliation"
```

---

### Task 5: `dialogueMode.ts` — the canary eligibility gate

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueMode.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueMode.cases.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MemoryV3DialogueMode` (`"off" | "dialogue_canary" | "dialogue_all"`), `MemoryV3DialogueEligibility` (discriminated union, `{ eligible: true; mode; userId }` | `{ eligible: false; mode; reason }`), `MemoryV3DialogueEligibilityInput` (`{ rawMode, rawAllowedUserId, userId }`), `parseMemoryV3DialogueMode(raw)`, `resolveMemoryV3DialogueEligibility(input)`. Tasks 6 and 8 both call `resolveMemoryV3DialogueEligibility` — this is the single gate used for both the write path (Task 6/8) and the read path (Task 8), matching the design's "one env var pair gates both."

This is a full mirror of `supabase/functions/_shared/memoryV3/lifecycleReadMode.ts` (already read in full — it is 102 lines). Copy it and apply:

| In `lifecycleReadMode.ts` | Becomes in `dialogueMode.ts` |
|---|---|
| `MemoryV3LifecycleReadMode` | `MemoryV3DialogueMode` |
| `"canary" \| "all"` mode values | `"dialogue_canary" \| "dialogue_all"` |
| `MemoryV3LifecycleReadEligibility` | `MemoryV3DialogueEligibility` |
| `MemoryV3LifecycleReadEligibilityInput` | `MemoryV3DialogueEligibilityInput` |
| `"[memory-v3:lifecycle-read-mode] invalid eligibility input"` / `"MemoryV3LifecycleReadModeError"` | `"[memory-v3:dialogue-mode] invalid eligibility input"` / `"MemoryV3DialogueModeError"` |
| `parseMemoryV3LifecycleReadMode` | `parseMemoryV3DialogueMode` — body becomes `raw === "dialogue_canary" || raw === "dialogue_all" ? raw : "off"` |
| `resolveMemoryV3LifecycleReadEligibility` | `resolveMemoryV3DialogueEligibility` — every `"canary"` becomes `"dialogue_canary"` and every `"all"` becomes `"dialogue_all"` in the mode comparisons |

Everything else (the `inspectInput` adversarial-hardening function, `isCanonicalUuid`, the exact-field-count check) stays byte-identical.

- [ ] **Step 1: Write the failing tests**

Read `supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts` (if it doesn't exist under that exact name, find whichever test file covers `lifecycleReadMode.ts` — check `lifecycleReadWiring.cases.test.ts` and similar names too) and mirror its cases into `dialogueMode.cases.test.ts` with the substitution table above: disabled mode, `dialogue_all` for any canonical UUID, `dialogue_all` rejecting a malformed UUID, `dialogue_canary` requiring an exact allowlist match, invalid/malformed allowlist rejection, adversarial input (extra fields, non-plain-object, Proxy) rejection.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueMode.cases.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write `dialogueMode.ts`**

Apply the substitution table above to a copy of `lifecycleReadMode.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueMode.cases.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialogueMode.ts`

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueMode.ts supabase/functions/_shared/memoryV3/dialogueMode.cases.test.ts
git commit -m "feat: add dialogueMode.ts, the canary eligibility gate for dialogue-scoped memory"
```

---

### Task 6: `dialogueShadowRunner.ts` — the orchestration, mirrored

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

**Interfaces:**
- Consumes: `contract.ts` (unchanged: `MEMORY_V3_EXTRACTOR_VERSION`, `MEMORY_V3_MAX_PROMPT_BYTES`, `normalizeMemoryV3LayeredResponse`, `validateMemoryV3Dialogue`, `MemoryV3DialogueInput`, `MemoryV3Extraction`); `messages.ts` (unchanged: `MemoryV3DialogueMessage`); `prompt.ts` (unchanged: `buildMemoryV3ExtractorRequest`); `transport.ts` (unchanged: `projectSafeMemoryV3TransportDiagnostic`, `MemoryV3ModelAdapter`, `MemoryV3TransportResult`); `dialogueContract.ts` (Task 2's dependency, already shipped: `MEMORY_V3_DIALOGUE_MAX_CANDIDATES`, `MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE`, `MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES`, `MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES`, `MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE`, `MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS`, `MEMORY_V3_DIALOGUE_MODEL`, `MEMORY_V3_DIALOGUE_PIPELINE_VERSION`, `MEMORY_V3_DIALOGUE_RECONCILER_VERSION`, `projectSafeMemoryV3DialogueContractDiagnostic`, `validateMemoryV3DialogueProposal`, `validateMemoryV3DialogueState`, `MemoryV3DialogueState`); `dialogueReducer.ts` (Task 2: `applyMemoryV3DialogueStep`); `dialoguePrompt.ts` (Task 3: `buildMemoryV3DialogueReconcileRequest`); `dialogueTransport.ts` (Task 4: `projectSafeMemoryV3DialogueTransportDiagnostic`, `MemoryV3DialogueModelAdapter`, `MemoryV3DialogueTransportResult`); `dialogueStore.ts` (already shipped: `MemoryV3DialogueStore`, `MemoryV3DialogueStoredDiagnostic` — read this file's exact exported type names before writing imports, they may not be named identically to `lifecycleStore.ts`'s).
- Produces: `MemoryV3DialogueShadowDiagnostic`, `MemoryV3DialogueShadowResult`, `MemoryV3DialogueShadowOptions`, `runMemoryV3DialogueShadow(options, reportTransportDiagnostic?, logUsage?: MemoryV3LifecycleUsageLogger)`, `runMemoryV3DialogueShadowBackgroundSafely(run, logSafe)`. The `logUsage` parameter reuses `lifecycleShadowRunner.ts`'s exported `MemoryV3LifecycleUsageLogger` type directly (imported, not redefined) — its shape is generic (userId/conversationId/runId/stage/model/tokens/cost), so no new type is needed. Task 8 (index.ts wiring) calls both exported functions.

Read `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts` in full (630 lines, already read above in this session) before starting. Copy it and apply:

| In `lifecycleShadowRunner.ts` | Becomes in `dialogueShadowRunner.ts` |
|---|---|
| `import ... from "./lifecycleContract.ts"` | `import ... from "./dialogueContract.ts"`, renaming every `MEMORY_V3_LIFECYCLE_*` constant to `MEMORY_V3_DIALOGUE_*`, `projectSafeMemoryV3LifecycleContractDiagnostic` to `projectSafeMemoryV3DialogueContractDiagnostic`, `validateMemoryV3LifecycleProposal`/`validateMemoryV3LifecycleState` to `validateMemoryV3DialogueProposal`/`validateMemoryV3DialogueState`, `MemoryV3LifecycleState` to `MemoryV3DialogueState` |
| `import { applyMemoryV3LifecycleStep } from "./lifecycleReducer.ts"` | `import { applyMemoryV3DialogueStep } from "./dialogueReducer.ts"` |
| `import { buildMemoryV3LifecycleReconcileRequest } from "./lifecyclePrompt.ts"` | `import { buildMemoryV3DialogueReconcileRequest } from "./dialoguePrompt.ts"` |
| `import ... from "./lifecycleTransport.ts"` | `import ... from "./dialogueTransport.ts"`, renaming `projectSafeMemoryV3LifecycleTransportDiagnostic` to `projectSafeMemoryV3DialogueTransportDiagnostic`, `MemoryV3LifecycleModelAdapter` to `MemoryV3DialogueModelAdapter`, `MemoryV3LifecycleTransportResult` to `MemoryV3DialogueTransportResult` |
| `import type { MemoryV3LifecycleStore, MemoryV3LifecycleStoredDiagnostic } from "./lifecycleStore.ts"` | `import type { MemoryV3DialogueStore, MemoryV3DialogueStoredDiagnostic } from "./dialogueStore.ts"` (verify these exact exported names in `dialogueStore.ts` first — the plan author must read that file before writing this import; if the names differ, use the real ones, do not guess) |
| `MemoryV3LifecycleShadowDiagnostic` / `MemoryV3LifecycleShadowResult` / `MemoryV3LifecycleShadowOptions` | `MemoryV3DialogueShadowDiagnostic` / `MemoryV3DialogueShadowResult` / `MemoryV3DialogueShadowOptions` |
| `"[memory-v3:lifecycle-shadow-runner] operation failed"` / `"MemoryV3LifecycleShadowError"` | `"[memory-v3:dialogue-shadow-runner] operation failed"` / `"MemoryV3DialogueShadowError"` |
| `"lifecycle_shadow"` / `"lifecycle_all"` mode-check strings in `runMemoryV3LifecycleShadow` (the two `if (projected.rawMode !== ...)` gates) | Remove these two gate checks entirely — Task 8 already resolves eligibility via `resolveMemoryV3DialogueEligibility` (Task 5) *before* calling this runner at all, so the runner itself does not need to re-check mode/allowlist. Delete `rawMode` and `rawAllowedUserId` from `MemoryV3DialogueShadowOptions` and from `OPTION_FIELDS`, and delete the corresponding `"disabled" \| "user_not_allowlisted"` variants from `MemoryV3DialogueShadowResult`'s `skipped` branch (keep only `"duplicate" \| "daily_cap"`) |
| `MEMORY_V3_LIFECYCLE_PIPELINE_VERSION`, `MEMORY_V3_LIFECYCLE_RECONCILER_VERSION`, `MEMORY_V3_LIFECYCLE_MODEL` used when calling `reserve(...)` | `MEMORY_V3_DIALOGUE_PIPELINE_VERSION`, `MEMORY_V3_DIALOGUE_RECONCILER_VERSION`, `MEMORY_V3_DIALOGUE_MODEL` |
| `caseId: \`memory-v3-shadow:${userId}:${conversationId}\`` (appears twice: in the message-loading `validateMemoryV3Dialogue` call and inside `inputHash`) | Keep as-is — this is just a cache/hash namespace string local to this module, already includes `conversationId`, no collision risk with the lifecycle runner's identical string since they hash different underlying data |
| `normalizeMemoryV3LayeredResponse(parsedExtraction, dialogue, MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation")` | `normalizeMemoryV3LayeredResponse(parsedExtraction, dialogue, MEMORY_V3_EXTRACTOR_VERSION, "conversation")` — this is the one behaviorally significant, non-mechanical change: it tells `contract.ts`'s normalizer to tag extracted items with `scope: "conversation"` and the real `conversationId` instead of `scope: "cross_conversation"` and `conversationId: null` (this parameter and its two accepted values already exist in `contract.ts` as of PR #48/#50 — verify by reading `normalizeMemoryV3LayeredResponse`'s signature in `contract.ts` before writing this line) |
| Every `validateMemoryV3LifecycleState(x, userId)` call (in the reservation-state validation and the resulting-state validation) | `validateMemoryV3DialogueState(x, userId, conversationId)` |
| `buildMemoryV3LifecycleReconcileRequest({ userId, conversationId, messages: dialogue.messages, state, extraction })` | `buildMemoryV3DialogueReconcileRequest({ userId, conversationId, messages: dialogue.messages, state, extraction })` — same call shape, new function |
| `applyMemoryV3LifecycleStep({ state, at: last.createdAt, conversationId, extraction, proposal, trustedForgetMemoryKeys: [] })` | `applyMemoryV3DialogueStep({ ... })` — same call shape, new function |
| `export type MemoryV3LifecycleUsageLogger = ...` | **Delete this type entirely from the new file** — `import type { MemoryV3LifecycleUsageLogger } from "./lifecycleShadowRunner.ts";` instead, and use that imported type for the `logUsage` parameter. This is the one place this plan intentionally imports *from* the lifecycle module: the logger shape is generic (userId/conversationId/runId/stage/model/tokens/cost) and reusing the existing type avoids a pointless duplicate; `logUsageSafely`'s body stays a local copy (it's a 6-line helper, not worth cross-importing) |
| The two `logUsageSafely(logUsage, { ..., model: MEMORY_V3_LIFECYCLE_MODEL, ... })` call sites (right after the extractor and reconciler transport results are received) | `model: MEMORY_V3_DIALOGUE_MODEL` — keep both call sites in the exact same two positions (immediately after each transport response, before any parsing), preserving the "logged even if the run later fails" property |
| `runMemoryV3LifecycleShadowBackgroundSafely` | `runMemoryV3DialogueShadowBackgroundSafely` — body identical |

Everything else — `fitExtractorDialogueToByteCap`, `inspectExactRecord`, `inspectOptions`, `inspectDenseArray`, `ownMethod`, `canonicalStringify`, `inputHash`, `inspectExtractorEnvelope`, `transportResult`, `stateExceedsLimits`, `failed`, `persistFailure`, `inspectBackgroundResult` — stays structurally identical (rename only the lifecycle-specific type/constant references inside them per the table above; the algorithms themselves don't change).

- [ ] **Step 1: Read `dialogueStore.ts`'s exact exported type and method names**

Before writing any code, run:
```bash
grep -n "^export " supabase/functions/_shared/memoryV3/dialogueStore.ts
```
Use the real names in the import statement — do not assume they match `lifecycleStore.ts`'s names exactly.

- [ ] **Step 2: Write the failing tests**

Read `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts` in full (it includes today's two new cost-logging tests) and copy it to `dialogueShadowRunner.cases.test.ts`, applying the full substitution table above, including: removing the `rawMode`/`rawAllowedUserId` fields from the test harness's `options` object and from every test that exercises mode-gating (those tests move to Task 8's index.ts wiring tests instead, since the runner itself no longer gates on mode); keeping every other test (ordered orchestration, adversarial hardening, cost-logging, background-safe wrapping).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 4: Write `dialogueShadowRunner.ts`**

Apply the full substitution table above.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
git commit -m "feat: add dialogueShadowRunner.ts, mirroring lifecycleShadowRunner.ts for dialogue-scoped orchestration"
```

---

### Task 7: Read-path prompt injection — `dialogueReadPrompt.ts` and `context.ts`

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueReadPrompt.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueReadPrompt.cases.test.ts`
- Modify: `supabase/functions/_shared/context.ts` (the `ContextPromptOptions` interface, `CONTEXT_PROMPT_OPTION_FIELDS`, `inspectContextPromptOptions`, and `buildContextPrompt` — read the current file around lines 99-161 and 333-393 first, already excerpted in this session)
- Modify: whichever test file covers `buildContextPrompt`'s options handling today (find it via `grep -rl "inspectContextPromptOptions\|ContextPromptOptions" supabase/functions/_shared/*.cases.test.ts`)

**Interfaces:**
- Consumes: `dialogueReadStore.ts`'s `MemoryV3DialogueReadContext` (already shipped — its `items` shape is `{ kind: "event" | "recurrence" | "hypothesis"; claim: string; ...; alternative: string | null }[]`, structurally identical to `MemoryV3LifecycleReadContext`'s), `projectMemoryV3DialogueReadContext` (already shipped).
- Produces: `formatMemoryV3DialoguePromptBlock(context: MemoryV3DialogueReadContext): string`; `context.ts`'s `buildContextPrompt` gains an optional `dialogueMemory` field.

**Part A — `dialogueReadPrompt.ts`:**

Read `supabase/functions/_shared/memoryV3/lifecycleReadPrompt.ts` in full (95 lines, already read above). Copy it and apply:

| In `lifecycleReadPrompt.ts` | Becomes in `dialogueReadPrompt.ts` |
|---|---|
| `import { type MemoryV3LifecycleReadContext, projectMemoryV3LifecycleReadContext } from "./lifecycleReadStore.ts"` | `import { type MemoryV3DialogueReadContext, projectMemoryV3DialogueReadContext } from "./dialogueReadStore.ts"` |
| `MEMORY_V3_LIFECYCLE_READ_MAX_PROMPT_BYTES` | `MEMORY_V3_DIALOGUE_READ_MAX_PROMPT_BYTES` (keep the value `6_000`) |
| `"[memory-v3:lifecycle-read-prompt] prompt too large"` / `"MemoryV3LifecycleReadPromptError"` | `"[memory-v3:dialogue-read-prompt] prompt too large"` / `"MemoryV3DialogueReadPromptError"` |
| `OPEN = "[MEMORY V3 — CROSS-CONVERSATION CONTEXT]"` / `CLOSE = "[/MEMORY V3 — CROSS-CONVERSATION CONTEXT]"` | `OPEN = "[MEMORY V3 — THIS DIALOGUE'S CONTEXT]"` / `CLOSE = "[/MEMORY V3 — THIS DIALOGUE'S CONTEXT]"` (the model-facing label must say "this dialogue," not "cross-conversation" — this is the one wording change, everything else including all 8 `RULES` lines and the "never reveal a hidden memory store" rule stays identical) |
| `formatMemoryV3LifecycleReadPrompt` | `formatMemoryV3DialoguePromptBlock` |

- [ ] **Step 1: Write the failing test**

Read `supabase/functions/_shared/memoryV3/lifecycleReadPrompt.cases.test.ts` in full and mirror it into `dialogueReadPrompt.cases.test.ts` with the substitution table above (empty-items returns `""`, hypothesis items render their alternative, byte-cap enforcement throws, untrusted-bullet-text neutralization of control characters and bracket characters).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueReadPrompt.cases.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `dialogueReadPrompt.ts`**

Apply the substitution table above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueReadPrompt.cases.test.ts`
Expected: PASS.

**Part B — extend `context.ts`:**

The current `inspectContextPromptOptions` (lines 99-161 today) is hardcoded to exactly one required field (`lifecycleCrossMemory`) — it checks `keys.length !== CONTEXT_PROMPT_OPTION_FIELDS.length` and reads `CONTEXT_PROMPT_OPTION_FIELDS[0]` directly. Adding a second, independently-optional field requires rewriting the loop, not just widening the field list. Replace the whole options-handling block with:

```typescript
export interface ContextPromptOptions {
  lifecycleCrossMemory?: MemoryV3LifecycleReadContext;
  dialogueMemory?: MemoryV3DialogueReadContext;
}

interface InspectedContextPromptOptions {
  lifecycleCrossMemory: MemoryV3LifecycleReadContext | null;
  dialogueMemory: MemoryV3DialogueReadContext | null;
}

const CONTEXT_PROMPT_OPTION_FIELDS = ["lifecycleCrossMemory", "dialogueMemory"] as const;
const CONTEXT_PROMPT_OPTION_ERRORS = new WeakSet<object>();

function contextPromptOptionsFail(): Error {
  const error = new Error(
    "[memory-v3:context-prompt-options] invalid options",
  );
  error.name = "MemoryV3ContextPromptOptionsError";
  CONTEXT_PROMPT_OPTION_ERRORS.add(error);
  return error;
}

function contextPromptOptionsSafe<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      CONTEXT_PROMPT_OPTION_ERRORS.has(error)
    ) {
      throw error;
    }
    throw contextPromptOptionsFail();
  }
}

function inspectContextPromptOptions(
  value: ContextPromptOptions | undefined,
): InspectedContextPromptOptions | null {
  if (value === undefined) return null;
  if (
    typeof value !== "object" || value === null ||
    contextPromptOptionsSafe(() => Array.isArray(value))
  ) {
    throw contextPromptOptionsFail();
  }

  const prototype = contextPromptOptionsSafe(() => Object.getPrototypeOf(value));
  if (prototype !== Object.prototype && prototype !== null) {
    throw contextPromptOptionsFail();
  }

  const keys = contextPromptOptionsSafe(() => Reflect.ownKeys(value));
  if (keys.length === 0 || keys.length > CONTEXT_PROMPT_OPTION_FIELDS.length) {
    throw contextPromptOptionsFail();
  }

  const result: InspectedContextPromptOptions = {
    lifecycleCrossMemory: null,
    dialogueMemory: null,
  };
  const seen = new Set<string>();
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      !(CONTEXT_PROMPT_OPTION_FIELDS as readonly string[]).includes(key) ||
      seen.has(key)
    ) {
      throw contextPromptOptionsFail();
    }
    seen.add(key);
    const own = contextPromptOptionsSafe(() =>
      Object.getOwnPropertyDescriptor(value, key)
    );
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) {
      throw contextPromptOptionsFail();
    }
    if (key === "lifecycleCrossMemory") {
      result.lifecycleCrossMemory = own.value as MemoryV3LifecycleReadContext;
    } else {
      result.dialogueMemory = own.value as MemoryV3DialogueReadContext;
    }
  }
  return result;
}
```

Add the import at the top of `context.ts`: `import type { MemoryV3DialogueReadContext } from "./memoryV3/dialogueReadStore.ts";` (check the exact relative path — `context.ts` is directly under `_shared/`, `dialogueReadStore.ts` is under `_shared/memoryV3/`, so this path is correct given `lifecycleReadStore.ts` is already imported the same way).

In `buildContextPrompt`, change:

```typescript
  const lifecycleCrossMemoryBlock = inspectedOptions
    ? formatMemoryV3LifecycleReadPrompt(inspectedOptions.lifecycleCrossMemory)
    : "";
```

to:

```typescript
  const lifecycleCrossMemoryBlock = inspectedOptions?.lifecycleCrossMemory
    ? formatMemoryV3LifecycleReadPrompt(inspectedOptions.lifecycleCrossMemory)
    : "";
  const dialogueMemoryBlock = inspectedOptions?.dialogueMemory
    ? formatMemoryV3DialoguePromptBlock(inspectedOptions.dialogueMemory)
    : "";
```

and add the import `import { formatMemoryV3DialoguePromptBlock } from "./memoryV3/dialogueReadPrompt.ts";` alongside the existing `formatMemoryV3LifecycleReadPrompt` import.

Change the block that pushes it into `parts`:

```typescript
  if (inspectedOptions) {
    if (lifecycleCrossMemoryBlock) parts.push(lifecycleCrossMemoryBlock);
  } else if (injectableCrossMemory.length > 0) {
```

to:

```typescript
  if (inspectedOptions) {
    if (lifecycleCrossMemoryBlock) parts.push(lifecycleCrossMemoryBlock);
    if (dialogueMemoryBlock) parts.push(dialogueMemoryBlock);
  } else if (injectableCrossMemory.length > 0) {
```

This preserves the existing behavior exactly for every caller that only ever passes `{ lifecycleCrossMemory }` (the `inspectedOptions` truthiness check and the old-cross-memory-fallback branch are both untouched), and additively injects the new dialogue block only when present.

- [ ] **Step 5: Write the failing test for the new field**

Find the existing test file covering `inspectContextPromptOptions`/`buildContextPrompt`'s options handling:
```bash
grep -rl "inspectContextPromptOptions\|lifecycleCrossMemory" supabase/functions/_shared/*.cases.test.ts
```
Add test cases to it (do not create a new file — extend the existing one, matching this codebase's "one file per module" convention):
```typescript
it("injects the dialogue memory block alongside the lifecycle block when both are present", () => {
  const result = buildContextPrompt(packet(), {
    lifecycleCrossMemory: lifecycleContextWithOneItem(),
    dialogueMemory: dialogueContextWithOneItem(),
  });
  assert.match(result, /MEMORY V3 — CROSS-CONVERSATION CONTEXT/);
  assert.match(result, /MEMORY V3 — THIS DIALOGUE'S CONTEXT/);
});

it("injects only the dialogue block when lifecycle memory is absent", () => {
  const result = buildContextPrompt(packet(), {
    dialogueMemory: dialogueContextWithOneItem(),
  });
  assert.doesNotMatch(result, /CROSS-CONVERSATION CONTEXT/);
  assert.match(result, /THIS DIALOGUE'S CONTEXT/);
});

it("rejects an options object with an unknown key or a duplicate field", () => {
  assert.throws(() => buildContextPrompt(packet(), {
    lifecycleCrossMemory: lifecycleContextWithOneItem(),
    // deno-lint-ignore no-explicit-any
    extra: "not allowed",
  } as any));
});
```
(build `lifecycleContextWithOneItem()`/`dialogueContextWithOneItem()` helper fixtures matching whatever fixture style the existing test file already uses for `MemoryV3LifecycleReadContext` — mirror it for the dialogue shape, which is structurally identical.)

- [ ] **Step 6: Run test to verify it fails**

Run: `npx tsx --test <the test file found above>`
Expected: FAIL — `dialogueMemory` field not yet recognized.

- [ ] **Step 7: Apply the `context.ts` changes from Part B above**

- [ ] **Step 8: Run test to verify it passes, and that every pre-existing test in the same file still passes**

Run: `npx tsx --test <the test file found above>`
Expected: PASS, including every test that existed before this task (the single-field `lifecycleCrossMemory`-only path must be byte-for-byte unaffected).

- [ ] **Step 9: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/context.ts supabase/functions/_shared/memoryV3/dialogueReadPrompt.ts`
Expected: same error count as a `git stash`d baseline check of `context.ts` alone (the new file adds zero errors).

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueReadPrompt.ts supabase/functions/_shared/memoryV3/dialogueReadPrompt.cases.test.ts supabase/functions/_shared/context.ts <the extended test file>
git commit -m "feat: inject dialogue-scoped memory into the prompt alongside the legacy snapshot"
```

---

### Task 8: Wire into `staysee-chat/index.ts` and final regression sweep

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts` (the write-path block around today's `memoryV3ShadowPromise` async IIFE, and the read-path block around today's `createMemoryV3LifecycleReadStore(...).load(userId)` call — both already read in full earlier in this session)

**Interfaces:**
- Consumes: everything from Tasks 2-7 plus already-shipped `dialogueStore.ts` (`createMemoryV3DialogueStore`), `dialogueReadStore.ts` (`createMemoryV3DialogueReadStore`), `dialogueMode.ts` (Task 5: `resolveMemoryV3DialogueEligibility`).
- Produces: the live behavior change. No later task depends on this.

**Write path.** Inside the existing `memoryV3ShadowPromise` async block, after the line `if (!crossMemoryOnForWrite) return;` (added by PR #48) and before the existing `const memoryV3Mode = parseMemoryV3ShadowMode(...)` line, add:

```typescript
            const dialogueEligibility = resolveMemoryV3DialogueEligibility({
              rawMode: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_MODE"),
              rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID"),
              userId,
            });
            if (dialogueEligibility.eligible) {
              return runMemoryV3DialogueShadowBackgroundSafely(
                () => runMemoryV3DialogueShadow({
                  userId,
                  conversationId,
                  apiKey: Deno.env.get("OPENROUTER_API_KEY"),
                  loadMessages: createMemoryV3MessageLoader(svc),
                  store: createMemoryV3DialogueStore(svc),
                  extractorAdapterFactory: (apiKey) => createMemoryV3OpenRouterAdapter({
                    apiKey,
                    fetchImpl: globalThis.fetch.bind(globalThis),
                  }),
                  reconcilerAdapterFactory: (apiKey) => createMemoryV3DialogueOpenRouterAdapter({
                    apiKey,
                    fetchImpl: globalThis.fetch.bind(globalThis),
                  }),
                }, (code) => console.error("[memory-v3-dialogue-transport]", code),
                  (usage) => logMemoryV3LifecycleUsage(svc, usage)),
                (code) => console.error("[memory-v3-dialogue-shadow]", code),
              );
            }
```

This makes the branch mutually exclusive: if `dialogueEligibility.eligible`, the function `return`s before reaching the existing `parseMemoryV3ShadowMode`/`runMemoryV3LifecycleShadow` branch below it, so a canary user's write goes to the dialogue runner only, never both.

Add these imports near the existing `lifecycleShadowRunner.ts` and `lifecycleTransport.ts` imports:

```typescript
import {
  runMemoryV3DialogueShadow,
  runMemoryV3DialogueShadowBackgroundSafely,
} from "../_shared/memoryV3/dialogueShadowRunner.ts";
import { createMemoryV3DialogueOpenRouterAdapter } from "../_shared/memoryV3/dialogueTransport.ts";
import { createMemoryV3DialogueStore } from "../_shared/memoryV3/dialogueStore.ts";
import { resolveMemoryV3DialogueEligibility } from "../_shared/memoryV3/dialogueMode.ts";
```

**Read path.** Inside the existing block that computes `lifecycleCrossMemory` (around the `if (lifecycleReadEligibility.eligible) { ... }` block), after that block closes, add an independent, additive check — it must not be nested inside the lifecycle eligibility check, since a canary user's dialogue memory should show even if the (separately-gated) lifecycle read mode were ever turned off:

```typescript
        let dialogueMemory: MemoryV3DialogueReadContext | undefined;
        const dialogueReadEligibility = resolveMemoryV3DialogueEligibility({
          rawMode: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_MODE"),
          rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID"),
          userId,
        });
        if (dialogueReadEligibility.eligible && conversationId) {
          const crossMemoryOnForDialogueRead = await fetchCrossMemoryEnabled(
            makeServiceClient(),
            dialogueReadEligibility.userId,
          );
          if (crossMemoryOnForDialogueRead) {
            try {
              const loadedDialogue = await createMemoryV3DialogueReadStore(
                makeServiceClient(),
              ).load(dialogueReadEligibility.userId, conversationId);
              if (loadedDialogue !== null) dialogueMemory = loadedDialogue;
            } catch {
              console.error("[staysee-chat] dialogue read load_failed");
            }
          }
        }
```

Then change the two `buildContextPrompt` call sites (there are two in the file today — one for the primary reply, one for a fallback/retry path; find both with `grep -n "buildContextPrompt(trimmedPacket" supabase/functions/staysee-chat/index.ts` and update both identically) from:

```typescript
            contextPrompt = buildContextPrompt(trimmedPacket, {
              lifecycleCrossMemory,
            });
```

to build the options object conditionally so it still works when only one, both, or neither of the two fields is present (reuse the exact `if (lifecycleCrossMemory !== undefined) { ... }` gating already there — do not call `buildContextPrompt` with an options object at all when both are `undefined`, matching the existing all-or-nothing-object convention Task 7 preserved):

```typescript
        if (lifecycleCrossMemory !== undefined || dialogueMemory !== undefined) {
          try {
            contextPrompt = buildContextPrompt(trimmedPacket, {
              ...(lifecycleCrossMemory !== undefined ? { lifecycleCrossMemory } : {}),
              ...(dialogueMemory !== undefined ? { dialogueMemory } : {}),
            });
```

(read the surrounding `if (lifecycleCrossMemory !== undefined) { ... } else { ... }` block in full first — there is an `else` branch that calls `buildContextPrompt(trimmedPacket)` with no second argument at all for the no-memory case; keep that `else` branch reachable only when *both* are `undefined`.)

Add the import: `import { createMemoryV3DialogueReadStore, type MemoryV3DialogueReadContext } from "../_shared/memoryV3/dialogueReadStore.ts";`

**Canary configuration note (not a code change):** the plan does not hardcode any user id. Whoever deploys this (Настя, via the Supabase dashboard's Edge Function secrets page, the same place `STAYSEE_MEMORY_V3_SHADOW_USER_ID` already lives) must set `STAYSEE_MEMORY_V3_DIALOGUE_MODE=dialogue_canary` and `STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID=<her account's uuid>` after this PR is deployed — leaving both unset means `resolveMemoryV3DialogueEligibility` returns `disabled` for everyone and this entire change is a no-op in production until she sets them, which is the intended safe default.

- [ ] **Step 1: Write a wiring test**

Find the existing wiring test file that source-greps `staysee-chat/index.ts` for the lifecycle write/read blocks (check `stayseeChatWiring.cases.test.ts` and `fullRolloutWiring.cases.test.ts` for the pattern to mirror — they read the file as text and regex-match structural properties, they don't execute the handler). Add equivalent assertions:

```typescript
it("branches to the dialogue runner before the lifecycle runner, mutually exclusively", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  const writeBlockStart = source.indexOf("const memoryV3ShadowPromise");
  const writeBlockEnd = source.indexOf("EdgeRuntime.waitUntil(", writeBlockStart);
  const block = source.slice(writeBlockStart, writeBlockEnd);
  assert.match(block, /resolveMemoryV3DialogueEligibility/);
  assert.ok(
    block.indexOf("dialogueEligibility.eligible") < block.indexOf("parseMemoryV3ShadowMode"),
    "dialogue eligibility must be checked, and return, before the lifecycle mode branch",
  );
  assert.match(block, /runMemoryV3DialogueShadowBackgroundSafely/);
});

it("loads dialogue memory additively, independent of the lifecycle read gate", () => {
  const source = readFileSync(INDEX_URL, "utf8");
  assert.match(source, /resolveMemoryV3DialogueEligibility/);
  assert.match(source, /createMemoryV3DialogueReadStore/);
  assert.match(source, /dialogueMemory\s*!==\s*undefined/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — none of the new symbols exist in `index.ts` yet.

- [ ] **Step 3: Apply the write-path and read-path changes above**

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Full regression sweep**

Run, in order, comparing every count against a `git stash`d clean-`main` baseline run of the same commands:
```bash
"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/staysee-chat/index.ts
npx tsx --test supabase/functions/_shared/memoryV3/*.cases.test.ts
shopt -s globstar && npx tsx --test supabase/functions/_shared/**/*.cases.test.ts
```
Expected: `deno check` error count unchanged from baseline (41, per every prior check this session); memoryV3 suite 100% pass; full `_shared` suite pass except the one pre-existing unrelated `narrativeEngine.cases.test.ts` failure.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/staysee-chat/index.ts <the wiring test file>
git commit -m "feat: wire dialogue-scoped Memory V3 into staysee-chat's write and read paths, gated to canary"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin <branch-name>
gh pr create --base main --title "..." --body "..."
```

Do not merge. Report the PR link and stop — merging requires the user's explicit real-time confirmation in this conversation, and deploying to production is never done by the agent.
