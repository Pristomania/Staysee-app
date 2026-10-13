# Memory V3 Extractor/Reconciler Delta Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution mode chosen for this plan:** inline (native), via `superpowers:executing-plans`, in one session, with tasks strictly in order. The tasks are tightly coupled through shared interfaces: the loader's new cursor parameter, the stores' `lastSucceededCursor`, and the runners' empty-extraction fast path, which the cursor-sequence tests rely on. Sequential native execution fits better than per-task subagents.

**Goal:** Cut Memory V3's per-message extractor/reconciler cost in three ways. Load only the messages that a conversation's last succeeded run has not seen yet. Send the reconciler only the messages that the new candidates cite. Skip the reconciler entirely when the extractor finds nothing.

**Architecture:**
- Each shadow runner (dialogue, lifecycle) first asks its own store for this conversation's last *succeeded* run's `source_last_message_id` / `source_last_created_at`. That is a plain SELECT; there is no migration.
- The runner then calls the shared message loader with that cursor:
  - no cursor → today's last-60 window, unchanged;
  - cursor → the **oldest** ≤55 messages after it by `(created_at, id)`, plus the 5 at or before it, plus the conversation's latest message id. A 4000-estimated-token target trims the **newest** end of that chunk (never the context block, never the oldest undrained message); trimmed messages open the next run.
- In delta mode the runner byte-fits the window the same way (newest end first) and reserves with the last message it actually sends, so the next cursor never skips anything and a backlog bigger than one window drains across runs. An empty delta skips the extractor entirely (succeeded no-op). Evidence may cite only the delta. The input identity includes the conversation's latest message id.
- The reconcile-request builders keep validating the full window but forward only evidence-cited messages.
- An empty extraction finishes as a normal succeeded no-op through `compareAndSwap`, without calling the reconciler.

**Tech Stack:** TypeScript Supabase Edge Function modules (Deno at runtime). They are tested offline with Node's `node:test` through `tsx` (`node node_modules/tsx/dist/cli.mjs --test <file>`; whole suite: `node scripts/run-offline-tests.mjs`). supabase-js query builders are replaced by hand-written fakes.

**Spec:** `docs/superpowers/specs/2026-10-13-memory-v3-extractor-reconciler-delta-design.md`

## Global Constraints

- **Delta token target.** **4000** estimated tokens, using the project's `estimateTokens` rule (`Math.ceil(text.length / 3.5)`), measured over leading context + delta together, only when a cursor exists. It is a target, not a ceiling (next two bullets).
- **Leading context.** The **5** messages at or before the cursor by the compound comparison `(created_at, id) <= (cursor.createdAt, cursor.messageId)`. Neither the token target nor the byte cap ever drops them.
- **Trim direction.** The token target (loader) and the 20 KB byte cap (runner, delta mode) both trim the **newest end** of the chunk, keeping a contiguous oldest-first prefix. Neither ever drops the single oldest undrained message. Trimmed messages are not lost: they open the next run.
- **Delta fetch bound.** The **oldest 55** messages with `(created_at, id) > (cursor.createdAt, cursor.messageId)`, never the newest. Context + delta ≤ **60**, which equals `MEMORY_V3_MAX_SOURCE_MESSAGES` and the run tables' `message_count BETWEEN 1 AND 60` CHECK. A larger backlog drains across runs.
- **Where the cursor lands.** On the last message the run actually sent to the extractor, after both trims. It never lands on the conversation's newest message unless that message was sent.
- **No cursor.** When no run has succeeded yet for this (user, conversation), the runner calls the loader with **two arguments** and gets **today's last-60 query, unchanged, with no token cap**, byte-fitted exactly as today.
- **What counts as the cursor.** Only runs with `status = 'succeeded'`, the same rule migration 077 applies to the lifecycle trigger gate. Failed or reserved runs never advance it. A failed or malformed cursor lookup fails the run (`invalid_source`); it never falls back to a first-run window.
- **Reconciler `messages`.** Only messages whose `id` is a `sourceMessageId` in the **new extraction's** evidence. Existing items' source text is never re-sent, and `state.items` stays full and unchanged.
- **Empty extraction** (`extraction.items.length === 0`):
  - the reconciler adapter is never invoked;
  - `compareAndSwap` is called exactly once with: `state` unchanged; `changed: false`; `stateRevision` unchanged; `extraction.items` and `extraction.evidence` both `[]`; `operations: []`; `transitions: []`; `extractorUsage` = the real extractor usage; `reconcilerUsage: null`;
  - the result is `{status:"succeeded", runId, itemCount:0, evidenceCount:0, transitionCount:0, stateRevision}`.
- **Empty delta** (the delta query returns zero rows): the extractor is never called. The run reserves with the context block as its window, then calls `compareAndSwap` exactly once with the empty-extraction no-op shape except `extractorUsage: null`, and returns the same succeeded result.
- **Evidence only from the delta.** Every extractor evidence row must cite a message in this run's sent delta. Citing a leading-context message is `extractor_contract_invalid`, exactly like an unknown id.
- **Input identity in delta mode.** The input hash also covers the conversation's newest message id (from the loader), so a failed window can be re-reserved once anything new is written. First-run hashes are unchanged.
- **Out of scope; do not touch:**
  - merging the extractor and reconciler;
  - semantic narrowing of `state.items`;
  - reservation/trigger gates, and all migrations (no new migration);
  - `contract.ts`, `dialogueContract.ts`, `lifecycleContract.ts`, `dialogueReducer.ts`, `lifecycleReducer.ts`, `dialogueTransport.ts`, `lifecycleTransport.ts`;
  - `supabase/functions/staysee-chat/index.ts`. Its existing `createMemoryV3MessageLoader(svc)` / `create*Store(svc)` wiring already supplies everything.
