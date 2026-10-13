# Memory V3 Extractor/Reconciler Delta Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution mode chosen for this plan:** inline (native), via `superpowers:executing-plans`, in one session, with tasks strictly in order. The tasks are tightly coupled through shared interfaces: the loader's new cursor parameter, the stores' `lastSucceededCursor`, and the runners' empty-extraction fast path, which the cursor-sequence tests rely on. Sequential native execution fits better than per-task subagents.

**Goal:** Cut Memory V3's per-message extractor/reconciler cost in three ways. Load only the messages that a conversation's last succeeded run has not seen yet. Send the reconciler only the messages that the new candidates cite. Skip the reconciler entirely when the extractor finds nothing.

**Architecture:**
- Each shadow runner (dialogue, lifecycle) first asks its own store for this conversation's last *succeeded* run's `source_last_message_id` / `source_last_created_at`. That is a plain SELECT; there is no migration.
- The runner then calls the shared message loader with that cursor:
  - no cursor → today's last-60 window, unchanged;
  - cursor → the newest ≤55 messages after it, plus the 5 at or before it, capped at 4000 estimated tokens by dropping the oldest delta messages.
- The reconcile-request builders keep validating the full window but forward only evidence-cited messages.
- An empty extraction finishes as a normal succeeded no-op through `compareAndSwap`, without calling the reconciler.

**Tech Stack:** TypeScript Supabase Edge Function modules (Deno at runtime). They are tested offline with Node's `node:test` through `tsx` (`node node_modules/tsx/dist/cli.mjs --test <file>`; whole suite: `node scripts/run-offline-tests.mjs`). supabase-js query builders are replaced by hand-written fakes.

**Spec:** `docs/superpowers/specs/2026-10-13-memory-v3-extractor-reconciler-delta-design.md`

## Global Constraints

- **Delta token cap.** **4000** estimated tokens, using the project's `estimateTokens` rule (`Math.ceil(text.length / 3.5)`). It is measured over leading context + delta together, and applies only when a cursor exists.
- **Leading context.** The **5** messages at or before the cursor (`created_at <= cursor`). The token cap never drops them.
- **Truncation order.** Drop from the **oldest end of the delta** first and keep the most recent messages. This plan also never drops the single newest delta message.
- **Delta fetch bound.** The newest **55** messages after the cursor. That keeps context + delta ≤ **60**, which equals `MEMORY_V3_MAX_SOURCE_MESSAGES` and the run tables' `message_count BETWEEN 1 AND 60` CHECK.
- **No cursor.** When no run has succeeded yet for this (user, conversation), the loader runs **today's last-60 query, unchanged, with no token cap**.
- **What counts as the cursor.** Only runs with `status = 'succeeded'`, the same rule migration 077 applies to the lifecycle trigger gate. Failed or reserved runs never advance it.
- **Reconciler `messages`.** Only messages whose `id` is a `sourceMessageId` in the **new extraction's** evidence. Existing items' source text is never re-sent, and `state.items` stays full and unchanged.
- **Empty extraction** (`extraction.items.length === 0`):
  - the reconciler adapter is never invoked;
  - `compareAndSwap` is called exactly once with: `state` unchanged; `changed: false`; `stateRevision` unchanged; `extraction.items` and `extraction.evidence` both `[]`; `operations: []`; `transitions: []`; `extractorUsage` = the real extractor usage; `reconcilerUsage: null`;
  - the result is `{status:"succeeded", runId, itemCount:0, evidenceCount:0, transitionCount:0, stateRevision}`.
- **Out of scope; do not touch:**
  - merging the extractor and reconciler;
  - semantic narrowing of `state.items`;
  - reservation/trigger gates, and all migrations (no new migration);
  - `contract.ts`, `dialogueContract.ts`, `lifecycleContract.ts`, `dialogueReducer.ts`, `lifecycleReducer.ts`, `dialogueTransport.ts`, `lifecycleTransport.ts`;
  - `supabase/functions/staysee-chat/index.ts`. Its existing `createMemoryV3MessageLoader(svc)` / `create*Store(svc)` wiring already supplies everything.
- **Byte cap untouched.** The existing 20 KB extractor byte cap (`fitExtractorDialogueToByteCap`) stays exactly as it is.
- **Node-importable `messages.ts`.** Tests run under Node + tsx, not Deno, and `scripts/memory-v3-pilot` tooling imports `messages.ts` at runtime. So `messages.ts` must not import `cost.ts`, which carries an `npm:` specifier and reads `Deno.env` at import time.
- **Frozen hashes.** `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` pins the SHA-256 of `messages.ts` and `lifecyclePrompt.ts` as a deliberate "did you mean to change this" gate. This plan intentionally changes both files and re-pins those two hashes (precedent: commit 3d2a19f). The hashes are over the CRLF bytes a Windows checkout produces (`core.autocrlf=true`; CI `verify` runs on `windows-latest`).
- **Staging.** Never run `git add -A` or `git add .`: `supabase/.temp/cli-latest` carries an unrelated modification. Stage explicit paths only.
- **Commit trailer.** Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Nothing new since the last succeeded run** (a re-trigger, or two triggers racing).
   - Expected: the loader returns just the 5-message context block and the run proceeds normally. No crash, no `invalid_source`, no Telegram alert.
   - Test: Task 2, "returns just the context block when nothing new arrived since the cursor".
2. **The cursor lookup itself fails** (missing grant, network blip, malformed row).
   - Expected: the run continues with today's full last-60 window. It never fails the run and never skips unanalyzed messages.
   - Tests: Task 8 and Task 10, "falls back to the full window, never failing the run, ...".
3. **A candidate cites a message outside the reconciler's window** (spec Review Focus 1).
   - Expected: the builder rejects it, and the runner maps that to `reconciler_contract_invalid`. A request is never sent silently missing its source.
   - Tests: Task 3 and Task 4, "rejects a candidate citing a message outside the window ...".
4. **First run on a long pre-rollout conversation** (>60 messages, far beyond 4000 tokens; spec Review Focus 2).
   - Expected: exactly today's last-60 query, neither token-capped nor widened.
   - Test: Task 2, "never token-caps a first run, even a long pre-rollout conversation".
5. **Same user, two conversations** (lifecycle; spec Review Focus 3).
   - Expected: each conversation's cursor is independent.
   - Tests: Task 9, "keeps each conversation's cursor independent for the same user"; Task 10 also asserts the runner looks up with its own `conversationId`.

## Decisions this plan makes where the spec is silent (read before executing)