- **Byte cap.** The 20 KB extractor cap stays 20 KB. First runs keep `fitExtractorDialogueToByteCap` exactly as it is (oldest end trimmed). Delta runs use `fitDeltaWindowToByteCap`: newest end trimmed, context block and oldest undrained message kept. If that minimum is still over 20 KB, it is sent anyway with one fixed-literal `console.warn`.
- **Node-importable `messages.ts`.** Tests run under Node + tsx, not Deno, and `scripts/memory-v3-pilot` tooling imports `messages.ts` at runtime. So `messages.ts` must not import `cost.ts`, which carries an `npm:` specifier and reads `Deno.env` at import time.
- **Frozen hashes.** `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` pins the SHA-256 of `messages.ts` and `lifecyclePrompt.ts` as a deliberate "did you mean to change this" gate. This plan intentionally changes both files and re-pins those two hashes (precedent: commit 3d2a19f). The hashes are over the CRLF bytes a Windows checkout produces (`core.autocrlf=true`; CI `verify` runs on `windows-latest`).
- **Staging.** Never run `git add -A` or `git add .`: `supabase/.temp/cli-latest` carries an unrelated modification. Stage explicit paths only.
- **Commit trailer.** Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A backlog bigger than one window must never lose the middle** (spec Review Focus 1; the first draft's actual bug).
   - Expected: windows drain oldest-first across runs. Every message id is in exactly one run's delta. Each run's cursor is the last message that run actually sent, after both the token target and the 20 KB byte cap.
   - Tests: Task 2, "drains a 150-message backlog oldest-first ..." (real loader; the token target binds). Task 8 and Task 10, "drains a 150-message backlog oldest-first across runs ..." (real runner; the byte cap binds).
2. **A failed run's window comes back identical** (backlog bigger than one window; the run fails after reserving).
   - Expected: once anything new is written, the next run's input hash differs and the reservation accepts it. It must never be a silent, permanent `duplicate`.
   - Tests: Task 8 and Task 10, "folds the conversation's latest message into a delta run's input identity ...".
3. **Nothing new since the last succeeded run.**
   - Expected: the extractor is never called. The run reserves, makes one `compareAndSwap` no-op with `extractorUsage: null`, and ends `succeeded`. For lifecycle, migration 077's gate answers `daily_cap` first in production.
   - Tests: Task 2, "returns an empty delta when nothing new arrived since the cursor"; Task 8 and Task 10, "never calls the extractor when nothing new arrived ...".
4. **Leading-context citations.**
   - Expected: `extractor_contract_invalid`, and the reconciler is never called.
   - Residual risk to watch after rollout: the extractor instruction does not tell the model which messages are context-only. A failed run leaves the cursor, and so the same context block, in place. A model that keeps citing context could keep failing one conversation's runs. Monitor `extractor_contract_invalid` per conversation. If it recurs, either mark context ids in the extractor instruction or filter such rows instead of rejecting them; both are spec changes.
   - Tests: Task 8 and Task 10, "rejects an extraction citing a leading-context message ...".
5. **The cursor lookup fails** (missing grant, network blip, malformed row).
   - Expected: `invalid_source` before any message load, never a fallback window. A first-run window is byte-fitted from the newest end and would move the cursor past an undrained backlog.
   - Tests: Task 8 and Task 10, "fails the run before loading anything when the cursor lookup throws ...".
6. **Messages sharing the cursor's timestamp.**
   - Expected: the compound `(created_at, id)` comparison puts each on the correct side; none is skipped or repeated.
   - Test: Task 2, "places same-timestamp messages on the right side of the cursor by id".
   - Not provable offline: that real PostgREST parses the quoted `.or()` keyset filter as intended. Before enabling in production, run one delta load against staging (or a local `supabase start`) for a conversation with a known cursor, and compare the result with SQL `WHERE (created_at, id) > (<cursor>)`.
7. **One message too big for any window.**
   - Expected: it is sent with the context block over the 20 KB cap, with one fixed-literal `console.warn`. It is never skipped.
   - Tests: Task 2, "keeps the context block and the oldest undrained message even when they alone exceed the token target"; Task 8 and Task 10, "sends the context and the oldest undrained message even over the byte cap ...".
8. **A candidate cites a message outside the reconciler's window** (spec Review Focus 2).
   - Expected: the builder rejects it, and the runner maps that to `reconciler_contract_invalid`. A request is never sent silently missing its source.
   - Tests: Task 3 and Task 4, "rejects a candidate citing a message outside the window ...".
9. **First run on a long pre-rollout conversation** (>60 messages, far beyond 4000 tokens; spec Review Focus 3).
   - Expected: exactly today's last-60 query, neither token-capped nor widened.
   - Test: Task 2, "never token-caps a first run, even a long pre-rollout conversation".
10. **Same user, two conversations** (lifecycle; spec Review Focus 4).
    - Expected: each conversation's cursor is independent.
    - Tests: Task 9, "keeps each conversation's cursor independent for the same user"; Task 10 also asserts the runner looks up with its own `conversationId`.

## Decisions this plan makes where the spec is silent (read before executing)

- **Where `estimateTokens` lives.** Importing `cost.ts` into `messages.ts` would break every Node-run importer of `messages.ts`: `messages.cases.test.ts` and `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.ts`. Task 1 moves the single implementation verbatim into the dependency-free `supabase/functions/_shared/tokenEstimate.ts`, and `cost.ts` re-exports it. Every existing `import { estimateTokens } from "./cost.ts"` stays unchanged.
- **Where the reconciler filter sits.** The builders validate the *full* window first, as today, and only then filter to cited messages. Filtering earlier would silently move `session.sourceLastMessageId` / `sourceLastCreatedAt` (derived from the window's last message) onto the last *cited* message.
- **Empty extraction inside the builder.** Live runners no longer build a reconcile request for an empty extraction (fast path). But the history-backfill engines and the lifecycle model benchmark still call the reconciler for empty chunks through the real transports, and those reject `messages.length === 0`. So when nothing is cited, the builder sends only the window's last message, the session anchor.
- **Loader return shape: how "nothing new" reaches the runner.** `createMemoryV3MessageLoader` returns one function with two call shapes (`MemoryV3MessageLoader`):
  - with two arguments, it is exactly today's last-60 loader and returns a bare `MemoryV3DialogueMessage[]`;
  - with a cursor, it returns `MemoryV3DeltaWindow { context, delta, latestMessageId }`, and "nothing new" is just `delta.length === 0`.

  This changes the fewest call sites. `staysee-chat/index.ts` keeps passing `createMemoryV3MessageLoader(svc)` to all three runners. The legacy `shadowRunner.ts` and every existing runner-test fake keep calling with two arguments and getting an array. Only the two runners' delta branches read the richer shape. A `null` third argument is rejected as a malformed cursor rather than read as "no cursor": the call shape alone selects the return shape.
- **Trim direction (a wording conflict in the spec).** Spec §1 says the token target drops "the oldest delta messages first", and its Testing list says "truncates from the oldest end". The same paragraph forbids dropping the oldest undrained message and requires the cursor to advance only to messages the run actually read. Under oldest-first draining these cannot all hold: trimming the oldest end while the cursor lands on the newest kept message skips the trimmed messages forever, which is the exact bug this revision fixes. This plan trims the **newest end** (a contiguous oldest-first prefix, never fewer than one message), and the trimmed messages open the next run. The spec wording should be corrected to "newest end".
- **Where the cursor lands.** On the last message of the window the extractor was actually sent: after the loader's token target and after the runner's byte cap. The runner already reserves with `dialogue.messages.at(-1)` as `sourceLastMessageId`, so no new bookkeeping is needed, as long as both trims cut the newest end and neither drops the context block or the oldest delta message.
- **The 20 KB byte cap in delta mode.** For Cyrillic text, 4000 estimated tokens is about 28 KB, and the extractor instruction alone is about 6 KB. So the existing 20 KB cap, not the token target, decides most delta windows. Today's `fitExtractorDialogueToByteCap` trims the oldest end, and left alone it would reintroduce the gap.
  - First runs keep today's fit unchanged.
  - Delta runs use `fitDeltaWindowToByteCap`, with the token target's priority order: newest end first; context block and oldest message never dropped; stop before the window would hold no user message.
  - If even that minimum is over 20 KB, it is sent anyway with one fixed-literal `console.warn`: the spec's "accepted, logged edge case".

  That warning also serves as the token target's log: any window over 4000 estimated tokens (at least 14,000 characters), plus the ~6 KB instruction, is already over 20 KB.
- **Input identity in delta mode.** Both reserve RPCs reject any input hash they have ever seen: `memory_v3_*_identities` rows are never released, not even by `fail_*_run`. Today's window always ends at the newest message, so a retry after new messages always has a new hash. A delta window doesn't: once the backlog is bigger than one window, a run that fails after reserving (provider outage, `state_conflict`, a context citation) would make every later run rebuild the identical window. Each would get `duplicate`, then `skipped`, silently and forever. So the loader also returns the conversation's `latestMessageId` (one extra one-row query), and the runner folds it into the hash in delta mode only. "Duplicate" keeps today's meaning (same input, same conversation state), and a retry proceeds as soon as anything new is written. First-run hashes are byte-identical to today's. No migration.
- **Compound keyset in PostgREST.** `(created_at, id) > cursor` is one `.or()` filter per query: `created_at.gt."<ts>",and(created_at.eq."<ts>",id.gt.<id>)`, mirrored with `lt`/`lte` for the context block. The timestamp is the exact string the store read back, at microsecond precision; the reserve RPC already relies on that string round-tripping (`m.created_at = p_source_last_created_at`). It is double-quoted for PostgREST. `inspectCursor` validates both parts first, so the string cannot carry a quote, comma, or parenthesis.
- **Database order is authoritative.** Delta-mode rows keep the order the database returned (`created_at, id`; the context block is reversed from its descending fetch) and are never re-sorted client-side. `Date.parse` resolves milliseconds while `created_at` carries microseconds, so a client re-sort could swap two same-millisecond messages and land the cursor on the wrong one. The loader only rejects gross misordering.
- **Delta-only evidence.** Enforced in the runner right after `normalizeMemoryV3LayeredResponse`, which still validates against the full window, so the user-role and mention-time rules are unchanged. Any evidence row citing a message outside this run's sent delta becomes `extractor_contract_invalid`, the same diagnostic an unknown id gets. Narrowing the dialogue passed to the normalizer instead would also reject *empty* extractions whenever the delta held no user message.
- **Empty delta.** The run reserves with the context block as its window, so the source position stays on the cursor. Then one `compareAndSwap` no-op with `extractorUsage: null` and `reconcilerUsage: null`, and the normal succeeded result. For lifecycle, migration 077's gate answers `daily_cap` first in production (0 new messages); the no-op path is still implemented and tested, so both pipelines honor one contract. If the context block contains no user message, validation fails with `invalid_source` (rare: five assistant messages in a row ending at the cursor).
- **Cursor lookup failure (changed from the first draft).** A throwing or malformed lookup now fails the run as `invalid_source` before loading, with the same fixed-literal `console.error`. The first draft fell back to the first-run window. But that window is byte-fitted from the newest end, so during a drain it would succeed and move the cursor past the undrained backlog.
- **Drain-test infrastructure.** No shared helper module.
  - `messages.cases.test.ts` gains a table-backed fake client that actually evaluates the `.or()` keyset, ordering, and limits over an in-memory conversation. It replaces the first draft's canned-response fake, so one test walks a 150-message backlog through repeated real loads.
  - Each runner test file gains a small fake loader implementing the same two call shapes over a plain array, plus a tracking store that mirrors `lastSucceededCursor`'s query. Together they drive the real runner through a whole sequence, with messages big enough that the byte cap, not the 55-message chunk, sizes each window.
- **Store method.** `lastSucceededCursor({ userId, conversationId })` on both stores, using the existing service-role client's `from()`. service_role already holds `SELECT` on both run tables (migrations 034/039). `from` is optional in the client type and is looked up only when the method runs, so rpc-only clients still construct.
- **Cursor ordering.** The cursor is the maximum over succeeded runs **by source position** (`source_last_created_at DESC, source_last_message_id DESC`), not by completion time. A late-finishing run with an older window can never move it backwards (the spec's race-safety bullet).
- **Files touched beyond the spec's list:**
  - `tokenEstimate.ts` (new) and `cost.ts` (re-export);
  - `dialogueStore.ts` and `lifecycleStore.ts` (home of the lookup);
  - `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts` (it asserted the old "all messages" request shape);
  - `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` (two pinned hashes).

## Pre-flight

The worktree is on `fix/memory-v3-lifecycle-watermark-restore`. The spec was committed as `640b842` and revised in `72c83af` (oldest-first draining); this plan was committed after both. Before Task 1, ask your human partner whether to keep committing on this branch or to branch off the current commit (for example `git switch -c feat/memory-v3-delta-windowing`). Either way, Task 11 diffs code against `640b842` and checks `docs/superpowers` separately.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/functions/_shared/tokenEstimate.ts` | Dependency-free `estimateTokens` | Create |
| `supabase/functions/_shared/tokenEstimate.cases.test.ts` | Pins the rule and the re-export | Create |
| `supabase/functions/_shared/cost.ts` | Re-exports `estimateTokens` | Modify lines 363-366 |
| `supabase/functions/_shared/memoryV3/messages.ts` | `MemoryV3SourceCursor`, `MemoryV3DeltaWindow`, `MemoryV3MessageLoader`, delta constants, oldest-first delta loader | Modify |
| `supabase/functions/_shared/memoryV3/messages.cases.test.ts` | Loader delta tests, table-backed fake, 150-message drain | Modify |
| `supabase/functions/_shared/memoryV3/dialoguePrompt.ts` | Evidence-only reconciler `messages` | Modify lines 318-361 |
| `supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts` | Evidence-only tests | Modify (append) |
| `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts` | Evidence-only reconciler `messages` | Modify lines 317-360 |
| `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` | Evidence-only tests | Modify (append) |
| `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts` | Fast path, shared CAS helper, cursor lookup, delta byte fit, empty-delta no-op, delta-only evidence, delta input identity | Modify |
| `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts` | Fast-path, cursor, and drain tests | Modify |
| `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts` | Fast path, shared CAS helper, cursor lookup, delta byte fit, empty-delta no-op, delta-only evidence, delta input identity | Modify |
| `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts` | Fast-path, cursor, and drain tests | Modify |
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

### Task 2: Delta-aware message loader (oldest-first draining)

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
export interface MemoryV3DeltaWindow {
  context: MemoryV3DialogueMessage[];   // <=5 at/before the cursor, chronological; never new evidence
  delta: MemoryV3DialogueMessage[];     // oldest undrained after the cursor, chronological; [] = nothing new
  latestMessageId: string;              // the conversation's newest message id at load time
}
export interface MemoryV3MessageLoader {
  (userId: string, conversationId: string): Promise<MemoryV3DialogueMessage[]>;
  (userId: string, conversationId: string, sinceCursor: MemoryV3SourceCursor): Promise<MemoryV3DeltaWindow>;
}
export const MEMORY_V3_DELTA_CONTEXT_MESSAGES = 5;
export const MEMORY_V3_DELTA_MAX_MESSAGES = 55;
export const MEMORY_V3_DELTA_MAX_TOKENS = 4_000;
export function createMemoryV3MessageLoader(client: MemoryV3MessageClient): MemoryV3MessageLoader;
```

The two-argument call is exactly today's loader, so `staysee-chat/index.ts` and the legacy `shadowRunner.ts` need no change. Passing a third argument always means a cursor: `null` is rejected as malformed, never read as "no cursor".

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

type MessageRow = { id: string; sender: "user" | "ai"; content: string; created_at: string };

function timeline(index: number): string {
  return new Date(Date.UTC(2026, 8, 5, 10, 0, index)).toISOString();
}

function messageRow(index: number, content = TOKEN_200_TEXT, createdAt = timeline(index)): MessageRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sender: index % 2 === 1 ? "user" : "ai",
    content,
    created_at: createdAt,
  };
}

function rowsBetween(first: number, last: number, content = TOKEN_200_TEXT): MessageRow[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => messageRow(first + offset, content));
}

function cursorAt(row: MessageRow) {
  return { messageId: row.id, createdAt: row.created_at };
}

function idsOf(messages: Array<{ id: string }>): string[] {
  return messages.map(({ id }) => id);
}

const KEYSET_FILTER = /^created_at\.(gt|lt)\."([^"]+)",and\(created_at\.eq\."\2",id\.(gt|lte)\.([0-9a-f-]{36})\)$/;

type TableOptions = { deltaResponse?: unknown; latestResponse?: unknown };