- **Where `estimateTokens` lives.** Importing `cost.ts` into `messages.ts` would break every Node-run importer of `messages.ts`: `messages.cases.test.ts` and `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.ts`. Task 1 moves the single implementation verbatim into the dependency-free `supabase/functions/_shared/tokenEstimate.ts`, and `cost.ts` re-exports it. Every existing `import { estimateTokens } from "./cost.ts"` stays unchanged.
- **Where the reconciler filter sits.** The builders validate the *full* window first, as today, and only then filter to cited messages. Filtering earlier would silently move `session.sourceLastMessageId` / `sourceLastCreatedAt` (derived from the window's last message) onto the last *cited* message.
- **Empty extraction inside the builder.** Live runners no longer build a reconcile request for an empty extraction (fast path). But the history-backfill engines and the lifecycle model benchmark still call the reconciler for empty chunks through the real transports, and those reject `messages.length === 0`. So when nothing is cited, the builder sends only the window's last message, the session anchor.
- **Empty delta.** The window is the context block only (Review Focus 1). For lifecycle, the existing 10-new-message reservation gate returns `daily_cap` before any model call. For dialogue, it costs at most one small extractor call on a rare re-trigger.
- **Cursor lookup failure.** The cursor becomes `null` (full last-60 window), with a fixed-literal `console.error`. The run never fails because of it.
- **Store method.** `lastSucceededCursor({ userId, conversationId })` on both stores, using the existing service-role client's `from()`. service_role already holds `SELECT` on both run tables (migrations 034/039). `from` is optional in the client type and is looked up only when the method runs, so rpc-only clients still construct.
- **Cursor ordering.** The cursor is the maximum over succeeded runs **by source position** (`source_last_created_at DESC, source_last_message_id DESC`), not by completion time. A late-finishing run with an older window can never move it backwards (the spec's race-safety bullet).
- **Files touched beyond the spec's list:**
  - `tokenEstimate.ts` (new) and `cost.ts` (re-export);
  - `dialogueStore.ts` and `lifecycleStore.ts` (home of the lookup);
  - `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts` (it asserted the old "all messages" request shape);
  - `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` (two pinned hashes).

## Pre-flight

The worktree is on `fix/memory-v3-lifecycle-watermark-restore`, with the spec committed as `640b842`. Before Task 1, ask your human partner whether to keep committing on this branch or to branch off this commit (for example `git switch -c feat/memory-v3-delta-windowing`). Task 11 diffs against `640b842` either way.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/functions/_shared/tokenEstimate.ts` | Dependency-free `estimateTokens` | Create |
| `supabase/functions/_shared/tokenEstimate.cases.test.ts` | Pins the rule and the re-export | Create |
| `supabase/functions/_shared/cost.ts` | Re-exports `estimateTokens` | Modify lines 363-366 |
| `supabase/functions/_shared/memoryV3/messages.ts` | `MemoryV3SourceCursor`, delta constants, delta-aware loader | Modify |
| `supabase/functions/_shared/memoryV3/messages.cases.test.ts` | Loader delta tests | Modify |
| `supabase/functions/_shared/memoryV3/dialoguePrompt.ts` | Evidence-only reconciler `messages` | Modify lines 318-361 |
| `supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts` | Evidence-only tests | Modify (append) |
| `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts` | Evidence-only reconciler `messages` | Modify lines 317-360 |
| `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` | Evidence-only tests | Modify (append) |
| `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts` | Fast path, shared CAS helper, cursor lookup | Modify |
| `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts` | Fast-path and cursor tests | Modify |
| `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts` | Fast path, shared CAS helper, cursor lookup | Modify |
| `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts` | Fast-path and cursor tests | Modify |
| `supabase/functions/_shared/memoryV3/dialogueStore.ts` | `lastSucceededCursor` | Modify |
| `supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts` | Cursor-read tests | Modify (append) |
| `supabase/functions/_shared/memoryV3/lifecycleStore.ts` | `lastSucceededCursor` | Modify |
| `supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts` | Cursor-read tests | Modify (append) |
| `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts` | Evidence-only assertion | Modify line 208 |
| `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` | Two pinned hashes | Modify lines 25 and 33 |

---

### Task 1: Dependency-free `estimateTokens`

**Files:**
- Create: `supabase/functions/_shared/tokenEstimate.ts`
- Create: `supabase/functions/_shared/tokenEstimate.cases.test.ts`
- Modify: `supabase/functions/_shared/cost.ts:363-366`

**Interfaces:**
- Consumes: nothing.
- Produces: `estimateTokens(text: string): number`, exported from `supabase/functions/_shared/tokenEstimate.ts`. Import path from `memoryV3/messages.ts` is `"../tokenEstimate.ts"`. `cost.ts` keeps exporting the same name.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/tokenEstimate.cases.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { estimateTokens } from "./tokenEstimate.ts";

test("estimateTokens keeps cost.ts's chars/3.5 round-up rule", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("я".repeat(700)), 200);
  assert.equal(estimateTokens("x".repeat(701)), 201);
});

test("cost.ts re-exports the one shared implementation instead of keeping its own copy", () => {
  const source = readFileSync(new URL("./cost.ts", import.meta.url), "utf8");
  assert.match(source, /export \{ estimateTokens \} from "\.\/tokenEstimate\.ts";/);
  assert.doesNotMatch(source, /function estimateTokens/);
});

test("tokenEstimate.ts stays dependency-free so Node-run Memory V3 modules can import it", () => {
  const source = readFileSync(new URL("./tokenEstimate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bDeno\./);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/tokenEstimate.cases.test.ts`

Expected: FAIL, with `ERR_MODULE_NOT_FOUND` for `.../_shared/tokenEstimate.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `supabase/functions/_shared/tokenEstimate.ts`:

```ts
// ── Token estimation (rough, no tokenizer needed) ────────────────────────────
//
// Deliberately dependency-free: cost.ts re-exports this, and modules that must
// stay importable under plain Node (memoryV3/messages.ts, loaded by the
// offline test runner and by scripts/memory-v3-pilot tooling) import it from
// here directly instead of pulling in cost.ts's Edge-only imports.

export function estimateTokens(text: string): number {
  // ~1 token per 3.5 chars is a conservative estimate for mixed Russian/English
  return Math.ceil(text.length / 3.5);
}
```

In `supabase/functions/_shared/cost.ts`, replace exactly this block (lines 363-366):

```ts
export function estimateTokens(text: string): number {
  // ~1 token per 3.5 chars is a conservative estimate for mixed Russian/English
  return Math.ceil(text.length / 3.5);
}
```

with:

```ts
export { estimateTokens } from "./tokenEstimate.ts";
```

Leave the `// ── Token estimation ...` heading line above it as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/tokenEstimate.cases.test.ts`

Expected: PASS, 3 tests, 0 failures.

Then run the existing `cost.ts` importers: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/cost.cases.test.ts supabase/functions/_shared/memorySummaryTone.cases.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/tokenEstimate.ts supabase/functions/_shared/tokenEstimate.cases.test.ts supabase/functions/_shared/cost.ts
git commit -m "$(cat <<'EOF'
refactor: move estimateTokens into a dependency-free module

cost.ts pulls in npm:@supabase/supabase-js and Deno.env-reading Edge
modules, so Node-run Memory V3 code (messages.ts, loaded by the offline
test runner and by scripts/memory-v3-pilot tooling) can't import it.
One implementation, now in _shared/tokenEstimate.ts; cost.ts re-exports
it so every existing importer is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Delta-aware message loader

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/messages.ts`:
  - lines 1-10 (header);
  - line 16 (`ROW_FIELDS`);
  - lines 54-73 (`inspectDenseArray`);
  - lines 99-124 (`projectMemoryV3SourceRows`);
  - lines 183-210 (`createMemoryV3MessageLoader`).
- Modify: `supabase/functions/_shared/memoryV3/messages.cases.test.ts` (line 4 import; append tests at the end).
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts:33`

**Interfaces:**
- Consumes: `estimateTokens(text: string): number` from `../tokenEstimate.ts` (Task 1).
- Produces (all exported from `supabase/functions/_shared/memoryV3/messages.ts`):

```ts
export interface MemoryV3SourceCursor { messageId: string; createdAt: string }
export const MEMORY_V3_DELTA_CONTEXT_MESSAGES = 5;
export const MEMORY_V3_DELTA_MAX_MESSAGES = 55;
export const MEMORY_V3_DELTA_MAX_TOKENS = 4_000;
export function createMemoryV3MessageLoader(client: MemoryV3MessageClient): (
  userId: string,
  conversationId: string,
  sinceCursor?: MemoryV3SourceCursor | null,
) => Promise<MemoryV3DialogueMessage[]>;
```

- [ ] **Step 1: Write the failing tests**

In `supabase/functions/_shared/memoryV3/messages.cases.test.ts`, replace line 4:

```ts
import { createMemoryV3MessageLoader, projectMemoryV3SourceRows } from "./messages.ts";
```

with:

```ts
import { MEMORY_V3_MAX_SOURCE_MESSAGES } from "./contract.ts";
import {
  MEMORY_V3_DELTA_CONTEXT_MESSAGES,
  MEMORY_V3_DELTA_MAX_MESSAGES,
  MEMORY_V3_DELTA_MAX_TOKENS,
  createMemoryV3MessageLoader,
  projectMemoryV3SourceRows,
} from "./messages.ts";
```

Append to the end of the same file:

```ts
// ── Delta windowing (spec 2026-10-13 §1) ─────────────────────────────────────

const TOKEN_200_TEXT = "я".repeat(700); // estimateTokens -> exactly 200

function timeline(index: number): string {
  return new Date(Date.UTC(2026, 8, 5, 10, 0, index)).toISOString();
}

function messageRow(index: number, content = TOKEN_200_TEXT) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sender: index % 2 === 1 ? "user" : "ai",
    content,
    created_at: timeline(index),
  };
}

function cursorAt(index: number) {
  return { messageId: messageRow(index).id, createdAt: timeline(index) };
}

type DeltaFakeOptions = { contextRows: unknown[]; deltaRows: unknown[]; deltaError?: unknown };

function createDeltaFakeClient(options: DeltaFakeOptions) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  function builder(table: string) {
    let range: "delta" | "context" | null = null;
    const chain = {
      select(columns: string) { calls.push({ method: "select", args: [table, columns] }); return chain; },
      eq(column: string, value: unknown) { calls.push({ method: "eq", args: [table, column, value] }); return chain; },
      gt(column: string, value: unknown) { range = "delta"; calls.push({ method: "gt", args: [table, column, value] }); return chain; },
      lte(column: string, value: unknown) { range = "context"; calls.push({ method: "lte", args: [table, column, value] }); return chain; },
      order(column: string, config: unknown) { calls.push({ method: "order", args: [table, column, config] }); return chain; },
      limit(value: number) {
        calls.push({ method: "limit", args: [table, value] });
        // The database answers both ranges newest-first.
        const rows = range === "delta" ? options.deltaRows : range === "context" ? options.contextRows : [];
        return Promise.resolve({
          data: [...rows].reverse(),
          error: range === "delta" ? options.deltaError ?? null : null,
        });
      },
      maybeSingle() {
        calls.push({ method: "maybeSingle", args: [table] });
        return Promise.resolve({ data: { id: CONVERSATION_ID }, error: null });
      },
    };
    return chain;
  }
  return { calls, client: { from(table: string) { calls.push({ method: "from", args: [table] }); return builder(table); } } };
}

test("delta constants keep context + delta inside the 60-message source cap", () => {
  assert.equal(MEMORY_V3_DELTA_CONTEXT_MESSAGES, 5);
  assert.equal(MEMORY_V3_DELTA_MAX_TOKENS, 4_000);
  assert.equal(MEMORY_V3_DELTA_MAX_MESSAGES + MEMORY_V3_DELTA_CONTEXT_MESSAGES, MEMORY_V3_MAX_SOURCE_MESSAGES);
});

test("createMemoryV3MessageLoader keeps today's full last-60 window when there is no prior succeeded cursor", async () => {
  const fake = createFakeClient();
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, null);
  assert.deepEqual(result.map(({ id }) => id), [USER_MESSAGE_ID, AI_MESSAGE_ID]);
  assert.deepEqual(fake.calls.slice(5), [
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 60] },
  ]);
});

test("createMemoryV3MessageLoader never token-caps a first run, even a long pre-rollout conversation", async () => {
  const rows = Array.from({ length: 60 }, (_, index) => messageRow(index + 1)); // 60 x 200 = 12000 tokens
  const fake = createFakeClient({ rows });
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID);
  assert.equal(result.length, 60);
  assert.equal(fake.calls.at(-1)?.args[1], 60);
});

test("createMemoryV3MessageLoader loads only the delta plus the 5 messages ending at the cursor", async () => {
  const contextRows = [1, 2, 3, 4, 5].map((index) => messageRow(index, `Контекст ${index}`));
  const deltaRows = [6, 7, 8].map((index) => messageRow(index, `Новое ${index}`));
  const fake = createDeltaFakeClient({ contextRows, deltaRows });
  const cursor = cursorAt(5);
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursor);
  assert.deepEqual(result.map(({ id }) => id), [...contextRows, ...deltaRows].map(({ id }) => id));
  assert.deepEqual(fake.calls.slice(5), [
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "gt", args: ["messages", "created_at", cursor.createdAt] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 55] },
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "lte", args: ["messages", "created_at", cursor.createdAt] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 5] },
  ]);
});

test("createMemoryV3MessageLoader returns just the context block when nothing new arrived since the cursor", async () => {
  const contextRows = [1, 2, 3, 4, 5].map((index) => messageRow(index, `Контекст ${index}`));
  const fake = createDeltaFakeClient({ contextRows, deltaRows: [] });
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(5));
  assert.deepEqual(result.map(({ id }) => id), contextRows.map(({ id }) => id));
});

test("createMemoryV3MessageLoader caps context + delta at 4000 estimated tokens by dropping the oldest delta messages, never the context block", async () => {
  const contextRows = [1, 2, 3, 4, 5].map((index) => messageRow(index)); // 5 x 200 = 1000 tokens
  const deltaRows = Array.from({ length: 20 }, (_, offset) => messageRow(6 + offset)); // 20 x 200 = 4000 tokens
  const fake = createDeltaFakeClient({ contextRows, deltaRows });
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(5));
  assert.deepEqual(result.map(({ id }) => id), [...contextRows, ...deltaRows.slice(5)].map(({ id }) => id));
  assert.equal(result.reduce((sum, message) => sum + Math.ceil(message.text.length / 3.5), 0), 4_000);
});

test("createMemoryV3MessageLoader keeps the newest delta message even when it alone exceeds the token cap", async () => {
  const contextRows = [1, 2, 3, 4, 5].map((index) => messageRow(index));
  const deltaRows = [messageRow(6), messageRow(7, "я".repeat(14_000))];
  const fake = createDeltaFakeClient({ contextRows, deltaRows });
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(5));
  assert.deepEqual(result.map(({ id }) => id), [...contextRows.map(({ id }) => id), deltaRows[1].id]);
});

test("createMemoryV3MessageLoader rejects a malformed cursor before any database access", async () => {
  let getterCalls = 0;
  const accessor = { messageId: USER_MESSAGE_ID } as Record<string, unknown>;
  Object.defineProperty(accessor, "createdAt", {
    enumerable: true,
    get() { getterCalls += 1; return "2026-09-05T10:00:00.000Z"; },
  });
  for (const cursor of [
    { messageId: "not-a-uuid", createdAt: "2026-09-05T10:00:00.000Z" },
    { messageId: USER_MESSAGE_ID, createdAt: "yesterday" },
    { messageId: USER_MESSAGE_ID, createdAt: "2026-09-05T10:00:00.000Z", extra: "RAW_DB_SECRET_SENTINEL" },
    accessor,
  ]) {
    const fake = createDeltaFakeClient({ contextRows: [], deltaRows: [] });
    await assert.rejects(
      () => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursor as never),
      assertSafeError,
    );
    assert.equal(fake.calls.length, 0);
  }
  assert.equal(getterCalls, 0);
});

test("createMemoryV3MessageLoader rejects a delta that overlaps its own context block and safe-wraps delta query errors", async () => {
  const contextRows = [1, 2, 3, 4, 5].map((index) => messageRow(index));
  for (const options of [
    { contextRows, deltaRows: [messageRow(5)] },
    { contextRows, deltaRows: [messageRow(6)], deltaError: { message: "RAW_DB_SECRET_SENTINEL" } },
  ]) {
    const fake = createDeltaFakeClient(options);
    await assert.rejects(
      () => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(5)),
      assertSafeError,
    );
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/messages.cases.test.ts`

Expected: FAIL. The file does not load: `SyntaxError: The requested module './messages.ts' does not provide an export named 'MEMORY_V3_DELTA_CONTEXT_MESSAGES'`.

- [ ] **Step 3: Write the implementation**

All edits are in `supabase/functions/_shared/memoryV3/messages.ts`.

3a. Replace lines 1-10:

```ts
export interface MemoryV3DialogueMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface MemoryV3MessageClient {
  from(table: string): unknown;
}
```

with:

```ts
import { estimateTokens } from "../tokenEstimate.ts";

export interface MemoryV3DialogueMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/** A succeeded run's source position: the newest message that run analyzed. */
export interface MemoryV3SourceCursor {
  messageId: string;
  createdAt: string;
}

export interface MemoryV3MessageClient {
  from(table: string): unknown;
}

/** Messages at or before the cursor re-sent for continuity (spec 2026-10-13 §1). */
export const MEMORY_V3_DELTA_CONTEXT_MESSAGES = 5;
/** Newest delta messages fetched: the 60-message source cap (MEMORY_V3_MAX_SOURCE_MESSAGES) minus the context block. */
export const MEMORY_V3_DELTA_MAX_MESSAGES = 55;
/** Estimated-token budget (estimateTokens, chars/3.5) for context + delta together. */
export const MEMORY_V3_DELTA_MAX_TOKENS = 4_000;
```

3b. Replace:

```ts
const ROW_FIELDS = new Set(["id", "sender", "content", "created_at"]);
```

with:

```ts
const ROW_FIELDS = new Set(["id", "sender", "content", "created_at"]);
const CURSOR_FIELDS = new Set(["messageId", "createdAt"]);
```

3c. In `inspectDenseArray`, replace `function inspectDenseArray(value: unknown): unknown[] {` with `function inspectDenseArray(value: unknown, minimum = 1): unknown[] {`. Then replace `    if (length < 1 || length > 60 || keys.length !== length + 1) throw fail();` with `    if (length < minimum || length > 60 || keys.length !== length + 1) throw fail();`.

3d. Replace the whole existing `projectMemoryV3SourceRows` function (from `export function projectMemoryV3SourceRows(rows: unknown): MemoryV3DialogueMessage[] {` through its closing `}`) with:

```ts
function projectRow(source: unknown, ids: Set<string>): MemoryV3DialogueMessage {
  const row = inspectRow(source);
  if (!isCanonicalUuid(row.id) || ids.has(row.id)) throw fail();
  ids.add(row.id);
  if (row.sender !== "user" && row.sender !== "ai") throw fail();
  if (typeof row.content !== "string" || row.content.trim().length === 0) throw fail();
  if (!isValidIsoDateTime(row.created_at)) throw fail();
  return {
    id: row.id,
    role: row.sender === "user" ? "user" : "assistant",
    text: row.content,
    createdAt: row.created_at,
  };
}

function compareMessages(left: MemoryV3DialogueMessage, right: MemoryV3DialogueMessage): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byTime !== 0 ? byTime : compareCodeUnits(left.id, right.id);
}

export function projectMemoryV3SourceRows(rows: unknown): MemoryV3DialogueMessage[] {
  const sourceRows = inspectDenseArray(rows);
  const ids = new Set<string>();
  const projected = sourceRows.map((source) => projectRow(source, ids));
  if (!projected.some((message) => message.role === "user")) throw fail();
  return projected.sort(compareMessages);
}

function inspectCursor(value: unknown): MemoryV3SourceCursor {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("invalid cursor");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== CURSOR_FIELDS.size) throw fail("invalid cursor");
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !CURSOR_FIELDS.has(key)) throw fail("invalid cursor");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("invalid cursor");
      copy[key] = descriptor.value;
    }
    const messageId = copy.messageId;
    const createdAt = copy.createdAt;
    if (!isCanonicalUuid(messageId) || !isValidIsoDateTime(createdAt)) throw fail("invalid cursor");
    return { messageId, createdAt };
  } catch (error) {
    rethrowSafe(error, "invalid cursor");
  }
}

// Spec 2026-10-13 §1: at most MEMORY_V3_DELTA_MAX_TOKENS estimated tokens
// across context + delta. Drops the oldest delta messages first; never the
// context block, and never the single newest delta message (dropping it
// would leave nothing new to analyze).
function capDeltaToTokenBudget(
  context: MemoryV3DialogueMessage[],
  delta: MemoryV3DialogueMessage[],
): MemoryV3DialogueMessage[] {
  let total = [...context, ...delta].reduce((sum, message) => sum + estimateTokens(message.text), 0);
  let start = 0;
  while (total > MEMORY_V3_DELTA_MAX_TOKENS && start < delta.length - 1) {
    total -= estimateTokens(delta[start].text);
    start += 1;
  }
  return delta.slice(start);
}
```

3e. Replace the whole existing `createMemoryV3MessageLoader` function (from `export function createMemoryV3MessageLoader(` through its final closing `}`) with:

```ts
function selectConversationMessages(client: MemoryV3MessageClient, conversationId: string): unknown {
  const query = call(call(client, "from", "messages"), "select", "id, sender, content, created_at");
  return call(query, "eq", "conversation_id", conversationId);
}

// Delta mode (spec 2026-10-13 §1): the newest messages after the cursor plus
// the few at/before it for continuity. Both queries run newest-first so an
// over-long delta keeps its most recent messages; results are re-sorted
// chronologically before the token cap is applied.
async function loadDeltaWindow(
  client: MemoryV3MessageClient,
  conversationId: string,
  cursor: MemoryV3SourceCursor,
): Promise<MemoryV3DialogueMessage[]> {
  let deltaQuery = call(selectConversationMessages(client, conversationId), "gt", "created_at", cursor.createdAt);
  deltaQuery = call(deltaQuery, "order", "created_at", { ascending: false });
  deltaQuery = call(deltaQuery, "order", "id", { ascending: false });
  const delta = inspectResponse(await call(deltaQuery, "limit", MEMORY_V3_DELTA_MAX_MESSAGES));
  if (delta.error !== null) throw fail("message query failed");

  let contextQuery = call(selectConversationMessages(client, conversationId), "lte", "created_at", cursor.createdAt);
  contextQuery = call(contextQuery, "order", "created_at", { ascending: false });
  contextQuery = call(contextQuery, "order", "id", { ascending: false });
  const context = inspectResponse(await call(contextQuery, "limit", MEMORY_V3_DELTA_CONTEXT_MESSAGES));
  if (context.error !== null) throw fail("message query failed");

  const ids = new Set<string>();
  const contextMessages = inspectDenseArray(context.data, 0).map((row) => projectRow(row, ids)).sort(compareMessages);
  const deltaMessages = inspectDenseArray(delta.data, 0).map((row) => projectRow(row, ids)).sort(compareMessages);
  const loaded = [...contextMessages, ...capDeltaToTokenBudget(contextMessages, deltaMessages)];
  if (loaded.length === 0 || !loaded.some((message) => message.role === "user")) throw fail();
  return loaded;
}

export function createMemoryV3MessageLoader(
  client: MemoryV3MessageClient,
): (
  userId: string,
  conversationId: string,
  sinceCursor?: MemoryV3SourceCursor | null,
) => Promise<MemoryV3DialogueMessage[]> {
  getMethod(client, "from");
  return async (userId: string, conversationId: string, sinceCursor?: MemoryV3SourceCursor | null) => {
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(conversationId)) throw fail("invalid identifiers");
    const cursor = sinceCursor === undefined || sinceCursor === null ? null : inspectCursor(sinceCursor);
    try {
      let ownershipQuery = call(client, "from", "conversations");
      ownershipQuery = call(ownershipQuery, "select", "id");
      ownershipQuery = call(ownershipQuery, "eq", "id", conversationId);
      ownershipQuery = call(ownershipQuery, "eq", "user_id", userId);
      const ownership = inspectResponse(await call(ownershipQuery, "maybeSingle"));
      if (ownership.error !== null || ownership.data === null) throw fail("conversation is not owned");
      inspectOwnedConversation(ownership.data, conversationId);

      if (cursor !== null) return await loadDeltaWindow(client, conversationId, cursor);

      // No succeeded run yet: exactly the pre-delta last-60 window, and
      // deliberately not token-capped (spec 2026-10-13 Review Focus).
      let messagesQuery = call(selectConversationMessages(client, conversationId), "order", "created_at", { ascending: false });
      messagesQuery = call(messagesQuery, "order", "id", { ascending: false });
      const response = inspectResponse(await call(messagesQuery, "limit", 60));
      if (response.error !== null) throw fail("message query failed");
      return projectMemoryV3SourceRows(response.data);
    } catch (error) {
      rethrowSafe(error, "message load failed");
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/messages.cases.test.ts`

Expected: PASS, 22 tests (13 existing + 9 new), 0 failures. The existing exact call-sequence test still passes, which proves the no-cursor path is unchanged.

- [ ] **Step 5: Re-pin `messages.ts` in the lifecycle-backfill frozen-source gate**

`scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` pins the bytes of `messages.ts` as a "did you mean to change this" gate. This change is intentional (precedent: 3d2a19f). Hash the file exactly as a Windows checkout materializes it:

```bash
git add supabase/functions/_shared/memoryV3/messages.ts
rm supabase/functions/_shared/memoryV3/messages.ts
git checkout -- supabase/functions/_shared/memoryV3/messages.ts
sha256sum supabase/functions/_shared/memoryV3/messages.ts | cut -d' ' -f1 | tr 'a-f' 'A-F'
```

Expected: one 64-character uppercase hex string, different from `77CCE382D809C51198703CD1A9A61F1D3DF4B1ADFB7CF60B5C74556FF73C24E4`.

In `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts`, line 33 sits under `'supabase/functions/_shared/memoryV3/messages.ts':`. Replace the literal `'77CCE382D809C51198703CD1A9A61F1D3DF4B1ADFB7CF60B5C74556FF73C24E4'` there with the exact value the command printed, in single quotes. Change nothing else in that file.

- [ ] **Step 6: Run the frozen gate and a Node importer of `messages.ts`**

Run: `node node_modules/tsx/dist/cli.mjs --test scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/messages.ts supabase/functions/_shared/memoryV3/messages.cases.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
git commit -m "$(cat <<'EOF'
feat: Memory V3 loader reads only the unseen delta once a run has succeeded

With a cursor (the conversation's last succeeded run), load the newest
55 messages after it plus the 5 at/before it for continuity, capped at
4000 estimated tokens by dropping the oldest delta messages -- never
the context block, never the newest message. Without a cursor the
existing last-60 query runs unchanged and uncapped. Re-pins messages.ts
in the lifecycle backfill frozen-source gate (intentional change).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Dialogue reconciler receives only evidence-cited messages

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/dialoguePrompt.ts:318-361`
- Modify: `supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts` (append at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildMemoryV3DialogueReconcileRequest(input)`, with signature and bindings unchanged. `request.input.messages` is now the chronologically sorted subset whose ids appear in `extraction.evidence[].sourceMessageId`, or `[lastWindowMessage]` when nothing is cited. `request.input.session` still describes the full window's last message.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts`:

```ts
describe("Memory V3 dialogue reconciler evidence-only messages", () => {
  it("sends only the messages the new candidates cite, in chronological order", () => {
    const bundle = build();
    assert.deepEqual(
      bundle.request.input.messages.map((message) => message.id),
      [MESSAGE_IDS[0], MESSAGE_IDS[2], MESSAGE_IDS[4]],
    );
    assert.equal(bundle.request.input.messages.some((message) => message.role === "assistant"), false);
  });

  it("keeps the session pointing at the full window's last message even when that message is not cited", () => {
    const single = extraction();
    single.items = single.items.filter((item) => item.localItemKey === "Z-candidate");
    single.evidence = single.evidence.filter((row) => row.itemKey === "Z-candidate");
    const bundle = build({ extraction: single });
    assert.deepEqual(bundle.request.input.messages.map((message) => message.id), [MESSAGE_IDS[2]]);
    assert.deepEqual(bundle.request.input.session, {
      conversationId: CONVERSATION_ID,
      sourceLastMessageId: MESSAGE_IDS[4],
      sourceLastCreatedAt: "2026-01-05T10:00:00Z",
    });
  });

  it("never re-sends the original text behind already-stored items", () => {
    const stored = state();
    stored.items[1].evidence[0].sourceMessageId = MESSAGE_IDS[3];
    const bundle = build({ state: stored });
    assert.equal(bundle.request.input.messages.some((message) => message.id === MESSAGE_IDS[3]), false);
    assert.equal(bundle.request.input.currentItems[0].evidence[0].sourceMessageId, MESSAGE_IDS[3]);
  });

  it("sends only the session anchor message for an empty extraction", () => {
    const empty = extraction();
    empty.items = [];
    empty.evidence = [];
    const bundle = build({ extraction: empty });
    assert.deepEqual(bundle.request.input.messages.map((message) => message.id), [MESSAGE_IDS[4]]);
    assert.equal(bundle.request.input.session.sourceLastMessageId, MESSAGE_IDS[4]);
  });

  it("rejects a candidate citing a message outside the window instead of sending it without its source", () => {
    const outside = extraction();
    outside.evidence = outside.evidence.map((row) => row.itemKey === "Z-candidate"
      ? { ...row, sourceMessageId: "55555555-5555-4555-8555-555555555555" }
      : row);
    assertSafeReject(() => build({ extraction: outside }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts`

Expected: FAIL on the first four new tests, because today the request carries all 5 window messages. The fifth test ("rejects a candidate citing a message outside the window ...") already passes; it pins existing behavior that must survive.

- [ ] **Step 3: Write the implementation**

In `supabase/functions/_shared/memoryV3/dialoguePrompt.ts`, replace:

```ts
    const messageById = new Map(messages.map((message) => [message.id, message]));
    for (const row of extraction.evidence) {
      const source = messageById.get(row.sourceMessageId);
      if (!source || source.role !== "user" || source.createdAt !== row.mentionTime) fail(token);
    }
```

with:

```ts
    const messageById = new Map(messages.map((message) => [message.id, message]));
    for (const row of extraction.evidence) {
      const source = messageById.get(row.sourceMessageId);
      if (!source || source.role !== "user" || source.createdAt !== row.mentionTime) fail(token);
    }
    // Spec 2026-10-13 §2: the reconciler sees only the messages the NEW
    // candidates cite (each just proven present above) -- not the whole
    // window again, and never the source text behind existing items, which
    // are compared by their stored claim/status/fields. With nothing cited,
    // the window's last message alone keeps the transport's one-message
    // minimum (live runners never get here -- they skip the reconciler for
    // empty extractions -- but the history backfill engines still call it).
    const last = messages[messages.length - 1];
    const citedMessageIds = new Set(extraction.evidence.map((row) => row.sourceMessageId));
    const requestMessages = citedMessageIds.size > 0
      ? messages.filter((message) => citedMessageIds.has(message.id))
      : [last];
```

Then replace:

```ts
    const last = messages[messages.length - 1];
    const request: MemoryV3DialogueReconcileRequest = {
```

with:

```ts
    const request: MemoryV3DialogueReconcileRequest = {
```

Then, in that same `request` object literal, replace the line `        messages,` with `        messages: requestMessages,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

Expected: PASS, 0 failures.

Then run the backfill tooling that reuses this builder: `node node_modules/tsx/dist/cli.mjs --test scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-import-run.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialoguePrompt.ts supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: dialogue reconciler receives only the messages new candidates cite

The full window is still validated (and still defines the session's
last message), but the request's messages are now just the evidence
messages of the new extraction -- not the whole window a second time,
and never the source text behind already-stored items.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Lifecycle reconciler receives only evidence-cited messages

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts:317-360`
- Modify: `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` (append at the end)
- Modify: `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts:208`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts:25`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildMemoryV3LifecycleReconcileRequest(input)` with the same evidence-only `request.input.messages` rule as Task 3. `session` is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts`:

```ts
describe("Memory V3 lifecycle reconciler evidence-only messages", () => {
  it("sends only the messages the new candidates cite, in chronological order", () => {
    const bundle = build();
    assert.deepEqual(
      bundle.request.input.messages.map((message) => message.id),
      [MESSAGE_IDS[0], MESSAGE_IDS[2], MESSAGE_IDS[4]],
    );
    assert.equal(bundle.request.input.messages.some((message) => message.role === "assistant"), false);
  });

  it("keeps the session pointing at the full window's last message even when that message is not cited", () => {
    const single = extraction();
    single.items = single.items.filter((item) => item.localItemKey === "Z-candidate");
    single.evidence = single.evidence.filter((row) => row.itemKey === "Z-candidate");
    const bundle = build({ extraction: single });
    assert.deepEqual(bundle.request.input.messages.map((message) => message.id), [MESSAGE_IDS[2]]);
    assert.deepEqual(bundle.request.input.session, {
      conversationId: CONVERSATION_ID,
      sourceLastMessageId: MESSAGE_IDS[4],
      sourceLastCreatedAt: "2026-01-05T10:00:00Z",
    });
  });

  it("never re-sends the original text behind already-stored items", () => {
    const stored = state();
    stored.items[1].evidence[0].sourceMessageId = MESSAGE_IDS[3];
    const bundle = build({ state: stored });
    assert.equal(bundle.request.input.messages.some((message) => message.id === MESSAGE_IDS[3]), false);
    assert.equal(bundle.request.input.currentItems[0].evidence[0].sourceMessageId, MESSAGE_IDS[3]);
  });

  it("sends only the session anchor message for an empty extraction", () => {
    const empty = extraction();
    empty.items = [];
    empty.evidence = [];
    const bundle = build({ extraction: empty });
    assert.deepEqual(bundle.request.input.messages.map((message) => message.id), [MESSAGE_IDS[4]]);
    assert.equal(bundle.request.input.session.sourceLastMessageId, MESSAGE_IDS[4]);
  });

  it("rejects a candidate citing a message outside the window instead of sending it without its source", () => {
    const outside = extraction();
    outside.evidence = outside.evidence.map((row) => row.itemKey === "Z-candidate"
      ? { ...row, sourceMessageId: "55555555-5555-4555-8555-555555555555" }
      : row);
    assertSafeReject(() => build({ extraction: outside }));
  });
});
```

In `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts`, replace line 208:

```ts
      assert.equal(bundle.request.input.messages.length, testCase.messages.length);
```

with:

```ts
      // Evidence-only reconciler input (spec 2026-10-13 §2): exactly the
      // messages this case's candidates cite, or just the session anchor
      // when there are no candidates.
      const citedIds = new Set(testCase.extraction.evidence.map((row) => row.sourceMessageId));
      const sentIds = bundle.request.input.messages.map((message) => message.id);
      if (citedIds.size > 0) {
        assert.deepEqual([...sentIds].sort(), [...citedIds].sort());
      } else {
        assert.deepEqual(sentIds, [bundle.request.input.session.sourceLastMessageId]);
      }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts`

Expected:
- `lifecyclePrompt.cases.test.ts` FAILS on the first four new tests. The fifth already passes, because it pins existing behavior.
- The benchmark dataset test fails for every case whose candidates don't cite all of its messages.

- [ ] **Step 3: Write the implementation**

In `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`, replace:

```ts
    const messageById = new Map(messages.map((message) => [message.id, message]));
    for (const row of extraction.evidence) {
      const source = messageById.get(row.sourceMessageId);
      if (!source || source.role !== "user" || source.createdAt !== row.mentionTime) fail(token);
    }
```

with:

```ts
    const messageById = new Map(messages.map((message) => [message.id, message]));
    for (const row of extraction.evidence) {
      const source = messageById.get(row.sourceMessageId);
      if (!source || source.role !== "user" || source.createdAt !== row.mentionTime) fail(token);
    }
    // Spec 2026-10-13 §2: the reconciler sees only the messages the NEW
    // candidates cite (each just proven present above) -- not the whole
    // window again, and never the source text behind existing items, which
    // are compared by their stored claim/status/fields. With nothing cited,
    // the window's last message alone keeps the transport's one-message
    // minimum (live runners never get here -- they skip the reconciler for
    // empty extractions -- but the history backfill engine and the model
    // benchmark still call it).
    const last = messages[messages.length - 1];
    const citedMessageIds = new Set(extraction.evidence.map((row) => row.sourceMessageId));
    const requestMessages = citedMessageIds.size > 0
      ? messages.filter((message) => citedMessageIds.has(message.id))
      : [last];
```

Then replace:

```ts
    const last = messages[messages.length - 1];
    const request: MemoryV3LifecycleReconcileRequest = {
```

with:

```ts
    const request: MemoryV3LifecycleReconcileRequest = {
```

Then, in that same `request` object literal, replace the line `        messages,` with `        messages: requestMessages,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 5: Re-pin `lifecyclePrompt.ts` in the frozen-source gate**

```bash
git add supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
rm supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
git checkout -- supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
sha256sum supabase/functions/_shared/memoryV3/lifecyclePrompt.ts | cut -d' ' -f1 | tr 'a-f' 'A-F'
```

Expected: one 64-character uppercase hex string, different from `6BD99B0D71065612B1071B5D91D3C30C4071A3E1B3CF5074C7D3767B13DB6759`.

In `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts`, line 25 sits under `'supabase/functions/_shared/memoryV3/lifecyclePrompt.ts':`. Replace the literal `'6BD99B0D71065612B1071B5D91D3C30C4071A3E1B3CF5074C7D3767B13DB6759'` there with the exact value the command printed, in single quotes. Change nothing else.

- [ ] **Step 6: Run every script test that builds lifecycle reconcile requests**

Run: `node node_modules/tsx/dist/cli.mjs --test scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecyclePrompt.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
git commit -m "$(cat <<'EOF'
feat: lifecycle reconciler receives only the messages new candidates cite

Same evidence-only request shape as the dialogue pipeline. Updates the
benchmark dataset test that asserted the old full-window shape, and
re-pins lifecyclePrompt.ts in the lifecycle backfill frozen-source gate
(intentional change).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Dialogue runner skips the reconciler for an empty extraction

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`:
  - add a helper before `export async function runMemoryV3DialogueShadow(`;
  - insert the fast path after the max-candidates check at lines 445-448;
  - replace the terminal CAS block at lines 554-575.
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`: insert after the existing `it("keeps the reserved revision for an unchanged empty extraction", ...)` block, which ends at line 369.

**Interfaces:**
- Consumes: the existing store `compareAndSwap` / `fail` (signatures unchanged).
- Produces: an internal helper `persistCompareAndSwap(compareAndSwap, failStore, runId, userId, write, resultingStateRevision): Promise<MemoryV3DialogueShadowResult | null>`. It returns `null` on success, otherwise the already-persisted failure. The runner's public result shape is unchanged.

- [ ] **Step 1: Write the failing tests**

In `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`, insert directly after the closing `});` of `it("keeps the reserved revision for an unchanged empty extraction", ...)`:

```ts
  it("skips the reconciler entirely for an empty extraction but still persists a succeeded no-op run", async () => {
    let reconcilerFactoryCalls = 0;
    const extractorUsage = { promptTokens: 400, completionTokens: 20, costUsd: 0.0001 };
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: extractorUsage }),
      reconcilerAdapterFactory: () => {
        reconcilerFactoryCalls += 1;
        return async () => { throw new Error("the reconciler must not be called"); };
      },
    });
    const logged: unknown[] = [];
    const result = await runMemoryV3DialogueShadow(test.options, undefined, async (input) => { logged.push(input); });
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0, transitionCount: 0, stateRevision: 0,
    });
    assert.equal(reconcilerFactoryCalls, 0);
    assert.equal(test.casInputs.length, 1);
    assert.deepEqual(test.casInputs[0], {
      runId: RUN_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      expectedStateRevision: 0,
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      changed: false,
      extraction: {
        run: {
          caseId: `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`,
          extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
        },
        items: [],
        evidence: [],
      },
      operations: [],
      transitions: [],
      extractorUsage,
      reconcilerUsage: null,
    });
    assert.deepEqual(logged, [{
      userId: USER_ID, conversationId: CONVERSATION_ID, runId: RUN_ID, stage: "extractor",
      model: "google/gemini-3.7-flash", promptTokens: 400, completionTokens: 20, costUsd: 0.0001,
      pipeline: "dialogue",
    }]);
    assert.deepEqual(test.failInputs, []);
  });

  it("terminalizes an empty-extraction run through fail() when its no-op CAS conflicts", async () => {
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: null }),
    });
    test.options.store = {
      ...test.store,
      async compareAndSwap() { test.calls.push("cas"); return { status: "state_conflict" as const }; },
    };
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "state_conflict",
    });
    assert.deepEqual(test.calls.slice(-2), ["cas", "fail:state_conflict"]);
    assert.equal(test.calls.includes("reconcilerFactory"), false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

Expected: FAIL on both new tests.
- The first returns `{ status: "failed", ..., diagnosticCode: "reconciler_transport_failed" }`, because the reconciler is still called.
- The second ends in `fail:reconciler_contract_invalid` with `reconcilerFactory` present in `calls`.

- [ ] **Step 3: Write the implementation**

3a. In `dialogueShadowRunner.ts`, replace:

```ts
export async function runMemoryV3DialogueShadow(
```

with:

```ts
// The terminal compareAndSwap write plus its result check, shared by the
// normal path and the empty-extraction fast path. Returns null on success,
// otherwise the already-persisted failure result.
async function persistCompareAndSwap(
  compareAndSwap: (input: never) => Promise<unknown>,
  failStore: (input: never) => Promise<unknown>,
  runId: string,
  userId: string,
  write: JsonRecord,
  resultingStateRevision: number,
): Promise<MemoryV3DialogueShadowResult | null> {
  let cas: unknown;
  try {
    cas = await compareAndSwap(write as never);
  } catch {
    return await persistFailure(failStore, runId, userId, "state_write_failed");
  }
  try {
    const status = Object.getOwnPropertyDescriptor(cas as object, "status")?.value;
    if (status === "state_conflict") {
      inspectExactRecord(cas, ["status"], "state_write_failed");
      return await persistFailure(failStore, runId, userId, "state_conflict");
    }
    const result = inspectExactRecord(cas, ["status", "resultingStateRevision"], "state_write_failed");
    if (result.status !== "succeeded" || result.resultingStateRevision !== resultingStateRevision) {
      throw fail("state_write_failed");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "state_write_failed";
    return await persistFailure(failStore, runId, userId, code);
  }
  return null;
}

export async function runMemoryV3DialogueShadow(
```

3b. Replace:

```ts
  if (extraction.items.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
      extraction.evidence.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE) {
    return await persistFailure(failStore, runId, userId, "state_too_large");
  }
```

with:

```ts
  if (extraction.items.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
      extraction.evidence.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE) {
    return await persistFailure(failStore, runId, userId, "state_too_large");
  }

  // Empty-extraction fast path (spec 2026-10-13 §3): nothing to reconcile, so
  // the reconciler is never called -- but the run still finishes as a normal
  // succeeded no-op through compareAndSwap, because that succeeded row is
  // what the next run's delta cursor reads.
  if (extraction.items.length === 0) {
    const noopFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
      runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
      state, changed: false, extraction, operations: [], transitions: [],
      extractorUsage: extractor.usage, reconcilerUsage: null,
    }, state.stateRevision);
    if (noopFailure !== null) return noopFailure;
    return {
      status: "succeeded",
      runId,
      itemCount: 0,
      evidenceCount: 0,
      transitionCount: 0,
      stateRevision: state.stateRevision,
    };
  }
```

3c. Replace the terminal CAS block:

```ts
  let cas: unknown;
  try {
    cas = await compareAndSwap({
      runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
      state: resultingState, changed: reduced.changed, extraction, operations: proposal,
      transitions: reduced.transitions, extractorUsage: extractor.usage, reconcilerUsage: reconciler.usage,
    } as never);
  } catch {
    return await persistFailure(failStore, runId, userId, "state_write_failed");
  }
  try {
    const status = Object.getOwnPropertyDescriptor(cas as object, "status")?.value;
    if (status === "state_conflict") {
      inspectExactRecord(cas, ["status"], "state_write_failed");
      return await persistFailure(failStore, runId, userId, "state_conflict");
    }
    const result = inspectExactRecord(cas, ["status", "resultingStateRevision"], "state_write_failed");
    if (result.status !== "succeeded" || result.resultingStateRevision !== resultingState.stateRevision) throw fail("state_write_failed");
  } catch (error) {
    const code = ownDiagnostic(error) ?? "state_write_failed";
    return await persistFailure(failStore, runId, userId, code);
  }
```

with:

```ts
  const casFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
    runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
    state: resultingState, changed: reduced.changed, extraction, operations: proposal,
    transitions: reduced.transitions, extractorUsage: extractor.usage, reconcilerUsage: reconciler.usage,
  }, resultingState.stateRevision);
  if (casFailure !== null) return casFailure;
```

Leave the final `return { status: "succeeded", ... }` after it unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

Expected: PASS, 0 failures. The existing state_conflict, sanitization, and "reserves before exactly one ... then CAS" tests must still pass; they prove the refactored CAS path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: dialogue memory skips the reconciler when the extractor finds nothing

An empty extraction now finishes as a normal succeeded no-op run via a
single compareAndSwap (changed=false, empty operations/transitions,
reconciler usage null) without calling the reconciler. The terminal
CAS write and its result checks move into one helper shared by both
paths.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Lifecycle runner skips the reconciler for an empty extraction

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts`:
  - add a helper before `export async function runMemoryV3LifecycleShadow(`;
  - insert the fast path after the max-candidates check at lines 474-477;
  - replace the terminal CAS block at lines 583-604.
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`: insert after the existing `it("keeps the reserved revision for an unchanged empty extraction", ...)` block, which ends at line 423.

**Interfaces:**
- Consumes: the existing lifecycle store `compareAndSwap` / `fail`. Their write has no `conversationId` field.
- Produces: an internal helper `persistCompareAndSwap(...)`, the same as Task 5 but typed `Promise<MemoryV3LifecycleShadowResult | null>`. The public result shape is unchanged.

- [ ] **Step 1: Write the failing tests**

Insert directly after the closing `});` of `it("keeps the reserved revision for an unchanged empty extraction", ...)` in `lifecycleShadowRunner.cases.test.ts`:

```ts
  it("skips the reconciler entirely for an empty extraction but still persists a succeeded no-op run", async () => {
    let reconcilerFactoryCalls = 0;
    const extractorUsage = { promptTokens: 400, completionTokens: 20, costUsd: 0.0001 };
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: extractorUsage }),
      reconcilerAdapterFactory: () => {
        reconcilerFactoryCalls += 1;
        return async () => { throw new Error("the reconciler must not be called"); };
      },
    });
    const logged: unknown[] = [];
    const result = await runMemoryV3LifecycleShadow(test.options, undefined, async (input) => { logged.push(input); });
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0, transitionCount: 0, stateRevision: 0,
    });
    assert.equal(reconcilerFactoryCalls, 0);
    assert.equal(test.casInputs.length, 1);
    assert.deepEqual(test.casInputs[0], {
      runId: RUN_ID,
      userId: USER_ID,
      expectedStateRevision: 0,
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      changed: false,
      extraction: {
        run: {
          caseId: `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`,
          extractorVersion: MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION,
        },
        items: [],
        evidence: [],
      },
      operations: [],
      transitions: [],
      extractorUsage,
      reconcilerUsage: null,
    });
    assert.deepEqual(logged, [{
      userId: USER_ID, conversationId: CONVERSATION_ID, runId: RUN_ID, stage: "extractor",
      model: "google/gemini-3.7-flash", promptTokens: 400, completionTokens: 20, costUsd: 0.0001,
      pipeline: "lifecycle",
    }]);
    assert.deepEqual(test.failInputs, []);
  });

  it("terminalizes an empty-extraction run through fail() when its no-op CAS conflicts", async () => {
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: null }),
    });
    test.options.store = {
      ...test.store,
      async compareAndSwap() { test.calls.push("cas"); return { status: "state_conflict" as const }; },
    };
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "state_conflict",
    });
    assert.deepEqual(test.calls.slice(-2), ["cas", "fail:state_conflict"]);
    assert.equal(test.calls.includes("reconcilerFactory"), false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`

Expected: FAIL on both new tests, for the same reasons as Task 5 Step 2.

- [ ] **Step 3: Write the implementation**

3a. In `lifecycleShadowRunner.ts`, replace:

```ts
export async function runMemoryV3LifecycleShadow(
```

with:

```ts
// The terminal compareAndSwap write plus its result check, shared by the
// normal path and the empty-extraction fast path. Returns null on success,
// otherwise the already-persisted failure result.
async function persistCompareAndSwap(
  compareAndSwap: (input: never) => Promise<unknown>,
  failStore: (input: never) => Promise<unknown>,
  runId: string,
  userId: string,
  write: JsonRecord,
  resultingStateRevision: number,
): Promise<MemoryV3LifecycleShadowResult | null> {
  let cas: unknown;
  try {
    cas = await compareAndSwap(write as never);
  } catch {
    return await persistFailure(failStore, runId, userId, "state_write_failed");
  }
  try {
    const status = Object.getOwnPropertyDescriptor(cas as object, "status")?.value;
    if (status === "state_conflict") {
      inspectExactRecord(cas, ["status"], "state_write_failed");
      return await persistFailure(failStore, runId, userId, "state_conflict");
    }
    const result = inspectExactRecord(cas, ["status", "resultingStateRevision"], "state_write_failed");
    if (result.status !== "succeeded" || result.resultingStateRevision !== resultingStateRevision) {
      throw fail("state_write_failed");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "state_write_failed";
    return await persistFailure(failStore, runId, userId, code);
  }
  return null;
}

export async function runMemoryV3LifecycleShadow(
```

3b. Replace:

```ts
  if (extraction.items.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
      extraction.evidence.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE) {
    return await persistFailure(failStore, runId, userId, "state_too_large");
  }
```

with:

```ts
  if (extraction.items.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
      extraction.evidence.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE) {
    return await persistFailure(failStore, runId, userId, "state_too_large");
  }

  // Empty-extraction fast path (spec 2026-10-13 §3): nothing to reconcile, so
  // the reconciler is never called -- but the run still finishes as a normal
  // succeeded no-op through compareAndSwap, because that succeeded row is
  // what the next run's delta cursor (and migration 077's gate) reads.
  if (extraction.items.length === 0) {
    const noopFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
      runId, userId, expectedStateRevision: reserved.expectedStateRevision,
      state, changed: false, extraction, operations: [], transitions: [],
      extractorUsage: extractor.usage, reconcilerUsage: null,
    }, state.stateRevision);
    if (noopFailure !== null) return noopFailure;
    return {
      status: "succeeded",
      runId,
      itemCount: 0,
      evidenceCount: 0,
      transitionCount: 0,
      stateRevision: state.stateRevision,
    };
  }
```

3c. Replace the terminal CAS block:

```ts
  let cas: unknown;
  try {
    cas = await compareAndSwap({
      runId, userId, expectedStateRevision: reserved.expectedStateRevision,
      state: resultingState, changed: reduced.changed, extraction, operations: proposal,
      transitions: reduced.transitions, extractorUsage: extractor.usage, reconcilerUsage: reconciler.usage,
    } as never);
  } catch {
    return await persistFailure(failStore, runId, userId, "state_write_failed");
  }
  try {
    const status = Object.getOwnPropertyDescriptor(cas as object, "status")?.value;
    if (status === "state_conflict") {
      inspectExactRecord(cas, ["status"], "state_write_failed");
      return await persistFailure(failStore, runId, userId, "state_conflict");
    }
    const result = inspectExactRecord(cas, ["status", "resultingStateRevision"], "state_write_failed");
    if (result.status !== "succeeded" || result.resultingStateRevision !== resultingState.stateRevision) throw fail("state_write_failed");
  } catch (error) {
    const code = ownDiagnostic(error) ?? "state_write_failed";
    return await persistFailure(failStore, runId, userId, code);
  }
```

with:

```ts
  const casFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
    runId, userId, expectedStateRevision: reserved.expectedStateRevision,
    state: resultingState, changed: reduced.changed, extraction, operations: proposal,
    transitions: reduced.transitions, extractorUsage: extractor.usage, reconcilerUsage: reconciler.usage,
  }, resultingState.stateRevision);
  if (casFailure !== null) return casFailure;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: lifecycle memory skips the reconciler when the extractor finds nothing

Same no-op contract as the dialogue pipeline: one compareAndSwap with
changed=false and reconciler usage null, so the run still ends
succeeded and still advances the watermark.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Dialogue store reads the last succeeded cursor

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/dialogueStore.ts`:
  - imports (line 1);
  - add `MemoryV3DialogueCursorInput` after `MemoryV3DialogueSuccessWrite` (ends line 88);
  - `MemoryV3DialogueRpcClient` (lines 90-92);
  - `MemoryV3DialogueStore` (lines 94-100);
  - add helpers after `inspectClient` (ends line 288);
  - add a new method inside `createMemoryV3DialogueStore` after `compareAndSwap`.
- Modify: `supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts` (append at the end)

**Interfaces:**
- Consumes: `MemoryV3SourceCursor` (type) from `./messages.ts` (Task 2).
- Produces:

```ts
export interface MemoryV3DialogueCursorInput { userId: string; conversationId: string }
// MemoryV3DialogueStore gains:
lastSucceededCursor(input: MemoryV3DialogueCursorInput): Promise<MemoryV3SourceCursor | null>;
```

Note: after this task, `dialogueShadowRunner.cases.test.ts`'s harness store literal lacks the new interface member until Task 8. tsx strips types, so everything still runs.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts`:

```ts
function fakeTableClient(response: { data: unknown; error: unknown } | Error) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return chain; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return chain; },
    order(...args: unknown[]) { calls.push({ method: "order", args }); return chain; },
    limit(...args: unknown[]) {
      calls.push({ method: "limit", args });
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  return {
    calls,
    client: {
      async rpc() { throw new Error("a cursor read must never call an RPC"); },
      from(table: string) { calls.push({ method: "from", args: [table] }); return chain; },
    },
  };
}

describe("Memory V3 dialogue store cursor lookup", () => {
  const cursorRow = {
    source_last_message_id: MESSAGE_ID,
    source_last_created_at: "2026-09-14T10:00:00.123456+00:00",
  };

  it("reads only succeeded runs of exactly this conversation, furthest source position first", async () => {
    // Ordering by source position (not completion time) means a run that
    // finishes late with an older window can never move the cursor back.
    const fake = fakeTableClient({ data: [cursorRow], error: null });
    assert.deepEqual(
      await createMemoryV3DialogueStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      { messageId: MESSAGE_ID, createdAt: "2026-09-14T10:00:00.123456+00:00" },
    );
    assert.deepEqual(fake.calls, [
      { method: "from", args: ["memory_v3_dialogue_runs"] },
      { method: "select", args: ["source_last_message_id, source_last_created_at"] },
      { method: "eq", args: ["user_id", USER_ID] },
      { method: "eq", args: ["conversation_id", CONVERSATION_ID] },
      { method: "eq", args: ["status", "succeeded"] },
      { method: "order", args: ["source_last_created_at", { ascending: false }] },
      { method: "order", args: ["source_last_message_id", { ascending: false }] },
      { method: "limit", args: [1] },
    ]);
  });

  it("returns null when no run of this conversation has ever succeeded", async () => {
    const fake = fakeTableClient({ data: [], error: null });
    assert.equal(
      await createMemoryV3DialogueStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      null,
    );
  });

  it("rejects malformed rows, extra columns, extra rows, and database errors with the generic store error", async () => {
    for (const response of [
      { data: null, error: { message: RAW_SECRET } },
      { data: [{ ...cursorRow, source_last_message_id: "not-a-uuid" }], error: null },
      { data: [{ ...cursorRow, source_last_created_at: "yesterday" }], error: null },
      { data: [{ ...cursorRow, extra: RAW_SECRET }], error: null },
      { data: [cursorRow, cursorRow], error: null },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeTableClient(response);
      await captureStoreError(() =>
        createMemoryV3DialogueStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    }
  });

  it("rejects invalid identifiers before any database access", async () => {
    for (const input of [
      { userId: "not-a-uuid", conversationId: CONVERSATION_ID },
      { userId: USER_ID, conversationId: "not-a-uuid" },
      { userId: USER_ID, conversationId: CONVERSATION_ID, extra: RAW_SECRET },
    ]) {
      const fake = fakeTableClient({ data: [], error: null });
      await captureStoreError(() => createMemoryV3DialogueStore(fake.client).lastSucceededCursor(input as never));
      assert.equal(fake.calls.length, 0);
    }
  });

  it("still constructs from an rpc-only client, and the cursor read then fails closed", async () => {
    const fake = fakeClient([]);
    const store = createMemoryV3DialogueStore(fake.client);
    await captureStoreError(() => store.lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    assert.equal(fake.calls.length, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts`