// An in-memory messages table that actually evaluates the loader's keyset
// filter, ordering, and limit, so a test can walk a whole run sequence over
// one fixed conversation. deltaResponse / latestResponse override that one
// query's answer to simulate an inconsistent or failing database.
function createTableFakeClient(rows: MessageRow[], options: TableOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  function builder(table: string) {
    let columns = "";
    let direction: "after" | "atOrBefore" | null = null;
    let keep: (row: MessageRow) => boolean = () => true;
    const orders: Array<{ column: string; ascending: boolean }> = [];
    const chain = {
      select(selected: string) { columns = selected; calls.push({ method: "select", args: [table, selected] }); return chain; },
      eq(column: string, value: unknown) { calls.push({ method: "eq", args: [table, column, value] }); return chain; },
      or(expression: string) {
        calls.push({ method: "or", args: [table, expression] });
        const match = KEYSET_FILTER.exec(expression);
        if (!match) throw new Error("unexpected or() filter");
        const [, timeOperator, createdAt, idOperator, id] = match;
        const at = Date.parse(createdAt);
        direction = timeOperator === "gt" ? "after" : "atOrBefore";
        keep = (row) => {
          const rowAt = Date.parse(row.created_at);
          if (rowAt !== at) return timeOperator === "gt" ? rowAt > at : rowAt < at;
          return idOperator === "gt" ? row.id > id : row.id <= id;
        };
        return chain;
      },
      order(column: string, config: { ascending: boolean }) {
        calls.push({ method: "order", args: [table, column, config] });
        orders.push({ column, ascending: config.ascending });
        return chain;
      },
      limit(value: number) {
        calls.push({ method: "limit", args: [table, value] });
        if (direction === "after" && options.deltaResponse !== undefined) return Promise.resolve(options.deltaResponse);
        if (direction === null && columns === "id" && options.latestResponse !== undefined) {
          return Promise.resolve(options.latestResponse);
        }
        const selected = rows.filter(keep).sort((left, right) => {
          for (const { column, ascending } of orders) {
            const compared = column === "created_at"
              ? Date.parse(left.created_at) - Date.parse(right.created_at)
              : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
            if (compared !== 0) return ascending ? compared : -compared;
          }
          return 0;
        });
        const data = selected.slice(0, value).map((row) => (columns === "id" ? { id: row.id } : { ...row }));
        return Promise.resolve({ data, error: null });
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

test("createMemoryV3MessageLoader never token-caps a first run, even a long pre-rollout conversation", async () => {
  const rows = rowsBetween(1, 60); // 60 x 200 = 12000 estimated tokens
  const fake = createFakeClient({ rows });
  const result = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID);
  assert.equal(result.length, 60);
  assert.equal(fake.calls.at(-1)?.args[1], 60);
});

test("createMemoryV3MessageLoader loads the oldest messages after the cursor, the 5 ending at it, and the latest id", async () => {
  const rows = rowsBetween(1, 20, "Короткое сообщение");
  const fake = createTableFakeClient(rows);
  const cursor = cursorAt(rows[4]);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursor);
  assert.deepEqual(idsOf(loaded.context), idsOf(rows.slice(0, 5)));
  assert.deepEqual(idsOf(loaded.delta), idsOf(rows.slice(5)));
  assert.equal(loaded.latestMessageId, rows[19].id);
  const after = `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.gt.${cursor.messageId})`;
  const atOrBefore = `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lte.${cursor.messageId})`;
  assert.deepEqual(fake.calls.slice(5), [
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "or", args: ["messages", after] },
    { method: "order", args: ["messages", "created_at", { ascending: true }] },
    { method: "order", args: ["messages", "id", { ascending: true }] },
    { method: "limit", args: ["messages", 55] },
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id, sender, content, created_at"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "or", args: ["messages", atOrBefore] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 5] },
    { method: "from", args: ["messages"] },
    { method: "select", args: ["messages", "id"] },
    { method: "eq", args: ["messages", "conversation_id", CONVERSATION_ID] },
    { method: "order", args: ["messages", "created_at", { ascending: false }] },
    { method: "order", args: ["messages", "id", { ascending: false }] },
    { method: "limit", args: ["messages", 1] },
  ]);
});

test("createMemoryV3MessageLoader hands out the OLDEST 55 of a larger backlog, never the newest", async () => {
  const rows = rowsBetween(1, 100, "Короткое сообщение");
  const fake = createTableFakeClient(rows);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
  assert.deepEqual(idsOf(loaded.delta), idsOf(rows.slice(5, 60)));
  assert.equal(loaded.latestMessageId, rows[99].id);
});

test("createMemoryV3MessageLoader places same-timestamp messages on the right side of the cursor by id", async () => {
  // Messages 2, 3, and 4 share one created_at and the cursor is on 3. A
  // time-only comparison would put 4 at-or-before the cursor and skip it
  // forever; the compound (created_at, id) comparison must not.
  const shared = timeline(2);
  const rows = [
    messageRow(1, "Первое"),
    messageRow(2, "Второе", shared),
    messageRow(3, "Третье", shared),
    messageRow(4, "Четвёртое", shared),
    messageRow(5, "Пятое"),
  ];
  const fake = createTableFakeClient(rows);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[2]));
  assert.deepEqual(idsOf(loaded.context), idsOf(rows.slice(0, 3)));
  assert.deepEqual(idsOf(loaded.delta), idsOf(rows.slice(3)));
});

test("createMemoryV3MessageLoader returns an empty delta when nothing new arrived since the cursor", async () => {
  const rows = rowsBetween(1, 5, "Контекст");
  const fake = createTableFakeClient(rows);
  const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
  assert.deepEqual(idsOf(loaded.context), idsOf(rows));
  assert.deepEqual(loaded.delta, []);
  assert.equal(loaded.latestMessageId, rows[4].id);
});

test("createMemoryV3MessageLoader meets the token target by trimming the NEWEST end of the chunk; the trimmed messages open the next window", async () => {
  const rows = rowsBetween(1, 25); // 200 estimated tokens each
  const fake = createTableFakeClient(rows);
  const load = createMemoryV3MessageLoader(fake.client);
  const first = await load(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
  // 5 context x 200 + 15 delta x 200 = 4000: messages 6-20 fit, 21-25 wait.
  assert.deepEqual(idsOf(first.context), idsOf(rows.slice(0, 5)));
  assert.deepEqual(idsOf(first.delta), idsOf(rows.slice(5, 20)));
  const next = await load(USER_ID, CONVERSATION_ID, cursorAt(rows[19]));
  assert.deepEqual(idsOf(next.delta), idsOf(rows.slice(20)));
});

test("createMemoryV3MessageLoader keeps the context block and the oldest undrained message even when they alone exceed the token target", async () => {
  for (const rows of [
    [...rowsBetween(1, 5), messageRow(6, "я".repeat(14_000)), messageRow(7)], // oldest delta message alone = 4000
    [...rowsBetween(1, 5, "я".repeat(3_500)), messageRow(6), messageRow(7)], // context alone = 5000
  ]) {
    const fake = createTableFakeClient(rows);
    const loaded = await createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4]));
    assert.deepEqual(idsOf(loaded.context), idsOf(rows.slice(0, 5)));
    assert.deepEqual(idsOf(loaded.delta), [rows[5].id]);
  }
});

test("createMemoryV3MessageLoader drains a 150-message backlog oldest-first: every message in exactly one window, no gap", async () => {
  const rows = rowsBetween(1, 155); // cursor on message 5, then 150 undrained
  const fake = createTableFakeClient(rows);
  const load = createMemoryV3MessageLoader(fake.client);
  const drained: string[] = [];
  let cursor = cursorAt(rows[4]);
  let loads = 0;
  for (;;) {
    const loaded = await load(USER_ID, CONVERSATION_ID, cursor);
    loads += 1;
    assert.equal(loads <= 50, true);
    if (loaded.delta.length === 0) break;
    drained.push(...idsOf(loaded.delta));
    // The next cursor is the last message THIS window actually carried.
    const last = loaded.delta[loaded.delta.length - 1];
    cursor = { messageId: last.id, createdAt: last.createdAt };
  }
  assert.deepEqual(drained, idsOf(rows.slice(5)));
  // 10 windows of 15 (the token target binds every time), then the empty one.
  assert.equal(loads, 11);
});

test("createMemoryV3MessageLoader rejects a malformed cursor, null included, before any database access", async () => {
  let getterCalls = 0;
  const accessor = { messageId: USER_MESSAGE_ID } as Record<string, unknown>;
  Object.defineProperty(accessor, "createdAt", {
    enumerable: true,
    get() { getterCalls += 1; return "2026-09-05T10:00:00.000Z"; },
  });
  for (const cursor of [
    null,
    { messageId: "not-a-uuid", createdAt: "2026-09-05T10:00:00.000Z" },
    { messageId: USER_MESSAGE_ID, createdAt: "yesterday" },
    { messageId: USER_MESSAGE_ID, createdAt: "2026-09-05T10:00:00.000Z", extra: "RAW_DB_SECRET_SENTINEL" },
    accessor,
  ]) {
    const fake = createTableFakeClient([]);
    await assert.rejects(
      () => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursor as never),
      assertSafeError,
    );
    assert.equal(fake.calls.length, 0);
  }
  assert.equal(getterCalls, 0);
});