Expected: FAIL on all five new tests with `TypeError: ... lastSucceededCursor is not a function`. In the `captureStoreError` cases this shows up as a name mismatch (`TypeError` vs `MemoryV3DialogueStoreError`).

- [ ] **Step 3: Write the implementation**

3a. After line 1 (`import type { MemoryV3Extraction } from "./contract.ts";`) add:

```ts
import type { MemoryV3SourceCursor } from "./messages.ts";
```

3b. Replace:

```ts
export interface MemoryV3DialogueRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface MemoryV3DialogueStore {
  reserve(input: MemoryV3DialogueReservationInput): Promise<MemoryV3DialogueReservationResult>;
  fail(input: MemoryV3DialogueFailureWrite): Promise<void>;
  compareAndSwap(input: MemoryV3DialogueSuccessWrite): Promise<
    { status: "succeeded"; resultingStateRevision: number } | { status: "state_conflict" }
  >;
}
```

with:

```ts
export interface MemoryV3DialogueCursorInput {
  userId: string;
  conversationId: string;
}

export interface MemoryV3DialogueRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  /** Plain table reads -- used only by lastSucceededCursor(). Optional so an
   * rpc-only client still constructs; that one method then fails closed. */
  from?(table: string): unknown;
}

export interface MemoryV3DialogueStore {
  reserve(input: MemoryV3DialogueReservationInput): Promise<MemoryV3DialogueReservationResult>;
  fail(input: MemoryV3DialogueFailureWrite): Promise<void>;
  compareAndSwap(input: MemoryV3DialogueSuccessWrite): Promise<
    { status: "succeeded"; resultingStateRevision: number } | { status: "state_conflict" }
  >;
  /** This conversation's newest *succeeded* run's source position, or null if
   * none has succeeded yet. Failed/reserved runs never count (spec 2026-10-13
   * §3 -- the same rule migration 077 applies to lifecycle's trigger gate). */
  lastSucceededCursor(input: MemoryV3DialogueCursorInput): Promise<MemoryV3SourceCursor | null>;
}
```

3c. Replace:

```ts
async function callRpc(client: InspectedClient, name: string, args: Record<string, unknown>): Promise<unknown> {
```

with:

```ts
function findMethod(target: object, name: string): (...args: unknown[]) => unknown {
  const seen = new WeakSet<object>();
  let current: object | null = target;
  while (current !== null) {
    if (seen.has(current)) throw fail();
    seen.add(current);
    const own = descriptor(current, name);
    if (own) {
      if (!("value" in own) || typeof own.value !== "function") throw fail();
      return own.value as (...args: unknown[]) => unknown;
    }
    current = prototypeOf(current);
  }
  throw fail();
}

function invoke(target: unknown, name: string, ...args: unknown[]): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) throw fail();
  return findMethod(target, name).apply(target, args);
}

async function callRpc(client: InspectedClient, name: string, args: Record<string, unknown>): Promise<unknown> {
```

3d. At the end of `createMemoryV3DialogueStore`, replace:

```ts
      if (row.result !== "succeeded" || row.resulting_state_revision !== expectedResultingRevision) throw fail();
      return { status: "succeeded", resultingStateRevision: expectedResultingRevision };
    },
  };
}
```

with:

```ts
      if (row.result !== "succeeded" || row.resulting_state_revision !== expectedResultingRevision) throw fail();
      return { status: "succeeded", resultingStateRevision: expectedResultingRevision };
    },

    async lastSucceededCursor(inputValue) {
      const input = record(inputValue, ["userId", "conversationId"]);
      if (typeof input.userId !== "string" || !UUID.test(input.userId) ||
        typeof input.conversationId !== "string" || !UUID.test(input.conversationId)) throw fail();
      let response: unknown;
      try {
        let query = invoke(client.target, "from", "memory_v3_dialogue_runs");
        query = invoke(query, "select", "source_last_message_id, source_last_created_at");
        query = invoke(query, "eq", "user_id", input.userId);
        query = invoke(query, "eq", "conversation_id", input.conversationId);
        query = invoke(query, "eq", "status", "succeeded");
        // By source position, not completion time: a run that finishes late
        // with an older window can never move the cursor backwards.
        query = invoke(query, "order", "source_last_created_at", { ascending: false });
        query = invoke(query, "order", "source_last_message_id", { ascending: false });
        response = await invoke(query, "limit", 1);
      } catch {
        throw fail();
      }
      const projected = projectedRecord(response, ["data", "error"]);
      if (projected.error !== null) throw fail();
      const rows = array(projected.data, 1);
      if (rows.length === 0) return null;
      const row = record(rows[0], ["source_last_message_id", "source_last_created_at"]);
      if (typeof row.source_last_message_id !== "string" || !UUID.test(row.source_last_message_id) ||
        !isoDateTime(row.source_last_created_at)) throw fail();
      return { messageId: row.source_last_message_id, createdAt: row.source_last_created_at };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts`