test("createMemoryV3MessageLoader rejects a delta that overlaps its context, arrives out of order, or errors, and a missing latest message", async () => {
  const rows = rowsBetween(1, 7);
  for (const options of [
    { deltaResponse: { data: [rows[4]], error: null } },
    { deltaResponse: { data: [rows[6], rows[5]], error: null } },
    { deltaResponse: { data: null, error: { message: "RAW_DB_SECRET_SENTINEL" } } },
    { latestResponse: { data: [], error: null } },
    { latestResponse: { data: null, error: { message: "RAW_DB_SECRET_SENTINEL" } } },
  ]) {
    const fake = createTableFakeClient(rows, options);
    await assert.rejects(
      () => createMemoryV3MessageLoader(fake.client)(USER_ID, CONVERSATION_ID, cursorAt(rows[4])),
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

/** A succeeded run's source position: the last message that run actually sent to its extractor. */
export interface MemoryV3SourceCursor {
  messageId: string;
  createdAt: string;
}

/** What a delta-mode load returns (spec 2026-10-13 §1). Both lists are chronological. */
export interface MemoryV3DeltaWindow {
  /** Up to 5 messages at or before the cursor -- continuity only, never new evidence. */
  context: MemoryV3DialogueMessage[];
  /** The oldest undrained messages after the cursor, trimmed from the newest end; empty when nothing is new. */
  delta: MemoryV3DialogueMessage[];
  /** The conversation's newest message id at load time; may lie beyond `delta`. */
  latestMessageId: string;
}

/** Without a cursor: exactly the pre-delta last-60 window. With one: a delta window. */
export interface MemoryV3MessageLoader {
  (userId: string, conversationId: string): Promise<MemoryV3DialogueMessage[]>;
  (userId: string, conversationId: string, sinceCursor: MemoryV3SourceCursor): Promise<MemoryV3DeltaWindow>;
}

export interface MemoryV3MessageClient {
  from(table: string): unknown;
}

/** Messages at or before the cursor re-sent for continuity (spec 2026-10-13 §1). */
export const MEMORY_V3_DELTA_CONTEXT_MESSAGES = 5;
/** Oldest undrained messages fetched per run: the 60-message source cap (MEMORY_V3_MAX_SOURCE_MESSAGES) minus the context block. */
export const MEMORY_V3_DELTA_MAX_MESSAGES = 55;
/** Estimated-token target (estimateTokens, chars/3.5) for context + delta together -- a target, not a ceiling. */
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

3c. In `inspectDenseArray`, replace `function inspectDenseArray(value: unknown): unknown[] {` with `function inspectDenseArray(value: unknown, minimum = 1, maximum = 60): unknown[] {`. Then replace `    if (length < 1 || length > 60 || keys.length !== length + 1) throw fail();` with `    if (length < minimum || length > maximum || keys.length !== length + 1) throw fail();`.

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

export function projectMemoryV3SourceRows(rows: unknown): MemoryV3DialogueMessage[] {
  const sourceRows = inspectDenseArray(rows);
  const ids = new Set<string>();
  const projected = sourceRows.map((source) => projectRow(source, ids));
  if (!projected.some((message) => message.role === "user")) throw fail();
  projected.sort((left, right) => {
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime !== 0 ? byTime : compareCodeUnits(left.id, right.id);
  });
  return projected;
}

// Delta mode keeps the database's own (created_at, id) order exactly as
// returned and never re-sorts: Date.parse() resolves only milliseconds while
// created_at carries microseconds, so a client-side sort could swap two
// same-millisecond messages and put the next cursor on the wrong one. Only a
// gross misordering (a later millisecond before an earlier one) is
// detectable here, and it is rejected.
function projectInDatabaseOrder(rows: unknown[], ids: Set<string>): MemoryV3DialogueMessage[] {
  const messages = rows.map((row) => projectRow(row, ids));
  for (let index = 1; index < messages.length; index += 1) {
    if (Date.parse(messages[index - 1].createdAt) > Date.parse(messages[index].createdAt)) throw fail();
  }
  return messages;
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

function inspectLatestRow(value: unknown): string {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "id") throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !isCanonicalUuid(descriptor.value)) throw fail();
    return descriptor.value;
  } catch (error) {
    rethrowSafe(error, "invalid source messages");
  }
}

// Spec 2026-10-13 §1: the token budget is a target, not a ceiling. Keeps the
// longest OLDEST-first prefix of the chunk that fits alongside the context
// block. The trimmed newest messages are not lost -- they open the next run,
// because the cursor only advances to the last message a run actually sends.
// Never trims the context block, and never the oldest undrained message
// (without it the run would analyze nothing new), even when either alone is
// over the target.
function capDeltaToTokenTarget(
  context: MemoryV3DialogueMessage[],
  delta: MemoryV3DialogueMessage[],
): MemoryV3DialogueMessage[] {
  let total = context.reduce((sum, message) => sum + estimateTokens(message.text), 0);
  let end = 0;
  while (end < delta.length) {
    const next = total + estimateTokens(delta[end].text);
    if (end > 0 && next > MEMORY_V3_DELTA_MAX_TOKENS) break;
    total = next;
    end += 1;
  }
  return delta.slice(0, end);
}
```

3e. Replace the whole existing `createMemoryV3MessageLoader` function (from `export function createMemoryV3MessageLoader(` through its final closing `}`) with:

```ts
function selectConversationMessages(client: MemoryV3MessageClient, conversationId: string): unknown {
  const query = call(call(client, "from", "messages"), "select", "id, sender, content, created_at");
  return call(query, "eq", "conversation_id", conversationId);
}

// PostgREST keyset filters: (created_at, id) compared lexicographically with
// the cursor -- never created_at alone, which would skip or repeat a message
// sharing the cursor's timestamp. Both values were validated by
// inspectCursor (canonical UUID; ISO timestamp, which cannot contain a quote,
// comma, or parenthesis). The timestamp is the exact string the store read
// back (microsecond precision) and is double-quoted because it contains ':'
// and '.'.
function afterCursor(cursor: MemoryV3SourceCursor): string {
  return `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.gt.${cursor.messageId})`;
}

function atOrBeforeCursor(cursor: MemoryV3SourceCursor): string {
  return `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lte.${cursor.messageId})`;
}

// Delta mode (spec 2026-10-13 §1): the OLDEST undrained messages after the
// cursor -- a backlog bigger than one chunk drains across several runs,
// oldest-first, so nothing is ever skipped -- plus the few at/before it for
// continuity, plus the conversation's latest message id (the runner folds it
// into the run's input identity so a failed window can be retried once
// anything new is written).
async function loadDeltaWindow(
  client: MemoryV3MessageClient,
  conversationId: string,
  cursor: MemoryV3SourceCursor,
): Promise<MemoryV3DeltaWindow> {
  let deltaQuery = call(selectConversationMessages(client, conversationId), "or", afterCursor(cursor));
  deltaQuery = call(deltaQuery, "order", "created_at", { ascending: true });
  deltaQuery = call(deltaQuery, "order", "id", { ascending: true });
  const delta = inspectResponse(await call(deltaQuery, "limit", MEMORY_V3_DELTA_MAX_MESSAGES));
  if (delta.error !== null) throw fail("message query failed");

  // Newest-first so the limit keeps the 5 closest to the cursor; reversed
  // into chronological order below.
  let contextQuery = call(selectConversationMessages(client, conversationId), "or", atOrBeforeCursor(cursor));
  contextQuery = call(contextQuery, "order", "created_at", { ascending: false });
  contextQuery = call(contextQuery, "order", "id", { ascending: false });
  const context = inspectResponse(await call(contextQuery, "limit", MEMORY_V3_DELTA_CONTEXT_MESSAGES));
  if (context.error !== null) throw fail("message query failed");

  let latestQuery = call(call(client, "from", "messages"), "select", "id");
  latestQuery = call(latestQuery, "eq", "conversation_id", conversationId);
  latestQuery = call(latestQuery, "order", "created_at", { ascending: false });
  latestQuery = call(latestQuery, "order", "id", { ascending: false });
  const latest = inspectResponse(await call(latestQuery, "limit", 1));
  if (latest.error !== null) throw fail("message query failed");

  const ids = new Set<string>();
  const deltaMessages = projectInDatabaseOrder(inspectDenseArray(delta.data, 0, MEMORY_V3_DELTA_MAX_MESSAGES), ids);
  const contextMessages = projectInDatabaseOrder(
    inspectDenseArray(context.data, 0, MEMORY_V3_DELTA_CONTEXT_MESSAGES).reverse(),
    ids,
  );
  return {
    context: contextMessages,
    delta: capDeltaToTokenTarget(contextMessages, deltaMessages),
    latestMessageId: inspectLatestRow(inspectDenseArray(latest.data, 1, 1)[0]),
  };
}

export function createMemoryV3MessageLoader(client: MemoryV3MessageClient): MemoryV3MessageLoader {
  getMethod(client, "from");
  const load = async (
    userId: string,
    conversationId: string,
    sinceCursor?: MemoryV3SourceCursor,
  ): Promise<MemoryV3DialogueMessage[] | MemoryV3DeltaWindow> => {
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(conversationId)) throw fail("invalid identifiers");
    // The call shape alone picks the mode: an omitted cursor is today's
    // window; anything passed must be a valid cursor -- null included, which
    // is a caller bug, not "no cursor".
    const cursor = sinceCursor === undefined ? null : inspectCursor(sinceCursor);
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
  return load as MemoryV3MessageLoader;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/messages.cases.test.ts`

Expected: PASS, 24 tests (13 existing + 11 new), 0 failures. The existing exact call-sequence test ("verifies ownership before loading bounded messages") still passes, which proves the two-argument path is unchanged.

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
feat: Memory V3 loader drains the unseen backlog oldest-first after a succeeded run

With a cursor (the conversation's last succeeded run), load the OLDEST
55 messages after it by (created_at, id), the 5 at/before it for
continuity, and the conversation's latest message id. The 4000-token
target trims the newest end of that chunk -- never the context block,
never the oldest undrained message -- so trimmed messages simply open
the next run. Without a cursor the existing last-60 query runs
unchanged and uncapped. Re-pins messages.ts in the lifecycle backfill
frozen-source gate (intentional change).

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
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`. Every edit is anchored on exact text; the line numbers are from before Task 5.
  - imports (lines 1-8);
  - `loadMessages` option (line 58);
  - add `fitDeltaWindowToByteCap` before `function inspectExactRecord` (line 120);
  - `ownMethod` (line 169);
  - add `projectSourceCursor` and `inspectDeltaWindow` before `function canonicalStringify` (line 180);
  - `inputHash` (lines 189-196);
  - gate, cursor lookup, load, and hash block (lines 313-336);
  - empty-delta no-op before `let extractor: MemoryV3TransportResult;` (line 401);
  - delta-only evidence check after the `extractor_contract_invalid` catch (line 443).
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`:
  - harness (lines 69-133);
  - new `describe` inserted before `describe("Memory V3 dialogue background isolation"`.

**Interfaces:**
- Consumes:
  - `MemoryV3SourceCursor`, `MemoryV3MessageLoader`, and the `MemoryV3DeltaWindow` shape (Task 2);
  - `MemoryV3DialogueStore.lastSucceededCursor({ userId, conversationId })` (Task 7);
  - `persistCompareAndSwap` and the empty-extraction fast path (Task 5; the empty-delta no-op and the sequence tests rely on them).
- Produces: `MemoryV3DialogueShadowOptions.loadMessages: MemoryV3MessageLoader`. The runner calls it with two arguments when no run has succeeded, and with the cursor otherwise. A store missing `lastSucceededCursor`, or a lookup that throws or returns garbage, yields `invalid_source` before any message load.

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
  type Message = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
  const PRIOR_MESSAGE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const OTHER_MESSAGE_ID = "99999999-9999-4999-8999-999999999999";
  const PRIOR: Message = { id: PRIOR_MESSAGE_ID, role: "assistant", text: "Привет! Как прошёл день?", createdAt: "2026-09-15T09:00:00Z" };
  const NEW: Message = { id: MESSAGE_ID, role: "user", text: "Я люблю утренние прогулки", createdAt: CREATED_AT };
  const LATER: Message = { id: OTHER_MESSAGE_ID, role: "user", text: "Сегодня снова гуляла", createdAt: "2026-09-15T11:00:00Z" };
  const PRIOR_CURSOR = { messageId: PRIOR_MESSAGE_ID, createdAt: PRIOR.createdAt };
  const NEW_CURSOR = { messageId: MESSAGE_ID, createdAt: CREATED_AT };
  const sentIds = (request: unknown) =>
    (request as { input: { messages: Array<{ id: string }> } }).input.messages.map(({ id }) => id);

  function withCursor(test: ReturnType<typeof harness>, cursor: unknown) {
    test.options.store = {
      ...test.store,
      async lastSucceededCursor(input) {
        test.calls.push("cursor");
        test.cursorInputs.push(input);
        return cursor as never;
      },
    };
    return test;
  }

  // Mirrors createMemoryV3MessageLoader's two call shapes over an in-memory
  // conversation (its real queries are covered in messages.cases.test.ts):
  // no cursor -> the last 60; a cursor -> the 5 messages ending at it, the
  // oldest 55 after it, and the newest id. Records each call's cursor, or
  // null for a two-argument call.
  function windowLoader(conversation: () => Message[], seen: unknown[]) {
    return async (_userId: string, _conversationId: string, ...cursor: unknown[]) => {
      const visible = conversation();
      if (cursor.length === 0) {
        seen.push(null);
        return visible.slice(-60);
      }
      seen.push(cursor[0]);
      const at = visible.findIndex((message) => message.id === (cursor[0] as { messageId: string }).messageId);
      return {
        context: visible.slice(Math.max(0, at - 4), at + 1),
        delta: visible.slice(at + 1, at + 56),
        latestMessageId: visible[visible.length - 1].id,
      };
    };
  }

  // Tracks every reserved run and answers lastSucceededCursor the way the
  // real query does: succeeded runs only, furthest (created_at, id) first.
  function trackingStore(seed: { messageId: string; createdAt: string } | null = null) {
    const runs: Array<{ runId: string; status: "reserved" | "succeeded" | "failed"; messageId: string; createdAt: string }> = [];
    const nextRunId = () => `eeeeeeee-eeee-4eee-8eee-${String(runs.length + 1).padStart(12, "0")}`;
    if (seed !== null) runs.push({ runId: nextRunId(), status: "succeeded", ...seed });
    const store: MemoryV3DialogueStore = {
      async reserve(input) {
        const runId = nextRunId();
        runs.push({ runId, status: "reserved", messageId: input.sourceLastMessageId, createdAt: input.sourceLastCreatedAt });
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
      async lastSucceededCursor() {
        const best = runs
          .filter((run) => run.status === "succeeded")
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            (left.messageId < right.messageId ? 1 : left.messageId > right.messageId ? -1 : 0))[0];
        return best ? { messageId: best.messageId, createdAt: best.createdAt } : null;
      },
    };
    return { store, runs };
  }

  it("loads today's first-run window, with no cursor argument at all, when no run of this conversation has succeeded", async () => {
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        loaderArgs.push(args);
        return [NEW];
      },
    });
    assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID]]);
  });

  it("reads this conversation's last succeeded cursor before loading, then loads only what follows it", async () => {
    const loaderArgs: unknown[][] = [];
    const test = withCursor(harness({
      async loadMessages(...args: unknown[]) {
        test.calls.push("messages");
        loaderArgs.push(args);
        return { context: [PRIOR], delta: [NEW], latestMessageId: MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.calls.slice(0, 3), ["cursor", "messages", "reserve"]);
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, PRIOR_CURSOR]]);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
    assert.equal((test.reserveInputs[0] as { sourceLastMessageId: string }).sourceLastMessageId, MESSAGE_ID);
  });

  it("fails the run before loading anything when the cursor lookup throws or returns garbage -- never a fallback window", async () => {
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
        const test = harness();
        test.options.store = { ...test.store, lastSucceededCursor: lookup as never };
        assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
          status: "failed", runId: null, diagnosticCode: "invalid_source",
        });
        assert.deepEqual(test.calls, []);
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

  it("never calls the extractor when nothing new arrived since the cursor, and still ends as a succeeded no-op", async () => {
    const test = withCursor(harness({
      async loadMessages() {
        test.calls.push("messages");
        return { context: [PRIOR, NEW], delta: [], latestMessageId: MESSAGE_ID };
      },
    }), NEW_CURSOR);
    const logged: unknown[] = [];
    const result = await runMemoryV3DialogueShadow(test.options, undefined, async (input) => { logged.push(input); });
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0, transitionCount: 0, stateRevision: 0,
    });
    assert.deepEqual(test.calls, ["cursor", "messages", "reserve", "cas"]);
    const reserved = test.reserveInputs[0] as { sourceLastMessageId: string; sourceLastCreatedAt: string };
    assert.equal(reserved.sourceLastMessageId, MESSAGE_ID);
    assert.equal(reserved.sourceLastCreatedAt, CREATED_AT);
    assert.deepEqual(test.casInputs, [{
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
      extractorUsage: null,
      reconcilerUsage: null,
    }]);
    assert.deepEqual(logged, []);
    assert.deepEqual(test.failInputs, []);
  });

  it("rejects an extraction citing a leading-context message exactly like an unknown id, before the reconciler", async () => {
    // The harness extractor cites MESSAGE_ID, which is a context message here.
    const test = withCursor(harness({
      async loadMessages() {
        test.calls.push("messages");
        return { context: [PRIOR, NEW], delta: [LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), NEW_CURSOR);
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "extractor_contract_invalid",
    });
    assert.equal(test.calls.includes("reconcilerFactory"), false);
    assert.equal(test.calls.at(-1), "fail:extractor_contract_invalid");
  });

  it("sends the context and the oldest undrained message even over the byte cap, rather than skipping it", async () => {
    const HUGE: Message = { ...NEW, text: `Я люблю утренние прогулки ${"x".repeat(21_000)}` };
    const test = withCursor(harness({
      async loadMessages() {
        return { context: [PRIOR], delta: [HUGE, LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    const original = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    let status: string;
    try {
      status = (await runMemoryV3DialogueShadow(test.options)).status;
    } finally {
      console.warn = original;
    }
    assert.equal(status, "succeeded");
    assert.deepEqual(warned, [["[memory-v3-dialogue-delta-over-byte-cap]"]]);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
    assert.equal((test.reserveInputs[0] as { sourceLastMessageId: string }).sourceLastMessageId, MESSAGE_ID);
  });

  it("folds the conversation's latest message into a delta run's input identity, so a failed window can be retried once anything new is written", async () => {
    const hashes: string[] = [];
    for (const latestMessageId of [MESSAGE_ID, MESSAGE_ID, OTHER_MESSAGE_ID]) {
      const test = withCursor(harness({
        async loadMessages() {
          return { context: [PRIOR], delta: [NEW], latestMessageId };
        },
      }), PRIOR_CURSOR);
      assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
      hashes.push((test.reserveInputs[0] as { inputHash: string }).inputHash);
    }
    // Same window, same conversation state: a genuine duplicate.
    assert.equal(hashes[0], hashes[1]);
    // Same window, but something newer was written since: a distinct identity
    // the reservation accepts, even though the window itself is identical.
    assert.notEqual(hashes[1], hashes[2]);
  });

  it("advances the delta cursor only on succeeded runs (fail, succeed, fail, then read)", async () => {
    const conversation: Message[] = Array.from({ length: 8 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "user",
      text: `Сообщение ${index + 1}`,
      createdAt: `2026-09-15T10:0${index}:00Z`,
    }));
    const tracked = trackingStore();
    const seenCursors: unknown[] = [];
    let visible = 0;
    let extractorFails = false;
    const options = {
      ...harness().options,
      store: tracked.store,
      loadMessages: windowLoader(() => conversation.slice(0, visible), seenCursors),
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
    assert.deepEqual(tracked.runs.map((run) => run.status), ["failed", "succeeded", "failed", "succeeded"]);
    const afterRun2 = { messageId: conversation[3].id, createdAt: conversation[3].createdAt };
    // Run 3 failed after covering messages 5-6, so run 4 must still read from
    // run 2 -- and re-offer 5-6 ahead of 7-8.
    assert.deepEqual(seenCursors, [null, null, afterRun2, afterRun2]);
    assert.deepEqual(tracked.runs.map((run) => run.messageId), [1, 3, 5, 7].map((index) => conversation[index].id));
  });

  it("drains a 150-message backlog oldest-first across runs: every message reaches exactly one extractor window, none skipped", async () => {
    // Cursor seeded on message 1, then 150 undrained messages, each big enough
    // that the 20 KB extractor cap -- not the 55-message chunk -- sizes every
    // window.
    const conversation: Message[] = Array.from({ length: 151 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `${index + 1}: ${"я".repeat(300)}`,
      createdAt: new Date(Date.UTC(2026, 8, 15, 10, 0, index)).toISOString(),
    }));
    const position = (id: string) => conversation.findIndex((message) => message.id === id);
    const tracked = trackingStore({ messageId: conversation[0].id, createdAt: conversation[0].createdAt });
    const seenCursors: unknown[] = [];
    const sent: string[][] = [];
    const options = {
      ...harness().options,
      store: tracked.store,
      loadMessages: windowLoader(() => conversation, seenCursors),
      extractorAdapterFactory: () => async (request: unknown) => {
        sent.push(sentIds(request));
        return { content: emptyExtractorContent, usage: null };
      },
    };
    const drained: string[] = [];
    for (let attempt = 1; ; attempt += 1) {
      assert.equal(attempt <= 40, true);
      const windowsBefore = sent.length;
      assert.equal((await runMemoryV3DialogueShadow(options)).status, "succeeded");
      if (sent.length === windowsBefore) break; // the empty-delta run: no extractor call at all
      const cursorId = (seenCursors.at(-1) as { messageId: string }).messageId;
      const ids = sent[sent.length - 1];
      const contextEnd = ids.indexOf(cursorId);
      assert.equal(contextEnd >= 0 && contextEnd <= 4, true);
      const delta = ids.slice(contextEnd + 1);
      // Each delta starts right after the cursor: no gap at the seam.
      assert.equal(position(delta[0]), position(cursorId) + 1);
      drained.push(...delta);
    }
    // Every undrained message was sent in exactly one run's delta, in order.
    assert.deepEqual(drained, conversation.slice(1).map(({ id }) => id));
    // The byte cap sized the windows, so the backlog took several runs.
    assert.equal(sent.length > 2, true);
    assert.equal(sent.every((ids) => ids.length < 60), true);
    // Each run's stored source position is the last message it actually sent,
    // and the closing no-op run leaves the cursor on the final message.
    assert.deepEqual(tracked.runs.slice(1, 1 + sent.length).map((run) => run.messageId), sent.map((ids) => ids[ids.length - 1]));
    assert.equal(tracked.runs[tracked.runs.length - 1].messageId, conversation[150].id);
    assert.equal(tracked.runs.every((run) => run.status === "succeeded"), true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

Expected: FAIL on all ten new tests. The runner doesn't call `lastSucceededCursor` yet and always calls the loader with two arguments, so:
- `cursorInputs` stays empty;
- every test whose loader returns a delta window ends in `invalid_source`, because a window object is not a message array;
- the lookup-failure and missing-method tests still succeed;
- `seenCursors` holds only `null`, so the sequence and drain tests fail.

All pre-existing tests still pass.

- [ ] **Step 3: Write the implementation**

3a. Replace lines 1-8:

```ts
import {
  MEMORY_V3_MAX_PROMPT_BYTES,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
  type MemoryV3DialogueInput,
  type MemoryV3Extraction,
} from "./contract.ts";
import type { MemoryV3DialogueMessage } from "./messages.ts";
```

with:

```ts
import {
  MEMORY_V3_MAX_PROMPT_BYTES,
  MEMORY_V3_MAX_SOURCE_MESSAGES,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
  type MemoryV3DialogueInput,
  type MemoryV3Extraction,
} from "./contract.ts";
import type {
  MemoryV3DialogueMessage,
  MemoryV3MessageLoader,
  MemoryV3SourceCursor,
} from "./messages.ts";
```

3b. Replace (inside `MemoryV3DialogueShadowOptions`):

```ts
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
```

with:

```ts
  /** Called with two arguments for a first run (today's last-60 window), and
   * with this conversation's last succeeded cursor otherwise -- then it
   * returns a delta window (spec 2026-10-13 §1). */
  loadMessages: MemoryV3MessageLoader;
```

3c. Replace:

```ts
function inspectExactRecord(value: unknown, fields: readonly string[], code: MemoryV3DialogueShadowDiagnostic): JsonRecord {
```

with:

```ts
type FittedExtractorDialogue = {
  dialogue: MemoryV3DialogueInput;
  request: ReturnType<typeof buildMemoryV3DialogueExtractorRequest>;
};

// Delta mode (spec 2026-10-13 §1): the same 20 KB cap, but trimmed from the
// NEWEST end of the delta -- those messages simply open the next run, since
// the cursor only advances to the last message actually sent. (The first-run
// fit above trims the oldest end; here that would let the cursor jump past
// messages no run ever read.) Never drops the context block or the oldest
// undrained message, and stops before the window would hold no user message.
// If even that minimum is over the cap, it is sent as-is: an accepted,
// logged edge case -- never a gap.
function fitDeltaWindowToByteCap(
  caseId: string,
  context: MemoryV3DialogueMessage[],
  delta: MemoryV3DialogueMessage[],
): FittedExtractorDialogue {
  const cap = Math.min(MEMORY_V3_MAX_PROMPT_BYTES, MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES);
  let smallest: FittedExtractorDialogue | null = null;
  for (let end = delta.length; end >= 1; end -= 1) {
    const messages = [...context, ...delta.slice(0, end)];
    if (!messages.some((message) => message.role === "user")) break;
    const dialogue = validateMemoryV3Dialogue({ caseId, messages });
    const request = buildMemoryV3DialogueExtractorRequest(dialogue);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) return { dialogue, request };
    smallest = { dialogue, request };
  }
  if (smallest === null) throw fail("invalid_source");
  console.warn("[memory-v3-dialogue-delta-over-byte-cap]");
  return smallest;
}

function inspectExactRecord(value: unknown, fields: readonly string[], code: MemoryV3DialogueShadowDiagnostic): JsonRecord {
```

3d. Replace:

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

3e. Replace:

```ts
function canonicalStringify(value: unknown): string {
```

with:

```ts
// The store's answer is untrusted until checked here; anything malformed
// fails the run exactly like a failed lookup.
function projectSourceCursor(value: unknown): MemoryV3SourceCursor | null {
  if (value === null) return null;
  const cursor = inspectExactRecord(value, ["messageId", "createdAt"], "invalid_source");
  if (typeof cursor.messageId !== "string" || !UUID.test(cursor.messageId) ||
      typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) {
    throw fail("invalid_source");
  }
  return { messageId: cursor.messageId, createdAt: cursor.createdAt };
}

// The loader's delta-mode answer, checked before anything trusts it. Both
// blocks are validated together (unique ids across them, at most 60 in all,
// at least one user message) and split back at the same boundary.
function inspectDeltaWindow(value: unknown, caseId: string): {
  context: MemoryV3DialogueMessage[];
  delta: MemoryV3DialogueMessage[];
  latestMessageId: string;
} {
  const window = inspectExactRecord(value, ["context", "delta", "latestMessageId"], "invalid_source");
  const context = inspectDenseArray(window.context, MEMORY_V3_MAX_SOURCE_MESSAGES, "invalid_source");
  const delta = inspectDenseArray(window.delta, MEMORY_V3_MAX_SOURCE_MESSAGES, "invalid_source");
  if (typeof window.latestMessageId !== "string" || !UUID.test(window.latestMessageId)) throw fail("invalid_source");
  const messages = validateMemoryV3Dialogue({ caseId, messages: [...context, ...delta] }).messages;
  return {
    context: messages.slice(0, context.length),
    delta: messages.slice(context.length),
    latestMessageId: window.latestMessageId,
  };
}

function canonicalStringify(value: unknown): string {
```

3f. Replace:

```ts
async function inputHash(userId: string, conversationId: string, dialogue: MemoryV3DialogueInput): Promise<string> {
  try {
    const payload = {
      pipelineVersion: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
      userId,
      conversationId,
      messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
```

with:

```ts
async function inputHash(
  userId: string,
  conversationId: string,
  dialogue: MemoryV3DialogueInput,
  latestMessageId: string | null,
): Promise<string> {
  try {
    const payload: JsonRecord = {
      pipelineVersion: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
      userId,
      conversationId,
      messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
    // Delta mode only (spec 2026-10-13 §1). A delta window need not end at the
    // conversation's newest message, so after a failed run the next run can
    // rebuild the very same window -- and the reservation's duplicate check is
    // permanent (an input hash is never released, not even by a failed run),
    // which would freeze this conversation's memory for good. Folding in the
    // newest message id keeps "duplicate" meaning what it means for a first
    // run: same input, same conversation state. A retry goes ahead as soon as
    // anything new is written. First-run hashes are unchanged.
    if (latestMessageId !== null) payload.latestMessageId = latestMessageId;
```

3g. Replace:

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
    const validated = validateMemoryV3Dialogue({ caseId: `memory-v3-shadow:${userId}:${conversationId}`, messages: source });
    const fitted = fitExtractorDialogueToByteCap(validated);
    dialogue = fitted.dialogue;
    extractorRequest = fitted.request;
  } catch {
    return failed(null, "invalid_source");
  }

  let hash: string;
  try {
    hash = await inputHash(userId, conversationId, dialogue);
  } catch {
    return failed(null, "unknown_failure");
  }
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
  // fails the run: falling back to the first-run window could move the cursor
  // past a backlog no run has read. Console-only fixed literal; the error
  // itself is never logged.
  let sinceCursor: MemoryV3SourceCursor | null;
  try {
    sinceCursor = projectSourceCursor(await lastSucceededCursor({ userId, conversationId } as never));
  } catch {
    console.error("[memory-v3-dialogue-cursor-lookup-failed]");
    return failed(null, "invalid_source");
  }

  // extractorRequest stays null for an empty delta (nothing new to read).
  // deltaMessageIds is what this run may cite as evidence: null on a first run
  // (any loaded message), otherwise exactly the delta it sends.
  // latestMessageId feeds the input identity in delta mode only.
  let dialogue: MemoryV3DialogueInput;
  let extractorRequest: ReturnType<typeof buildMemoryV3DialogueExtractorRequest> | null;
  let deltaMessageIds: ReadonlySet<string> | null = null;
  let latestMessageId: string | null = null;
  try {
    const caseId = `memory-v3-shadow:${userId}:${conversationId}`;
    const load = projected.loadMessages as MemoryV3DialogueShadowOptions["loadMessages"];
    if (sinceCursor === null) {
      const fitted = fitExtractorDialogueToByteCap(
        validateMemoryV3Dialogue({ caseId, messages: await load(userId, conversationId) }),
      );
      dialogue = fitted.dialogue;
      extractorRequest = fitted.request;
    } else {
      const loaded = inspectDeltaWindow(await load(userId, conversationId, sinceCursor), caseId);
      latestMessageId = loaded.latestMessageId;
      if (loaded.delta.length === 0) {
        dialogue = validateMemoryV3Dialogue({ caseId, messages: loaded.context });
        extractorRequest = null;
      } else {
        const fitted = fitDeltaWindowToByteCap(caseId, loaded.context, loaded.delta);
        dialogue = fitted.dialogue;
        extractorRequest = fitted.request;
      }
      deltaMessageIds = new Set(dialogue.messages.slice(loaded.context.length).map((message) => message.id));
    }
  } catch {
    return failed(null, "invalid_source");
  }

  let hash: string;
  try {
    hash = await inputHash(userId, conversationId, dialogue, latestMessageId);
  } catch {
    return failed(null, "unknown_failure");
  }
```

3h. Replace:

```ts
  let extractor: MemoryV3TransportResult;
  try {
    const adapter = (projected.extractorAdapterFactory as MemoryV3DialogueShadowOptions["extractorAdapterFactory"])(apiKey);
```

with:

```ts
  // Empty delta (spec 2026-10-13 §1): nothing was written after the cursor,
  // so the extractor is never called -- not even on the context block alone,
  // which a previous run already analyzed. Same succeeded no-op contract as an
  // empty extraction (§3), with no model usage at all.
  if (extractorRequest === null) {
    const noopFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
      runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
      state, changed: false,
      extraction: {
        run: { caseId: dialogue.caseId, extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION },
        items: [],
        evidence: [],
      },
      operations: [], transitions: [], extractorUsage: null, reconcilerUsage: null,
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

  let extractor: MemoryV3TransportResult;
  try {
    const adapter = (projected.extractorAdapterFactory as MemoryV3DialogueShadowOptions["extractorAdapterFactory"])(apiKey);
```

3i. Replace:

```ts
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  if (extraction.items.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
```

with:

```ts
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  // Spec 2026-10-13 §1: the context block informs the extractor but is never
  // new evidence -- the run that produced the cursor already analyzed it.
  // Citing it is the same contract violation as citing an unknown message.
  const citable = deltaMessageIds;
  if (citable !== null && extraction.evidence.some((row) => !citable.has(row.sourceMessageId))) {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  if (extraction.items.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts`

Expected: PASS, 0 failures. That includes:
- the existing first-run byte-cap test ("uses the largest recent contiguous dialogue suffix ...");
- the existing "source isolation" test (no `Deno.env`, `process.env` or `globalThis.fetch` in the runner).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
git commit -m "$(cat <<'EOF'
feat: dialogue memory reads only messages its last succeeded run hasn't seen

Before loading, the runner asks its store for this conversation's last
succeeded cursor; a first run keeps today's window, and a failed lookup
fails the run instead of risking a skip. Delta windows are byte-capped
from their newest end, so each run's cursor is the last message it
actually sent and a large backlog drains across runs with no gap. An
empty delta skips the extractor (succeeded no-op), evidence may cite
only the delta, and the input identity includes the conversation's
latest message so a failed window is retried once anything new lands.

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
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts`. Every edit is anchored on exact text; the line numbers are from before Task 6.
  - imports (lines 1-8);
  - `loadMessages` option (line 59);
  - add `fitDeltaWindowToByteCap` before `function inspectExactRecord` (line 121);
  - `ownMethod` (line 170);
  - add `projectSourceCursor` and `inspectDeltaWindow` before `function canonicalStringify` (line 181);
  - `inputHash` (lines 190-197);
  - gate, cursor lookup, load, and hash block (lines 342-365);
  - empty-delta no-op before `let extractor: MemoryV3TransportResult;` (line 430);
  - delta-only evidence check after the `extractor_contract_invalid` catch (line 471).
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`:
  - harness (lines 70-136);
  - new `describe` inserted before `describe("Memory V3 lifecycle background isolation"`.

**Interfaces:**
- Consumes:
  - `MemoryV3SourceCursor`, `MemoryV3MessageLoader`, and the `MemoryV3DeltaWindow` shape (Task 2);
  - `MemoryV3LifecycleStore.lastSucceededCursor` (Task 9);
  - `persistCompareAndSwap` and the empty-extraction fast path (Task 6).
- Produces: `MemoryV3LifecycleShadowOptions.loadMessages: MemoryV3MessageLoader`, with the same call rule as Task 8. The lookup runs only after the mode/allowlist gates and the store-method gate. The lifecycle `compareAndSwap` write has no `conversationId` field.

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
  type Message = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
  const PRIOR_MESSAGE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const OTHER_MESSAGE_ID = "99999999-9999-4999-8999-999999999999";
  const PRIOR: Message = { id: PRIOR_MESSAGE_ID, role: "assistant", text: "Привет! Как прошёл день?", createdAt: "2026-09-15T09:00:00Z" };
  const NEW: Message = { id: MESSAGE_ID, role: "user", text: "Я люблю утренние прогулки", createdAt: CREATED_AT };
  const LATER: Message = { id: OTHER_MESSAGE_ID, role: "user", text: "Сегодня снова гуляла", createdAt: "2026-09-15T11:00:00Z" };
  const PRIOR_CURSOR = { messageId: PRIOR_MESSAGE_ID, createdAt: PRIOR.createdAt };
  const NEW_CURSOR = { messageId: MESSAGE_ID, createdAt: CREATED_AT };
  const sentIds = (request: unknown) =>
    (request as { input: { messages: Array<{ id: string }> } }).input.messages.map(({ id }) => id);

  function withCursor(test: ReturnType<typeof harness>, cursor: unknown) {
    test.options.store = {
      ...test.store,
      async lastSucceededCursor(input) {
        test.calls.push("cursor");
        test.cursorInputs.push(input);
        return cursor as never;
      },
    };
    return test;
  }

  // Mirrors createMemoryV3MessageLoader's two call shapes over an in-memory
  // conversation (its real queries are covered in messages.cases.test.ts):
  // no cursor -> the last 60; a cursor -> the 5 messages ending at it, the
  // oldest 55 after it, and the newest id. Records each call's cursor, or
  // null for a two-argument call.
  function windowLoader(conversation: () => Message[], seen: unknown[]) {
    return async (_userId: string, _conversationId: string, ...cursor: unknown[]) => {
      const visible = conversation();
      if (cursor.length === 0) {
        seen.push(null);
        return visible.slice(-60);
      }
      seen.push(cursor[0]);
      const at = visible.findIndex((message) => message.id === (cursor[0] as { messageId: string }).messageId);
      return {
        context: visible.slice(Math.max(0, at - 4), at + 1),
        delta: visible.slice(at + 1, at + 56),
        latestMessageId: visible[visible.length - 1].id,
      };
    };
  }

  // Tracks every reserved run and answers lastSucceededCursor the way the
  // real query does: succeeded runs only, furthest (created_at, id) first.
  // (Migration 077's 10-new-message gate is not modeled; it is out of scope.)
  function trackingStore(seed: { messageId: string; createdAt: string } | null = null) {
    const runs: Array<{ runId: string; status: "reserved" | "succeeded" | "failed"; messageId: string; createdAt: string }> = [];
    const nextRunId = () => `eeeeeeee-eeee-4eee-8eee-${String(runs.length + 1).padStart(12, "0")}`;
    if (seed !== null) runs.push({ runId: nextRunId(), status: "succeeded", ...seed });
    const store: MemoryV3LifecycleStore = {
      async reserve(input) {
        const runId = nextRunId();
        runs.push({ runId, status: "reserved", messageId: input.sourceLastMessageId, createdAt: input.sourceLastCreatedAt });
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
      async lastSucceededCursor() {
        const best = runs
          .filter((run) => run.status === "succeeded")
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            (left.messageId < right.messageId ? 1 : left.messageId > right.messageId ? -1 : 0))[0];
        return best ? { messageId: best.messageId, createdAt: best.createdAt } : null;
      },
    };
    return { store, runs };
  }

  it("never looks up a delta cursor for disabled or non-allowlisted accounts", async () => {
    for (const overrides of [{ rawMode: "off" }, { rawMode: "lifecycle_shadow", userId: OTHER_USER_ID }]) {
      const test = harness(overrides);
      assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "skipped");
      assert.deepEqual(test.cursorInputs, []);
    }
  });

  it("loads today's first-run window, with no cursor argument at all, when no run of this conversation has succeeded", async () => {
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        loaderArgs.push(args);
        return [NEW];
      },
    });
    assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID]]);
  });

  it("reads this conversation's last succeeded cursor before loading, then loads only what follows it", async () => {
    const loaderArgs: unknown[][] = [];
    const test = withCursor(harness({
      async loadMessages(...args: unknown[]) {
        test.calls.push("messages");
        loaderArgs.push(args);
        return { context: [PRIOR], delta: [NEW], latestMessageId: MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.calls.slice(0, 3), ["cursor", "messages", "reserve"]);
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, PRIOR_CURSOR]]);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
    assert.equal((test.reserveInputs[0] as { sourceLastMessageId: string }).sourceLastMessageId, MESSAGE_ID);
  });

  it("fails the run before loading anything when the cursor lookup throws or returns garbage -- never a fallback window", async () => {
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
        const test = harness();
        test.options.store = { ...test.store, lastSucceededCursor: lookup as never };
        assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
          status: "failed", runId: null, diagnosticCode: "invalid_source",
        });
        assert.deepEqual(test.calls, []);
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

  it("never calls the extractor when nothing new arrived since the cursor, and still ends as a succeeded no-op", async () => {
    // In production migration 077's gate answers daily_cap first (0 new
    // messages); this pins the runner's own contract regardless.
    const test = withCursor(harness({
      async loadMessages() {
        test.calls.push("messages");
        return { context: [PRIOR, NEW], delta: [], latestMessageId: MESSAGE_ID };
      },
    }), NEW_CURSOR);
    const logged: unknown[] = [];
    const result = await runMemoryV3LifecycleShadow(test.options, undefined, async (input) => { logged.push(input); });
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0, transitionCount: 0, stateRevision: 0,
    });
    assert.deepEqual(test.calls, ["cursor", "messages", "reserve", "cas"]);
    const reserved = test.reserveInputs[0] as { sourceLastMessageId: string; sourceLastCreatedAt: string };
    assert.equal(reserved.sourceLastMessageId, MESSAGE_ID);
    assert.equal(reserved.sourceLastCreatedAt, CREATED_AT);
    assert.deepEqual(test.casInputs, [{
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
      extractorUsage: null,
      reconcilerUsage: null,
    }]);
    assert.deepEqual(logged, []);
    assert.deepEqual(test.failInputs, []);
  });

  it("rejects an extraction citing a leading-context message exactly like an unknown id, before the reconciler", async () => {
    // The harness extractor cites MESSAGE_ID, which is a context message here.
    const test = withCursor(harness({
      async loadMessages() {
        test.calls.push("messages");
        return { context: [PRIOR, NEW], delta: [LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), NEW_CURSOR);
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "extractor_contract_invalid",
    });
    assert.equal(test.calls.includes("reconcilerFactory"), false);
    assert.equal(test.calls.at(-1), "fail:extractor_contract_invalid");
  });

  it("sends the context and the oldest undrained message even over the byte cap, rather than skipping it", async () => {
    const HUGE: Message = { ...NEW, text: `Я люблю утренние прогулки ${"x".repeat(21_000)}` };
    const test = withCursor(harness({
      async loadMessages() {
        return { context: [PRIOR], delta: [HUGE, LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    const original = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    let status: string;
    try {
      status = (await runMemoryV3LifecycleShadow(test.options)).status;
    } finally {
      console.warn = original;
    }
    assert.equal(status, "succeeded");
    assert.deepEqual(warned, [["[memory-v3-lifecycle-delta-over-byte-cap]"]]);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
    assert.equal((test.reserveInputs[0] as { sourceLastMessageId: string }).sourceLastMessageId, MESSAGE_ID);
  });

  it("folds the conversation's latest message into a delta run's input identity, so a failed window can be retried once anything new is written", async () => {
    const hashes: string[] = [];
    for (const latestMessageId of [MESSAGE_ID, MESSAGE_ID, OTHER_MESSAGE_ID]) {
      const test = withCursor(harness({
        async loadMessages() {
          return { context: [PRIOR], delta: [NEW], latestMessageId };
        },
      }), PRIOR_CURSOR);
      assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
      hashes.push((test.reserveInputs[0] as { inputHash: string }).inputHash);
    }
    assert.equal(hashes[0], hashes[1]);
    assert.notEqual(hashes[1], hashes[2]);
  });

  it("advances the delta cursor only on succeeded runs (fail, succeed, fail, then read)", async () => {
    const conversation: Message[] = Array.from({ length: 8 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "user",
      text: `Сообщение ${index + 1}`,
      createdAt: `2026-09-15T10:0${index}:00Z`,
    }));
    const tracked = trackingStore();
    const seenCursors: unknown[] = [];
    let visible = 0;
    let extractorFails = false;
    const options = {
      ...harness().options,
      store: tracked.store,
      loadMessages: windowLoader(() => conversation.slice(0, visible), seenCursors),
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
    assert.deepEqual(tracked.runs.map((run) => run.status), ["failed", "succeeded", "failed", "succeeded"]);
    const afterRun2 = { messageId: conversation[3].id, createdAt: conversation[3].createdAt };
    assert.deepEqual(seenCursors, [null, null, afterRun2, afterRun2]);
    assert.deepEqual(tracked.runs.map((run) => run.messageId), [1, 3, 5, 7].map((index) => conversation[index].id));
  });

  it("drains a 150-message backlog oldest-first across runs: every message reaches exactly one extractor window, none skipped", async () => {
    const conversation: Message[] = Array.from({ length: 151 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `${index + 1}: ${"я".repeat(300)}`,
      createdAt: new Date(Date.UTC(2026, 8, 15, 10, 0, index)).toISOString(),
    }));
    const position = (id: string) => conversation.findIndex((message) => message.id === id);
    const tracked = trackingStore({ messageId: conversation[0].id, createdAt: conversation[0].createdAt });
    const seenCursors: unknown[] = [];
    const sent: string[][] = [];
    const options = {
      ...harness().options,
      store: tracked.store,
      loadMessages: windowLoader(() => conversation, seenCursors),
      extractorAdapterFactory: () => async (request: unknown) => {
        sent.push(sentIds(request));
        return { content: emptyExtractorContent, usage: null };
      },
    };
    const drained: string[] = [];
    for (let attempt = 1; ; attempt += 1) {
      assert.equal(attempt <= 40, true);
      const windowsBefore = sent.length;
      assert.equal((await runMemoryV3LifecycleShadow(options)).status, "succeeded");
      if (sent.length === windowsBefore) break; // the empty-delta run: no extractor call at all
      const cursorId = (seenCursors.at(-1) as { messageId: string }).messageId;
      const ids = sent[sent.length - 1];
      const contextEnd = ids.indexOf(cursorId);
      assert.equal(contextEnd >= 0 && contextEnd <= 4, true);
      const delta = ids.slice(contextEnd + 1);
      assert.equal(position(delta[0]), position(cursorId) + 1);
      drained.push(...delta);
    }
    assert.deepEqual(drained, conversation.slice(1).map(({ id }) => id));
    assert.equal(sent.length > 2, true);
    assert.equal(sent.every((ids) => ids.length < 60), true);
    assert.deepEqual(tracked.runs.slice(1, 1 + sent.length).map((run) => run.messageId), sent.map((ids) => ids[ids.length - 1]));
    assert.equal(tracked.runs[tracked.runs.length - 1].messageId, conversation[150].id);
    assert.equal(tracked.runs.every((run) => run.status === "succeeded"), true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs --test supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`

Expected: FAIL on the last ten new tests, for the same reasons as Task 8 Step 2. "never looks up a delta cursor for disabled or non-allowlisted accounts" already passes; it is a guard that must keep passing.

- [ ] **Step 3: Write the implementation**

3a. Replace lines 1-8:

```ts
import {
  MEMORY_V3_MAX_PROMPT_BYTES,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
  type MemoryV3DialogueInput,
  type MemoryV3Extraction,
} from "./contract.ts";
import type { MemoryV3DialogueMessage } from "./messages.ts";
```

with:

```ts
import {
  MEMORY_V3_MAX_PROMPT_BYTES,
  MEMORY_V3_MAX_SOURCE_MESSAGES,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
  type MemoryV3DialogueInput,
  type MemoryV3Extraction,
} from "./contract.ts";
import type {
  MemoryV3DialogueMessage,
  MemoryV3MessageLoader,
  MemoryV3SourceCursor,
} from "./messages.ts";
```

3b. Replace (inside `MemoryV3LifecycleShadowOptions`):

```ts
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
```

with:

```ts
  /** Called with two arguments for a first run (today's last-60 window), and
   * with this conversation's last succeeded cursor otherwise -- then it
   * returns a delta window (spec 2026-10-13 §1). */
  loadMessages: MemoryV3MessageLoader;
```

3c. Replace:

```ts
function inspectExactRecord(value: unknown, fields: readonly string[], code: MemoryV3LifecycleShadowDiagnostic): JsonRecord {
```

with:

```ts
type FittedExtractorDialogue = {
  dialogue: MemoryV3DialogueInput;
  request: ReturnType<typeof buildMemoryV3LifecycleExtractorRequest>;
};

// Delta mode (spec 2026-10-13 §1): the same 20 KB cap, but trimmed from the
// NEWEST end of the delta -- those messages simply open the next run, since
// the cursor only advances to the last message actually sent. (The first-run
// fit above trims the oldest end; here that would let the cursor jump past
// messages no run ever read.) Never drops the context block or the oldest
// undrained message, and stops before the window would hold no user message.
// If even that minimum is over the cap, it is sent as-is: an accepted,
// logged edge case -- never a gap.
function fitDeltaWindowToByteCap(
  caseId: string,
  context: MemoryV3DialogueMessage[],
  delta: MemoryV3DialogueMessage[],
): FittedExtractorDialogue {
  const cap = Math.min(MEMORY_V3_MAX_PROMPT_BYTES, MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES);
  let smallest: FittedExtractorDialogue | null = null;
  for (let end = delta.length; end >= 1; end -= 1) {
    const messages = [...context, ...delta.slice(0, end)];
    if (!messages.some((message) => message.role === "user")) break;
    const dialogue = validateMemoryV3Dialogue({ caseId, messages });
    const request = buildMemoryV3LifecycleExtractorRequest(dialogue);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) return { dialogue, request };
    smallest = { dialogue, request };
  }
  if (smallest === null) throw fail("invalid_source");
  console.warn("[memory-v3-lifecycle-delta-over-byte-cap]");
  return smallest;
}

function inspectExactRecord(value: unknown, fields: readonly string[], code: MemoryV3LifecycleShadowDiagnostic): JsonRecord {
```

3d. Replace:

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

3e. Replace:

```ts
function canonicalStringify(value: unknown): string {
```

with:

```ts
// The store's answer is untrusted until checked here; anything malformed
// fails the run exactly like a failed lookup.
function projectSourceCursor(value: unknown): MemoryV3SourceCursor | null {
  if (value === null) return null;
  const cursor = inspectExactRecord(value, ["messageId", "createdAt"], "invalid_source");
  if (typeof cursor.messageId !== "string" || !UUID.test(cursor.messageId) ||
      typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) {
    throw fail("invalid_source");
  }
  return { messageId: cursor.messageId, createdAt: cursor.createdAt };
}

// The loader's delta-mode answer, checked before anything trusts it. Both
// blocks are validated together (unique ids across them, at most 60 in all,
// at least one user message) and split back at the same boundary.
function inspectDeltaWindow(value: unknown, caseId: string): {
  context: MemoryV3DialogueMessage[];
  delta: MemoryV3DialogueMessage[];
  latestMessageId: string;
} {
  const window = inspectExactRecord(value, ["context", "delta", "latestMessageId"], "invalid_source");
  const context = inspectDenseArray(window.context, MEMORY_V3_MAX_SOURCE_MESSAGES, "invalid_source");
  const delta = inspectDenseArray(window.delta, MEMORY_V3_MAX_SOURCE_MESSAGES, "invalid_source");
  if (typeof window.latestMessageId !== "string" || !UUID.test(window.latestMessageId)) throw fail("invalid_source");
  const messages = validateMemoryV3Dialogue({ caseId, messages: [...context, ...delta] }).messages;
  return {
    context: messages.slice(0, context.length),
    delta: messages.slice(context.length),
    latestMessageId: window.latestMessageId,
  };
}

function canonicalStringify(value: unknown): string {
```

3f. Replace:

```ts
async function inputHash(userId: string, conversationId: string, dialogue: MemoryV3DialogueInput): Promise<string> {
  try {
    const payload = {
      pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      userId,
      conversationId,
      messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
```

with:

```ts
async function inputHash(
  userId: string,
  conversationId: string,
  dialogue: MemoryV3DialogueInput,
  latestMessageId: string | null,
): Promise<string> {
  try {
    const payload: JsonRecord = {
      pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      userId,
      conversationId,
      messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
    // Delta mode only (spec 2026-10-13 §1). A delta window need not end at the
    // conversation's newest message, so after a failed run the next run can
    // rebuild the very same window -- and the reservation's duplicate check is
    // permanent (an input hash is never released, not even by a failed run),
    // which would freeze this conversation's memory for good. Folding in the
    // newest message id keeps "duplicate" meaning what it means for a first
    // run: same input, same conversation state. A retry goes ahead as soon as
    // anything new is written. First-run hashes are unchanged.
    if (latestMessageId !== null) payload.latestMessageId = latestMessageId;
```

3g. Replace:

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
    const validated = validateMemoryV3Dialogue({ caseId: `memory-v3-shadow:${userId}:${conversationId}`, messages: source });
    const fitted = fitExtractorDialogueToByteCap(validated);
    dialogue = fitted.dialogue;
    extractorRequest = fitted.request;
  } catch {
    return failed(null, "invalid_source");
  }

  let hash: string;
  try {
    hash = await inputHash(userId, conversationId, dialogue);
  } catch {
    return failed(null, "unknown_failure");
  }
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
  // fails the run: falling back to the first-run window could move the cursor
  // past a backlog no run has read. Console-only fixed literal; the error
  // itself is never logged.
  let sinceCursor: MemoryV3SourceCursor | null;
  try {
    sinceCursor = projectSourceCursor(await lastSucceededCursor({ userId, conversationId } as never));
  } catch {
    console.error("[memory-v3-lifecycle-cursor-lookup-failed]");
    return failed(null, "invalid_source");
  }

  // extractorRequest stays null for an empty delta (nothing new to read).
  // deltaMessageIds is what this run may cite as evidence: null on a first run
  // (any loaded message), otherwise exactly the delta it sends.
  // latestMessageId feeds the input identity in delta mode only.
  let dialogue: MemoryV3DialogueInput;
  let extractorRequest: ReturnType<typeof buildMemoryV3LifecycleExtractorRequest> | null;
  let deltaMessageIds: ReadonlySet<string> | null = null;
  let latestMessageId: string | null = null;
  try {
    const caseId = `memory-v3-shadow:${userId}:${conversationId}`;
    const load = projected.loadMessages as MemoryV3LifecycleShadowOptions["loadMessages"];
    if (sinceCursor === null) {
      const fitted = fitExtractorDialogueToByteCap(
        validateMemoryV3Dialogue({ caseId, messages: await load(userId, conversationId) }),
      );
      dialogue = fitted.dialogue;
      extractorRequest = fitted.request;
    } else {
      const loaded = inspectDeltaWindow(await load(userId, conversationId, sinceCursor), caseId);
      latestMessageId = loaded.latestMessageId;
      if (loaded.delta.length === 0) {
        dialogue = validateMemoryV3Dialogue({ caseId, messages: loaded.context });
        extractorRequest = null;
      } else {
        const fitted = fitDeltaWindowToByteCap(caseId, loaded.context, loaded.delta);
        dialogue = fitted.dialogue;
        extractorRequest = fitted.request;
      }
      deltaMessageIds = new Set(dialogue.messages.slice(loaded.context.length).map((message) => message.id));
    }
  } catch {
    return failed(null, "invalid_source");
  }

  let hash: string;
  try {
    hash = await inputHash(userId, conversationId, dialogue, latestMessageId);
  } catch {
    return failed(null, "unknown_failure");
  }
```

3h. Replace:

```ts
  let extractor: MemoryV3TransportResult;
  try {
    const adapter = (projected.extractorAdapterFactory as MemoryV3LifecycleShadowOptions["extractorAdapterFactory"])(apiKey);
```

with:

```ts
  // Empty delta (spec 2026-10-13 §1): nothing was written after the cursor,
  // so the extractor is never called -- not even on the context block alone,
  // which a previous run already analyzed. Same succeeded no-op contract as an
  // empty extraction (§3), with no model usage at all.
  if (extractorRequest === null) {
    const noopFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
      runId, userId, expectedStateRevision: reserved.expectedStateRevision,
      state, changed: false,
      extraction: {
        run: { caseId: dialogue.caseId, extractorVersion: MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION },
        items: [],
        evidence: [],
      },
      operations: [], transitions: [], extractorUsage: null, reconcilerUsage: null,
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

  let extractor: MemoryV3TransportResult;
  try {
    const adapter = (projected.extractorAdapterFactory as MemoryV3LifecycleShadowOptions["extractorAdapterFactory"])(apiKey);
```

3i. Replace:

```ts
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  if (extraction.items.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
```

with:

```ts
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  // Spec 2026-10-13 §1: the context block informs the extractor but is never
  // new evidence -- the run that produced the cursor already analyzed it.
  // Citing it is the same contract violation as citing an unknown message.
  const citable = deltaMessageIds;
  if (citable !== null && extraction.evidence.some((row) => !citable.has(row.sourceMessageId))) {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  if (extraction.items.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
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
mode/allowlist gates: oldest-first delta windows byte-capped from their
newest end, an extractor-free no-op for an empty delta, delta-only
evidence, a fail-closed cursor lookup, and the latest message id in the
input identity. The reservation's 10-new-message gate (migration 077)
is untouched -- this only changes what a triggered run reads.

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

The spec's revision (`72c83af`) and this plan were committed after `640b842`, so a bare `640b842..HEAD` diff also lists the two docs files. Check code and docs separately.

Run: `git diff --stat 640b842..HEAD -- . ':(exclude)docs/superpowers'`

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

Then run: `git diff --stat 640b842..HEAD -- docs/superpowers`

Expected: exactly two paths, `docs/superpowers/specs/2026-10-13-memory-v3-extractor-reconciler-delta-design.md` and `docs/superpowers/plans/2026-10-13-memory-v3-extractor-reconciler-delta.md`.

- [ ] **Step 4: The out-of-scope files are untouched**

Run:
```bash
git diff 640b842..HEAD -- supabase/functions/staysee-chat/index.ts supabase/migrations supabase/functions/_shared/memoryV3/contract.ts supabase/functions/_shared/memoryV3/dialogueContract.ts supabase/functions/_shared/memoryV3/lifecycleContract.ts supabase/functions/_shared/memoryV3/dialogueReducer.ts supabase/functions/_shared/memoryV3/lifecycleReducer.ts supabase/functions/_shared/memoryV3/dialogueTransport.ts supabase/functions/_shared/memoryV3/lifecycleTransport.ts supabase/functions/_shared/memoryV3/shadowRunner.ts
```

Expected: no output at all. (`shadowRunner.ts` is listed because the two-argument loader call must keep serving it unchanged.)

- [ ] **Step 5: Optional Deno type check (CI does not run Deno)**

Run `deno --version`. Only if it prints a version, run `deno check supabase/functions/staysee-chat/index.ts` and confirm that no reported error points into a file from Step 3's list. This is where the `MemoryV3MessageLoader` call-shape overloads get type-checked against all three runners' `loadMessages` options. If `deno` is not installed, skip this step.