Expected: PASS, 0 failures, with the existing reserve/fail/CAS tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueStore.ts supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: dialogue store reads a conversation's last succeeded run cursor

Plain service-role SELECT on memory_v3_dialogue_runs (no migration):
succeeded runs only, this conversation only, furthest source position
first, so failed runs never advance it and a late-finishing older run
can never move it backwards.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Dialogue runner loads from its last succeeded cursor

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`:
  - line 8 (import);
  - line 58 (`loadMessages` option);
  - line 169 (`ownMethod`);
  - add `projectSourceCursor` before `function canonicalStringify`;
  - gate and load block (lines 313-322).
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`:
  - harness (lines 69-133);
  - new `describe` inserted before `describe("Memory V3 dialogue background isolation"` (line 636).

**Interfaces:**
- Consumes:
  - `MemoryV3SourceCursor` (Task 2);
  - `MemoryV3DialogueStore.lastSucceededCursor({ userId, conversationId })` (Task 7);
  - the loader's third parameter (Task 2);
  - the empty-extraction fast path (Task 5; the sequence test relies on it).
- Produces: `MemoryV3DialogueShadowOptions.loadMessages: (userId: string, conversationId: string, sinceCursor: MemoryV3SourceCursor | null) => Promise<MemoryV3DialogueMessage[]>`. A store missing `lastSucceededCursor` now yields `invalid_source`.

- [ ] **Step 1: Update the harness and write the failing tests**

In `dialogueShadowRunner.cases.test.ts`'s `harness()`:

1. After `const extractorRequests: unknown[] = [];`, add `const cursorInputs: unknown[] = [];`.
2. Replace the store's `compareAndSwap` method:

```ts
    async compareAndSwap(input) {
      calls.push("cas");
      casInputs.push(input);
      return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
    },
  };
```

with:

```ts
    async compareAndSwap(input) {
      calls.push("cas");
      casInputs.push(input);
      return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
    },
    async lastSucceededCursor(input) {
      cursorInputs.push(input);
      return null;
    },
  };
```

3. Replace the harness's return line:

```ts
  return { options, calls, store, reserveInputs, casInputs, failInputs, extractorRequests, get maxActive() { return maxActive; } };
```

with:

```ts
  return { options, calls, store, reserveInputs, casInputs, failInputs, extractorRequests, cursorInputs, get maxActive() { return maxActive; } };
```

Then insert immediately before `describe("Memory V3 dialogue background isolation", () => {`:

```ts
describe("Memory V3 dialogue delta cursor", () => {
  const PRIOR_MESSAGE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const oneUserMessage = () => [{ id: MESSAGE_ID, role: "user" as const, text: "Я люблю утренние прогулки", createdAt: CREATED_AT }];

  it("hands the loader a null cursor when no run of this conversation has succeeded yet", async () => {
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        loaderArgs.push(args);
        return oneUserMessage();
      },
    });
    assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, null]]);
  });

  it("reads this conversation's last succeeded cursor before loading, and hands it to the loader", async () => {
    const cursor = { messageId: PRIOR_MESSAGE_ID, createdAt: "2026-09-15T09:00:00Z" };
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        test.calls.push("messages");
        loaderArgs.push(args);
        return oneUserMessage();
      },
    });
    test.options.store = {
      ...test.store,
      async lastSucceededCursor(input) {
        test.calls.push("cursor");
        test.cursorInputs.push(input);
        return cursor;
      },
    };
    assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.calls.slice(0, 3), ["cursor", "messages", "reserve"]);
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, cursor]]);
  });

  it("falls back to the full window, never failing the run, when the cursor lookup throws or returns garbage", async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      for (const lookup of [
        async () => { throw new Error(RAW_SECRET); },
        async () => ({ messageId: "not-a-uuid", createdAt: CREATED_AT }),
        async () => ({ messageId: MESSAGE_ID, createdAt: "not-a-date" }),
        async () => ({ messageId: MESSAGE_ID, createdAt: CREATED_AT, extra: RAW_SECRET }),
        async () => "RAW",
      ]) {
        const loaderArgs: unknown[][] = [];
        const test = harness({
          async loadMessages(...args: unknown[]) {
            loaderArgs.push(args);
            return oneUserMessage();
          },
        });
        test.options.store = { ...test.store, lastSucceededCursor: lookup as never };
        assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
        assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, null]]);
      }
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 5);
    assert.deepEqual(logged[0], ["[memory-v3-dialogue-cursor-lookup-failed]"]);
    assert.equal(JSON.stringify(logged).includes(RAW_SECRET), false);
  });

  it("treats a store without lastSucceededCursor as invalid before any database or provider work", async () => {
    const test = harness();
    test.options.store = {
      reserve: test.store.reserve,
      fail: test.store.fail,
      compareAndSwap: test.store.compareAndSwap,
    } as never;
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: null, diagnosticCode: "invalid_source",
    });
    assert.deepEqual(test.calls, []);
    assert.deepEqual(test.cursorInputs, []);
  });

  it("advances the delta cursor only on succeeded runs (fail, succeed, fail, then read)", async () => {
    const RUN_IDS = [
      "eeeeeeee-eeee-4eee-8eee-000000000001",
      "eeeeeeee-eeee-4eee-8eee-000000000002",
      "eeeeeeee-eeee-4eee-8eee-000000000003",
      "eeeeeeee-eeee-4eee-8eee-000000000004",
    ];
    const conversation = Array.from({ length: 8 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "user" as const,
      text: `Сообщение ${index + 1}`,
      createdAt: `2026-09-15T10:0${index}:00Z`,
    }));
    const runs: Array<{
      runId: string;
      status: "reserved" | "succeeded" | "failed";
      sourceLastMessageId: string;
      sourceLastCreatedAt: string;
    }> = [];
    const seenCursors: unknown[] = [];
    let visible = 0;
    let extractorFails = false;
    const store: MemoryV3DialogueStore = {
      async reserve(input) {
        const runId = RUN_IDS[runs.length];
        runs.push({
          runId, status: "reserved",
          sourceLastMessageId: input.sourceLastMessageId, sourceLastCreatedAt: input.sourceLastCreatedAt,
        });
        return {
          status: "reserved", runId, expectedStateRevision: 0,
          state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
        };
      },
      async fail(input) { runs.find((run) => run.runId === input.runId)!.status = "failed"; },
      async compareAndSwap(input) {
        runs.find((run) => run.runId === input.runId)!.status = "succeeded";
        return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
      },
      // Mirrors the real query: succeeded rows only, furthest source position first.
      async lastSucceededCursor() {
        const best = runs
          .filter((run) => run.status === "succeeded")
          .sort((left, right) => Date.parse(right.sourceLastCreatedAt) - Date.parse(left.sourceLastCreatedAt))[0];
        return best ? { messageId: best.sourceLastMessageId, createdAt: best.sourceLastCreatedAt } : null;
      },
    };
    const options = {
      ...harness().options,
      store,
      async loadMessages(_userId: string, _conversationId: string, sinceCursor: unknown) {
        seenCursors.push(sinceCursor);
        return conversation.slice(0, visible);
      },
      extractorAdapterFactory: () => async () => {
        if (extractorFails) throw new Error("provider down");
        return { content: emptyExtractorContent, usage: null };
      },
    };
    for (const step of [
      { visible: 2, fails: true, status: "failed" },
      { visible: 4, fails: false, status: "succeeded" },
      { visible: 6, fails: true, status: "failed" },
      { visible: 8, fails: false, status: "succeeded" },
    ]) {
      visible = step.visible;
      extractorFails = step.fails;
      assert.equal((await runMemoryV3DialogueShadow(options)).status, step.status);
    }
    assert.deepEqual(runs.map((run) => run.status), ["failed", "succeeded", "failed", "succeeded"]);
    const afterRun2 = { messageId: conversation[3].id, createdAt: conversation[3].createdAt };
    // Run 3 failed after covering messages 5-6, so run 4 must still read from run 2.
    assert.deepEqual(seenCursors, [null, null, afterRun2, afterRun2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

Expected: FAIL on all five new tests.
- `cursorInputs` stays empty, and `loaderArgs` holds only two arguments.
- The missing-method store still succeeds.
- `seenCursors` is `[undefined, undefined, undefined, undefined]`.

All pre-existing tests still pass.

- [ ] **Step 3: Write the implementation**

3a. Replace line 8:

```ts
import type { MemoryV3DialogueMessage } from "./messages.ts";
```

with:

```ts
import type { MemoryV3DialogueMessage, MemoryV3SourceCursor } from "./messages.ts";
```

3b. Replace (inside `MemoryV3DialogueShadowOptions`):

```ts
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
```

with:

```ts
  /** sinceCursor: this conversation's last succeeded run's source position,
   * or null for a first run (spec 2026-10-13 §1). */
  loadMessages: (
    userId: string,
    conversationId: string,
    sinceCursor: MemoryV3SourceCursor | null,
  ) => Promise<MemoryV3DialogueMessage[]>;
```

3c. Replace:

```ts
function ownMethod(value: unknown, name: "reserve" | "fail" | "compareAndSwap"): ((input: never) => Promise<unknown>) | null {
```

with:

```ts
function ownMethod(
  value: unknown,
  name: "reserve" | "fail" | "compareAndSwap" | "lastSucceededCursor",
): ((input: never) => Promise<unknown>) | null {
```

3d. Replace:

```ts
function canonicalStringify(value: unknown): string {
```

with:

```ts
// The store's answer is untrusted until checked here; anything malformed is
// handled exactly like a failed lookup by the caller.
function projectSourceCursor(value: unknown): MemoryV3SourceCursor | null {
  if (value === null) return null;
  const cursor = inspectExactRecord(value, ["messageId", "createdAt"], "invalid_source");
  if (typeof cursor.messageId !== "string" || !UUID.test(cursor.messageId) ||
      typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) {
    throw fail("invalid_source");
  }
  return { messageId: cursor.messageId, createdAt: cursor.createdAt };
}

function canonicalStringify(value: unknown): string {
```

3e. Replace:

```ts
  const compareAndSwap = ownMethod(projected.store, "compareAndSwap");
  if (typeof userId !== "string" || !UUID.test(userId) || typeof conversationId !== "string" || !UUID.test(conversationId) ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || typeof projected.loadMessages !== "function" ||
      typeof projected.extractorAdapterFactory !== "function" || typeof projected.reconcilerAdapterFactory !== "function" ||
      !reserve || !failStore || !compareAndSwap) return failed(null, "invalid_source");

  let dialogue: MemoryV3DialogueInput;
  let extractorRequest;
  try {
    const source = await (projected.loadMessages as MemoryV3DialogueShadowOptions["loadMessages"])(userId, conversationId);
```

with:

```ts
  const compareAndSwap = ownMethod(projected.store, "compareAndSwap");
  const lastSucceededCursor = ownMethod(projected.store, "lastSucceededCursor");
  if (typeof userId !== "string" || !UUID.test(userId) || typeof conversationId !== "string" || !UUID.test(conversationId) ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || typeof projected.loadMessages !== "function" ||
      typeof projected.extractorAdapterFactory !== "function" || typeof projected.reconcilerAdapterFactory !== "function" ||
      !reserve || !failStore || !compareAndSwap || !lastSucceededCursor) return failed(null, "invalid_source");

  // Delta windowing (spec 2026-10-13 §1, §3): only this conversation's last
  // *succeeded* run counts as already analyzed. A failed or malformed lookup
  // can only cost a wider, pre-delta window -- never skipped messages -- so
  // the run carries on without a cursor. Console-only fixed literal; the
  // error itself is never logged.
  let sinceCursor: MemoryV3SourceCursor | null;
  try {
    sinceCursor = projectSourceCursor(await lastSucceededCursor({ userId, conversationId } as never));
  } catch {
    console.error("[memory-v3-dialogue-cursor-lookup-failed]");
    sinceCursor = null;
  }

  let dialogue: MemoryV3DialogueInput;
  let extractorRequest;
  try {
    const source = await (projected.loadMessages as MemoryV3DialogueShadowOptions["loadMessages"])(
      userId, conversationId, sinceCursor,
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts`

Expected: PASS, 0 failures. That includes the existing "source isolation" test (no `Deno.env`, `process.env` or `globalThis.fetch` in the runner).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: dialogue memory reads only messages its last succeeded run hasn't seen

Before loading, the runner asks its store for this conversation's last
succeeded run cursor and hands it to the loader; a first run or a
failed/malformed lookup falls back to the existing full window, never
failing the run. Proven with a fail -> succeed -> fail sequence: the
failed runs never move the next run's cursor.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Lifecycle store reads the last succeeded cursor

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleStore.ts`. The anchors match Task 7, with lifecycle names: line 1 import; the `MemoryV3LifecycleRpcClient` and `MemoryV3LifecycleStore` interfaces (lines 90-100); helpers before `callRpc`; a new method after `compareAndSwap`.
- Modify: `supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts` (append at the end)

**Interfaces:**
- Consumes: `MemoryV3SourceCursor` (Task 2).
- Produces:

```ts
export interface MemoryV3LifecycleCursorInput { userId: string; conversationId: string }
// MemoryV3LifecycleStore gains:
lastSucceededCursor(input: MemoryV3LifecycleCursorInput): Promise<MemoryV3SourceCursor | null>;
```

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts`:

```ts
function fakeTableClient(response: { data: unknown; error: unknown } | Error) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return chain; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return chain; },
    order(...args: unknown[]) { calls.push({ method: "order", args }); return chain; },
    limit(...args: unknown[]) {
      calls.push({ method: "limit", args });
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  return {
    calls,
    client: {
      async rpc() { throw new Error("a cursor read must never call an RPC"); },
      from(table: string) { calls.push({ method: "from", args: [table] }); return chain; },
    },
  };
}

describe("Memory V3 lifecycle store cursor lookup", () => {
  const cursorRow = {
    source_last_message_id: MESSAGE_ID,
    source_last_created_at: "2026-09-14T10:00:00.123456+00:00",
  };

  it("reads only succeeded runs of exactly this conversation, furthest source position first", async () => {
    const fake = fakeTableClient({ data: [cursorRow], error: null });
    assert.deepEqual(
      await createMemoryV3LifecycleStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      { messageId: MESSAGE_ID, createdAt: "2026-09-14T10:00:00.123456+00:00" },
    );
    assert.deepEqual(fake.calls, [
      { method: "from", args: ["memory_v3_lifecycle_shadow_runs"] },
      { method: "select", args: ["source_last_message_id, source_last_created_at"] },
      { method: "eq", args: ["user_id", USER_ID] },
      { method: "eq", args: ["conversation_id", CONVERSATION_ID] },
      { method: "eq", args: ["status", "succeeded"] },
      { method: "order", args: ["source_last_created_at", { ascending: false }] },
      { method: "order", args: ["source_last_message_id", { ascending: false }] },
      { method: "limit", args: [1] },
    ]);
  });

  it("keeps each conversation's cursor independent for the same user", async () => {
    const OTHER_CONVERSATION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    for (const conversationId of [CONVERSATION_ID, OTHER_CONVERSATION_ID]) {
      const fake = fakeTableClient({ data: [], error: null });
      await createMemoryV3LifecycleStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId });
      assert.deepEqual(fake.calls.filter((call) => call.method === "eq"), [
        { method: "eq", args: ["user_id", USER_ID] },
        { method: "eq", args: ["conversation_id", conversationId] },
        { method: "eq", args: ["status", "succeeded"] },
      ]);
    }
  });

  it("returns null when no run of this conversation has ever succeeded", async () => {
    const fake = fakeTableClient({ data: [], error: null });
    assert.equal(
      await createMemoryV3LifecycleStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      null,
    );
  });

  it("rejects malformed rows, extra columns, extra rows, and database errors with the generic store error", async () => {
    for (const response of [
      { data: null, error: { message: RAW_SECRET } },
      { data: [{ ...cursorRow, source_last_message_id: "not-a-uuid" }], error: null },
      { data: [{ ...cursorRow, source_last_created_at: "yesterday" }], error: null },
      { data: [{ ...cursorRow, extra: RAW_SECRET }], error: null },
      { data: [cursorRow, cursorRow], error: null },
      new Error(RAW_SECRET),
    ]) {
      const fake = fakeTableClient(response);
      await captureStoreError(() =>
        createMemoryV3LifecycleStore(fake.client).lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    }
  });

  it("rejects invalid identifiers before any database access", async () => {
    for (const input of [
      { userId: "not-a-uuid", conversationId: CONVERSATION_ID },
      { userId: USER_ID, conversationId: "not-a-uuid" },
      { userId: USER_ID, conversationId: CONVERSATION_ID, extra: RAW_SECRET },
    ]) {
      const fake = fakeTableClient({ data: [], error: null });
      await captureStoreError(() => createMemoryV3LifecycleStore(fake.client).lastSucceededCursor(input as never));
      assert.equal(fake.calls.length, 0);
    }
  });

  it("still constructs from an rpc-only client, and the cursor read then fails closed", async () => {
    const fake = fakeClient([]);
    const store = createMemoryV3LifecycleStore(fake.client);
    await captureStoreError(() => store.lastSucceededCursor({ userId: USER_ID, conversationId: CONVERSATION_ID }));
    assert.equal(fake.calls.length, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts`

Expected: FAIL on all six new tests (`lastSucceededCursor is not a function`).

- [ ] **Step 3: Write the implementation**

3a. After line 1 (`import type { MemoryV3Extraction } from "./contract.ts";`) add:

```ts
import type { MemoryV3SourceCursor } from "./messages.ts";
```

3b. Replace:

```ts
export interface MemoryV3LifecycleRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface MemoryV3LifecycleStore {
  reserve(input: MemoryV3LifecycleReservationInput): Promise<MemoryV3LifecycleReservationResult>;
  fail(input: MemoryV3LifecycleFailureWrite): Promise<void>;
  compareAndSwap(input: MemoryV3LifecycleSuccessWrite): Promise<
    { status: "succeeded"; resultingStateRevision: number } | { status: "state_conflict" }
  >;
}
```

with:

```ts
export interface MemoryV3LifecycleCursorInput {
  userId: string;
  conversationId: string;
}

export interface MemoryV3LifecycleRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  /** Plain table reads -- used only by lastSucceededCursor(). Optional so an
   * rpc-only client still constructs; that one method then fails closed. */
  from?(table: string): unknown;
}

export interface MemoryV3LifecycleStore {
  reserve(input: MemoryV3LifecycleReservationInput): Promise<MemoryV3LifecycleReservationResult>;
  fail(input: MemoryV3LifecycleFailureWrite): Promise<void>;
  compareAndSwap(input: MemoryV3LifecycleSuccessWrite): Promise<
    { status: "succeeded"; resultingStateRevision: number } | { status: "state_conflict" }
  >;
  /** This conversation's newest *succeeded* run's source position, or null if
   * none has succeeded yet. Per conversation (migrations 053/077); failed or
   * reserved runs never count (spec 2026-10-13 §3). */
  lastSucceededCursor(input: MemoryV3LifecycleCursorInput): Promise<MemoryV3SourceCursor | null>;
}
```

3c. Replace:

```ts
async function callRpc(client: InspectedClient, name: string, args: Record<string, unknown>): Promise<unknown> {
```

with:

```ts
function findMethod(target: object, name: string): (...args: unknown[]) => unknown {
  const seen = new WeakSet<object>();
  let current: object | null = target;
  while (current !== null) {
    if (seen.has(current)) throw fail();
    seen.add(current);
    const own = descriptor(current, name);
    if (own) {
      if (!("value" in own) || typeof own.value !== "function") throw fail();
      return own.value as (...args: unknown[]) => unknown;
    }
    current = prototypeOf(current);
  }
  throw fail();
}

function invoke(target: unknown, name: string, ...args: unknown[]): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) throw fail();
  return findMethod(target, name).apply(target, args);
}

async function callRpc(client: InspectedClient, name: string, args: Record<string, unknown>): Promise<unknown> {
```

3d. At the end of `createMemoryV3LifecycleStore`, replace:

```ts
      if (row.result !== "succeeded" || row.resulting_state_revision !== expectedResultingRevision) throw fail();
      return { status: "succeeded", resultingStateRevision: expectedResultingRevision };
    },
  };
}
```

with:

```ts
      if (row.result !== "succeeded" || row.resulting_state_revision !== expectedResultingRevision) throw fail();
      return { status: "succeeded", resultingStateRevision: expectedResultingRevision };
    },

    async lastSucceededCursor(inputValue) {
      const input = record(inputValue, ["userId", "conversationId"]);
      if (typeof input.userId !== "string" || !UUID.test(input.userId) ||
        typeof input.conversationId !== "string" || !UUID.test(input.conversationId)) throw fail();
      let response: unknown;
      try {
        let query = invoke(client.target, "from", "memory_v3_lifecycle_shadow_runs");
        query = invoke(query, "select", "source_last_message_id, source_last_created_at");
        query = invoke(query, "eq", "user_id", input.userId);
        query = invoke(query, "eq", "conversation_id", input.conversationId);
        query = invoke(query, "eq", "status", "succeeded");
        // By source position, not completion time: a run that finishes late
        // with an older window can never move the cursor backwards.
        query = invoke(query, "order", "source_last_created_at", { ascending: false });
        query = invoke(query, "order", "source_last_message_id", { ascending: false });
        response = await invoke(query, "limit", 1);
      } catch {
        throw fail();
      }
      const projected = projectedRecord(response, ["data", "error"]);
      if (projected.error !== null) throw fail();
      const rows = array(projected.data, 1);
      if (rows.length === 0) return null;
      const row = record(rows[0], ["source_last_message_id", "source_last_created_at"]);
      if (typeof row.source_last_message_id !== "string" || !UUID.test(row.source_last_message_id) ||
        !isoDateTime(row.source_last_created_at)) throw fail();
      return { messageId: row.source_last_message_id, createdAt: row.source_last_created_at };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleStore.ts supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: lifecycle store reads a conversation's last succeeded run cursor

Same read as the dialogue store, against memory_v3_lifecycle_shadow_runs:
succeeded runs only, scoped to one conversation (a user's other
conversations never share it), furthest source position first.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Lifecycle runner loads from its last succeeded cursor

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts`:
  - line 8 (import);
  - line 59 (`loadMessages` option);
  - line 170 (`ownMethod`);
  - add `projectSourceCursor` before `function canonicalStringify`;
  - gate and load block (lines 342-351).
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`:
  - harness (lines 70-136);
  - new `describe` inserted before `describe("Memory V3 lifecycle background isolation"` (line 690).

**Interfaces:**
- Consumes:
  - `MemoryV3SourceCursor` (Task 2);
  - `MemoryV3LifecycleStore.lastSucceededCursor` (Task 9);
  - the loader's third parameter (Task 2);
  - the empty-extraction fast path (Task 6).
- Produces: `MemoryV3LifecycleShadowOptions.loadMessages: (userId: string, conversationId: string, sinceCursor: MemoryV3SourceCursor | null) => Promise<MemoryV3DialogueMessage[]>`. The lookup runs only after the mode/allowlist gates and the store-method gate.

- [ ] **Step 1: Update the harness and write the failing tests**

In `lifecycleShadowRunner.cases.test.ts`'s `harness()`:

1. After `const extractorRequests: unknown[] = [];`, add `const cursorInputs: unknown[] = [];`.
2. Replace the store's `compareAndSwap` method and the closing `};` of the store:

```ts
    async compareAndSwap(input) {
      calls.push("cas");
      casInputs.push(input);
      return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
    },
  };
```

with:

```ts
    async compareAndSwap(input) {
      calls.push("cas");
      casInputs.push(input);
      return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
    },
    async lastSucceededCursor(input) {
      cursorInputs.push(input);
      return null;
    },
  };
```

3. Replace the return line:

```ts
  return { options, calls, store, reserveInputs, casInputs, failInputs, extractorRequests, get maxActive() { return maxActive; } };
```

with:

```ts
  return { options, calls, store, reserveInputs, casInputs, failInputs, extractorRequests, cursorInputs, get maxActive() { return maxActive; } };
```

Then insert immediately before `describe("Memory V3 lifecycle background isolation", () => {`:

```ts
describe("Memory V3 lifecycle delta cursor", () => {
  const PRIOR_MESSAGE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const oneUserMessage = () => [{ id: MESSAGE_ID, role: "user" as const, text: "Я люблю утренние прогулки", createdAt: CREATED_AT }];

  it("never looks up a delta cursor for disabled or non-allowlisted accounts", async () => {
    for (const overrides of [{ rawMode: "off" }, { rawMode: "lifecycle_shadow", userId: OTHER_USER_ID }]) {
      const test = harness(overrides);
      assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "skipped");
      assert.deepEqual(test.cursorInputs, []);
    }
  });

  it("hands the loader a null cursor when no run of this conversation has succeeded yet", async () => {
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        loaderArgs.push(args);
        return oneUserMessage();
      },
    });
    assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, null]]);
  });

  it("reads this conversation's last succeeded cursor before loading, and hands it to the loader", async () => {
    const cursor = { messageId: PRIOR_MESSAGE_ID, createdAt: "2026-09-15T09:00:00Z" };
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        test.calls.push("messages");
        loaderArgs.push(args);
        return oneUserMessage();
      },
    });
    test.options.store = {
      ...test.store,
      async lastSucceededCursor(input) {
        test.calls.push("cursor");
        test.cursorInputs.push(input);
        return cursor;
      },
    };
    assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.calls.slice(0, 3), ["cursor", "messages", "reserve"]);
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, cursor]]);
  });

  it("falls back to the full window, never failing the run, when the cursor lookup throws or returns garbage", async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      for (const lookup of [
        async () => { throw new Error(RAW_SECRET); },
        async () => ({ messageId: "not-a-uuid", createdAt: CREATED_AT }),
        async () => ({ messageId: MESSAGE_ID, createdAt: "not-a-date" }),
        async () => ({ messageId: MESSAGE_ID, createdAt: CREATED_AT, extra: RAW_SECRET }),
        async () => "RAW",
      ]) {
        const loaderArgs: unknown[][] = [];
        const test = harness({
          async loadMessages(...args: unknown[]) {
            loaderArgs.push(args);
            return oneUserMessage();
          },
        });
        test.options.store = { ...test.store, lastSucceededCursor: lookup as never };
        assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
        assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, null]]);
      }
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 5);
    assert.deepEqual(logged[0], ["[memory-v3-lifecycle-cursor-lookup-failed]"]);
    assert.equal(JSON.stringify(logged).includes(RAW_SECRET), false);
  });

  it("treats a store without lastSucceededCursor as invalid before any database or provider work", async () => {
    const test = harness();
    test.options.store = {
      reserve: test.store.reserve,
      fail: test.store.fail,
      compareAndSwap: test.store.compareAndSwap,
    } as never;
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: null, diagnosticCode: "invalid_source",
    });
    assert.deepEqual(test.calls, []);
    assert.deepEqual(test.cursorInputs, []);
  });

  it("advances the delta cursor only on succeeded runs (fail, succeed, fail, then read)", async () => {
    const RUN_IDS = [
      "eeeeeeee-eeee-4eee-8eee-000000000001",
      "eeeeeeee-eeee-4eee-8eee-000000000002",
      "eeeeeeee-eeee-4eee-8eee-000000000003",
      "eeeeeeee-eeee-4eee-8eee-000000000004",
    ];
    const conversation = Array.from({ length: 8 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "user" as const,
      text: `Сообщение ${index + 1}`,
      createdAt: `2026-09-15T10:0${index}:00Z`,
    }));
    const runs: Array<{
      runId: string;
      status: "reserved" | "succeeded" | "failed";
      sourceLastMessageId: string;
      sourceLastCreatedAt: string;
    }> = [];
    const seenCursors: unknown[] = [];
    let visible = 0;
    let extractorFails = false;
    const store: MemoryV3LifecycleStore = {
      async reserve(input) {
        const runId = RUN_IDS[runs.length];
        runs.push({
          runId, status: "reserved",
          sourceLastMessageId: input.sourceLastMessageId, sourceLastCreatedAt: input.sourceLastCreatedAt,
        });
        return {
          status: "reserved", runId, expectedStateRevision: 0,
          state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
        };
      },
      async fail(input) { runs.find((run) => run.runId === input.runId)!.status = "failed"; },
      async compareAndSwap(input) {
        runs.find((run) => run.runId === input.runId)!.status = "succeeded";
        return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
      },
      // Mirrors the real query: succeeded rows only, furthest source position first.
      async lastSucceededCursor() {
        const best = runs
          .filter((run) => run.status === "succeeded")
          .sort((left, right) => Date.parse(right.sourceLastCreatedAt) - Date.parse(left.sourceLastCreatedAt))[0];
        return best ? { messageId: best.sourceLastMessageId, createdAt: best.sourceLastCreatedAt } : null;
      },
    };
    const options = {
      ...harness().options,
      store,
      async loadMessages(_userId: string, _conversationId: string, sinceCursor: unknown) {
        seenCursors.push(sinceCursor);
        return conversation.slice(0, visible);
      },
      extractorAdapterFactory: () => async () => {
        if (extractorFails) throw new Error("provider down");
        return { content: emptyExtractorContent, usage: null };
      },
    };
    for (const step of [
      { visible: 2, fails: true, status: "failed" },
      { visible: 4, fails: false, status: "succeeded" },
      { visible: 6, fails: true, status: "failed" },
      { visible: 8, fails: false, status: "succeeded" },
    ]) {
      visible = step.visible;
      extractorFails = step.fails;
      assert.equal((await runMemoryV3LifecycleShadow(options)).status, step.status);
    }
    assert.deepEqual(runs.map((run) => run.status), ["failed", "succeeded", "failed", "succeeded"]);
    const afterRun2 = { messageId: conversation[3].id, createdAt: conversation[3].createdAt };
    // Run 3 failed after covering messages 5-6, so run 4 must still read from run 2.
    assert.deepEqual(seenCursors, [null, null, afterRun2, afterRun2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`

Expected: FAIL on the last five new tests, for the same reasons as Task 8 Step 2. "never looks up a delta cursor for disabled or non-allowlisted accounts" already passes; it's a guard that must keep passing.

- [ ] **Step 3: Write the implementation**

3a. Replace line 8:

```ts
import type { MemoryV3DialogueMessage } from "./messages.ts";
```

with:

```ts
import type { MemoryV3DialogueMessage, MemoryV3SourceCursor } from "./messages.ts";
```

3b. Replace (inside `MemoryV3LifecycleShadowOptions`):

```ts
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
```

with:

```ts
  /** sinceCursor: this conversation's last succeeded run's source position,
   * or null for a first run (spec 2026-10-13 §1). */
  loadMessages: (
    userId: string,
    conversationId: string,
    sinceCursor: MemoryV3SourceCursor | null,
  ) => Promise<MemoryV3DialogueMessage[]>;
```

3c. Replace:

```ts
function ownMethod(value: unknown, name: "reserve" | "fail" | "compareAndSwap"): ((input: never) => Promise<unknown>) | null {
```

with:

```ts
function ownMethod(
  value: unknown,
  name: "reserve" | "fail" | "compareAndSwap" | "lastSucceededCursor",
): ((input: never) => Promise<unknown>) | null {
```

3d. Replace:

```ts
function canonicalStringify(value: unknown): string {
```

with:

```ts
// The store's answer is untrusted until checked here; anything malformed is
// handled exactly like a failed lookup by the caller.
function projectSourceCursor(value: unknown): MemoryV3SourceCursor | null {
  if (value === null) return null;
  const cursor = inspectExactRecord(value, ["messageId", "createdAt"], "invalid_source");
  if (typeof cursor.messageId !== "string" || !UUID.test(cursor.messageId) ||
      typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) {
    throw fail("invalid_source");
  }
  return { messageId: cursor.messageId, createdAt: cursor.createdAt };
}

function canonicalStringify(value: unknown): string {
```

3e. Replace:

```ts
  const compareAndSwap = ownMethod(projected.store, "compareAndSwap");
  if (typeof userId !== "string" || !UUID.test(userId) || typeof conversationId !== "string" || !UUID.test(conversationId) ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || typeof projected.loadMessages !== "function" ||
      typeof projected.extractorAdapterFactory !== "function" || typeof projected.reconcilerAdapterFactory !== "function" ||
      !reserve || !failStore || !compareAndSwap) return failed(null, "invalid_source");

  let dialogue: MemoryV3DialogueInput;
  let extractorRequest;
  try {
    const source = await (projected.loadMessages as MemoryV3LifecycleShadowOptions["loadMessages"])(userId, conversationId);
```

with:

```ts
  const compareAndSwap = ownMethod(projected.store, "compareAndSwap");
  const lastSucceededCursor = ownMethod(projected.store, "lastSucceededCursor");
  if (typeof userId !== "string" || !UUID.test(userId) || typeof conversationId !== "string" || !UUID.test(conversationId) ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || typeof projected.loadMessages !== "function" ||
      typeof projected.extractorAdapterFactory !== "function" || typeof projected.reconcilerAdapterFactory !== "function" ||
      !reserve || !failStore || !compareAndSwap || !lastSucceededCursor) return failed(null, "invalid_source");

  // Delta windowing (spec 2026-10-13 §1, §3): only this conversation's last
  // *succeeded* run counts as already analyzed. A failed or malformed lookup
  // can only cost a wider, pre-delta window -- never skipped messages -- so
  // the run carries on without a cursor. Console-only fixed literal; the
  // error itself is never logged.
  let sinceCursor: MemoryV3SourceCursor | null;
  try {
    sinceCursor = projectSourceCursor(await lastSucceededCursor({ userId, conversationId } as never));
  } catch {
    console.error("[memory-v3-lifecycle-cursor-lookup-failed]");
    sinceCursor = null;
  }

  let dialogue: MemoryV3DialogueInput;
  let extractorRequest;
  try {
    const source = await (projected.loadMessages as MemoryV3LifecycleShadowOptions["loadMessages"])(
      userId, conversationId, sinceCursor,
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts supabase/functions/_shared/memoryV3/fullRolloutWiring.cases.test.ts`

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: lifecycle memory reads only messages its last succeeded run hasn't seen

Same cursor-before-load flow as the dialogue pipeline, after the
mode/allowlist gates. The reservation's 10-new-message gate (migration
077) is untouched -- this only changes what a triggered run reads.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Whole-branch verification

**Files:**
- Read-only checks. Modify only if a check fails, then re-run every check.

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch ready for review.

- [ ] **Step 1: Full offline suite**

Run: `node scripts/run-offline-tests.mjs`

Expected:
- exit code 0;
- the output shows all four `[test:offline] ...` group headers (shared functions, frontend, TypeScript scripts, JavaScript scripts);
- every group reports `ℹ fail 0`.

- [ ] **Step 2: Lint every changed file**

Run:
```bash
npx eslint supabase/functions/_shared/tokenEstimate.ts supabase/functions/_shared/tokenEstimate.cases.test.ts supabase/functions/_shared/cost.ts supabase/functions/_shared/memoryV3/messages.ts supabase/functions/_shared/memoryV3/messages.cases.test.ts supabase/functions/_shared/memoryV3/dialoguePrompt.ts supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/dialogueStore.ts supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleStore.ts supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
```

Expected: exit code 0, no output. These files were lint-clean before this plan, and CI runs `npm run lint` on the whole repo.

- [ ] **Step 3: Scope check**

Run: `git diff --stat 640b842..HEAD`

Expected: exactly these 19 paths and nothing else:
- `supabase/functions/_shared/tokenEstimate.ts`
- `supabase/functions/_shared/tokenEstimate.cases.test.ts`
- `supabase/functions/_shared/cost.ts`
- `supabase/functions/_shared/memoryV3/messages.ts` and `messages.cases.test.ts`
- `supabase/functions/_shared/memoryV3/dialoguePrompt.ts` and `dialoguePrompt.cases.test.ts`
- `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts` and `lifecyclePrompt.cases.test.ts`
- `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts` and `dialogueShadowRunner.cases.test.ts`
- `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts` and `lifecycleShadowRunner.cases.test.ts`
- `supabase/functions/_shared/memoryV3/dialogueStore.ts` and `dialogueStore.cases.test.ts`
- `supabase/functions/_shared/memoryV3/lifecycleStore.ts` and `lifecycleStore.cases.test.ts`
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts`
- `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts`

`supabase/.temp/cli-latest` must NOT appear.

- [ ] **Step 4: The out-of-scope files are untouched**

Run:
```bash
git diff 640b842..HEAD -- supabase/functions/staysee-chat/index.ts supabase/migrations supabase/functions/_shared/memoryV3/contract.ts supabase/functions/_shared/memoryV3/dialogueContract.ts supabase/functions/_shared/memoryV3/lifecycleContract.ts supabase/functions/_shared/memoryV3/dialogueReducer.ts supabase/functions/_shared/memoryV3/lifecycleReducer.ts supabase/functions/_shared/memoryV3/dialogueTransport.ts supabase/functions/_shared/memoryV3/lifecycleTransport.ts
```

Expected: no output at all.

- [ ] **Step 5: Optional Deno type check (CI does not run Deno)**

Run `deno --version`. Only if it prints a version, run `deno check supabase/functions/staysee-chat/index.ts` and confirm that no reported error points into a file from Step 3's list. If `deno` is not installed, skip this step.
