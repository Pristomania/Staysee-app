# Memory V3 Life Dynamics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (chosen over subagent-driven-development: six sequentially-dependent tasks touching a tightly coupled pipeline, not independently parallelizable work). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Memory V3 an explicit, always-on link between a fact and whatever replaced it ("was → became"), protect a handful of sensitive such pairs from the live chat's recency-only eviction, and wire the existing (currently half-broken) weekly dynamics screen to show real linked pairs instead of a dead data source and a word-diff guess.

**Architecture:** Two parallel pipelines (dialogue = per-conversation, lifecycle = cross-conversation) each gain one new optional operation field threaded from LLM prompt → shape pre-check → contract validation → reducer state application → Postgres storage → read-context RPC → TypeScript read-side validation → frontend. A migration adds the two storage columns and extends four existing SQL functions. The frontend's weekly dynamics screen swaps a dead-table read and a crude text-diff for a real read of these pairs.

**Tech Stack:** TypeScript (Deno edge functions), PostgreSQL/PL-pgSQL (Supabase migrations), React/Vite frontend, Node/tsx + `node:test` for frontend-adjacent tests, Deno test runner (`--allow-read --allow-env`) for `supabase/functions/_shared/memoryV3/` tests.

**Spec:** `docs/superpowers/specs/2026-10-10-memory-v3-life-dynamics-design.md`

## Global Constraints

- Field names, exactly as the spec fixes them: `supersedesMemoryRef` (LLM/model-facing, a `memory:NNNN` ref), `supersedesMemoryKey` (resolved, internal), `replacesMemoryKey` / `replacedByMemoryKey` (stored item fields).
- Protected retention cap: **5** linked pairs per read-context call, additive to the existing 12-item window — not a change to the 12.
- Protection is evaluated **per pair** (an item and its direct link partner), never transitively across a chain.
- No same-kind requirement for `supersedesMemoryKey` (unlike `revise`'s `candidate.kind === target.kind`).
- No FK constraint on the two new columns — referential integrity for this pointer is enforced by the TypeScript contract layer (`validateStateInternal`'s post-pass), the same trust boundary every other item-shape invariant in this table already relies on.
- No automatic deletion of anything, anywhere, in this plan.
- No new screen, no new edge-function action — every piece reuses an existing surface (`"export"` action, `ConversationDynamicsScreen`, `weekly-reflection`).
- This is forward-only: no backfill migration for facts corrected before this ships.

## Review Focus

- A `create` whose `supersedesMemoryRef` resolves to a memory key **not** also closed by a `reject`/`mark_stale` in the same response must be rejected by contract validation, not silently stored with a dangling link (Task 1/2's post-loop check; tested in Task 1/2).
- Two different `create` operations both claiming to supersede the same target must be rejected (Task 1/2's `supersededTargets` set; tested in Task 1/2).
- An account with more than 5 eligible sensitive-linked pairs: the migration's `LIMIT 5` must drop the *oldest* pairs, never silently exceed 5 (Task 3; tested in Task 3's migration test via SQL-shape assertions, and exercised end-to-end informally since this plan has no live-DB test harness).
- The regular Память viewer (`projectMemoryV3ViewerItems`) and the per-conversation (non-cross) dynamics path must be completely unaffected by Task 5/6 — the most likely place a shared-helper change leaks into behavior nobody asked to change (tested in Task 5/6 via explicit regression assertions).
- A rejected or stale `hypothesis` must stay excluded from the weekly-dynamics data source exactly as it already is from `exportMemoryV3Data()` today — Task 6 must not accidentally "fix" this pre-existing, deliberate filter while wiring the new consumer (tested in Task 6).

---

## Task 1: Dialogue pipeline — linking field end to end

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/dialogueContract.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueReducer.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialoguePrompt.ts`
- Test: `supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts`
- Test: `supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`

**Interfaces:**
- Produces: `MemoryV3DialogueItem.replacesMemoryKey: string | null`, `.replacedByMemoryKey: string | null`; `MemoryV3DialogueProposal[number].supersedesMemoryKey: string | null`. Task 3 (migration) and Task 4 (read-store) consume these exact names.

Read every file above in full before editing (line numbers below are from today's read; re-verify before cutting a diff — do not blind-patch by line number).

- [ ] **Step 1: Write the failing contract tests**

Append to `dialogueContract.cases.test.ts` (it currently has no content you've seen this session beyond being a sibling file — read it first; if it already has a top-level `describe`, add these as new `it`s inside the existing structure using whatever minimal valid state/extraction/bindings fixture the file already builds for its other cases. If no reusable fixture exists yet, build the smallest one that satisfies `validateStateInternal`/`validateExtraction`'s requirements: two items, `event` kind, one `active` and one that a `reject` will close, one `extraction` item that creates the replacement, matching `targetMemoryRef`/`candidateRef` bindings for both):

```typescript
it("resolves supersedesMemoryRef to supersedesMemoryKey only when the target is also closed by reject/mark_stale in the same response", () => {
  // uses the two-op fixture: op A = reject targeting the old event,
  // op B = create with supersedesMemoryRef pointing at the same memoryRef op A targets
  const result = validateMemoryV3DialogueProposal(
    { operations: [rejectOp, createOpWithSupersedes] },
    { state, extraction, bindings },
  );
  const created = result.find((op) => op.type === "create")!;
  assert.equal(created.supersedesMemoryKey, oldItemMemoryKey);
});

it("rejects a create whose supersedesMemoryRef points at a memory not closed in this response", () => {
  // same fixture but WITHOUT the reject operation present
  assert.throws(() =>
    validateMemoryV3DialogueProposal(
      { operations: [createOpWithSupersedesButNoReject] },
      { state, extraction, bindings },
    ));
});

it("rejects two creates both claiming to supersede the same target", () => {
  assert.throws(() =>
    validateMemoryV3DialogueProposal(
      { operations: [rejectOp, createOpA_supersedes_old, createOpB_also_supersedes_old] },
      { state, extraction, bindings },
    ));
});

it("accepts supersedesMemoryRef even when the create's own candidate kind differs from the target's kind", () => {
  // target is a 'recurrence' item, candidate (create) is 'event' kind -- must NOT fail
  // the way revise's candidate.kind !== target.kind check would
  const result = validateMemoryV3DialogueProposal(
    { operations: [rejectOp_onRecurrence, createOp_eventKind_supersedes_recurrence] },
    { state, extraction, bindings },
  );
  assert.equal(result.find((op) => op.type === "create")!.supersedesMemoryKey, recurrenceItemMemoryKey);
});

it("rejects a non-create operation that sets supersedesMemoryRef", () => {
  const confirmWithSupersedes = { ...confirmOp }; // candidateRef targets something CURRENT via confirm
  (confirmWithSupersedes as Record<string, unknown>).supersedesMemoryRef = "memory:0001";
  assert.throws(() =>
    validateMemoryV3DialogueProposal({ operations: [confirmWithSupersedes] }, { state, extraction, bindings }));
});

it("stores replacesMemoryKey/replacedByMemoryKey on items and enforces the pair is symmetric and the old end is CLOSED", () => {
  const closedEvent = { /* ...valid event item fields..., */ status: "corrected",
    replacesMemoryKey: null, replacedByMemoryKey: "b".repeat(64) };
  const newEvent = { /* ...valid event item fields..., */ status: "active",
    replacesMemoryKey: "a".repeat(64), replacedByMemoryKey: null, memoryKey: "b".repeat(64) };
  // closedEvent.memoryKey = "a".repeat(64)
  const okState = { schemaVersion: MEMORY_V3_DIALOGUE_SCHEMA_VERSION, userId, conversationId,
    stateRevision: 0, nextMemoryOrdinal: 3, items: [closedEvent, newEvent] };
  assert.doesNotThrow(() => validateMemoryV3DialogueState(okState, userId, conversationId));

  const brokenState = { ...okState, items: [{ ...closedEvent, replacedByMemoryKey: "c".repeat(64) }, newEvent] };
  assert.throws(() => validateMemoryV3DialogueState(brokenState, userId, conversationId));

  const notClosedState = { ...okState, items: [{ ...closedEvent, status: "active" }, newEvent] };
  assert.throws(() => validateMemoryV3DialogueState(notClosedState, userId, conversationId));
});
```

(Write real, complete fixture objects for `state`/`extraction`/`bindings`/each operation — mirror the exact field shapes from `MemoryV3DialogueItem`, `MemoryV3Extraction["items"][number]`, and the binding types in `dialogueContract.ts`; every field this session's earlier reads of that file show as required must be present and valid, e.g. `memoryKey` must match `/^[0-9a-f]{64}$/`, `evidence` must be non-empty with a relation matching `STATUS_RELATION[status]`, etc.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts`
Expected: FAIL — `supersedesMemoryKey`/`replacesMemoryKey`/`replacedByMemoryKey` are not recognized fields yet, so the "accepts"/"resolves" cases throw where they shouldn't, and the fixtures referencing these fields as object literals fail TypeScript's structural checks or the `record()` field-count check at runtime.

- [ ] **Step 3: Implement the contract changes**

In `dialogueContract.ts`:

1. Add to the `MemoryV3DialogueItem` interface (after `revision: number;`, before `evidence: ...`):
```typescript
  replacesMemoryKey: string | null;
  replacedByMemoryKey: string | null;
```

2. Add to `ITEM_FIELDS` (after `"revision"`, before `"evidence"`):
```typescript
  "replacesMemoryKey", "replacedByMemoryKey",
```
(keep it a single array literal — just insert the two new strings in that position of the existing list.)

3. In `validateStateInternal`'s per-item `.map()` callback, immediately after the existing `firstSeenAt`/`updatedAt`/`revision` check block (the one ending `!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) fail(token, code);`), add:
```typescript
    if (
      (item.replacesMemoryKey !== null &&
        (typeof item.replacesMemoryKey !== "string" || !MEMORY_KEY.test(item.replacesMemoryKey) ||
          item.replacesMemoryKey === item.memoryKey)) ||
      (item.replacedByMemoryKey !== null &&
        (typeof item.replacedByMemoryKey !== "string" || !MEMORY_KEY.test(item.replacedByMemoryKey) ||
          item.replacedByMemoryKey === item.memoryKey))
    ) fail(token, code);
```

4. Immediately after the `const items = rawItems.map((raw): MemoryV3DialogueItem => { ... });` statement completes (i.e. right before the function's final `return { ... items };`), add a cross-item consistency pass:
```typescript
  const itemsByKey = new Map(items.map((item) => [item.memoryKey, item]));
  for (const item of items) {
    if (item.replacesMemoryKey !== null) {
      const partner = itemsByKey.get(item.replacesMemoryKey);
      if (
        !partner || partner.replacedByMemoryKey !== item.memoryKey ||
        !CLOSED[partner.kind].includes(partner.status)
      ) fail(token, code);
    }
    if (item.replacedByMemoryKey !== null) {
      const partner = itemsByKey.get(item.replacedByMemoryKey);
      if (!partner || partner.replacesMemoryKey !== item.memoryKey) fail(token, code);
    }
  }
```

5. Add `"supersedesMemoryRef"` to `MODEL_OPERATION_FIELDS`:
```typescript
const MODEL_OPERATION_FIELDS = ["type", "candidateRef", "targetMemoryRef", "topic", "supersedesMemoryRef"] as const;
```

6. Add `supersedesMemoryKey: string | null;` to the `MemoryV3DialogueProposal` array element type.

7. In `validateMemoryV3DialogueProposal`, before the `for (const operation of operations) {` loop, add:
```typescript
    const supersededTargets = new Set<string>();
    const pendingSupersessions: string[] = [];
```

Replace the existing `if (type === "create" || type === "ignore") { ... }` block with:
```typescript
      let supersedesMemoryKey: string | null = null;
      if (type === "create" || type === "ignore") {
        if (operation.targetMemoryRef !== null) fail(token, code);
        if (type === "ignore" && operation.supersedesMemoryRef !== null) fail(token, code);
        if (type === "create") {
          if (operation.supersedesMemoryRef !== null) {
            if (!nonEmpty(operation.supersedesMemoryRef)) fail(token, code);
            const resolved = memoryByRef.get(operation.supersedesMemoryRef as string);
            if (!resolved || supersededTargets.has(resolved)) fail(token, code);
            supersededTargets.add(resolved);
            supersedesMemoryKey = resolved;
            pendingSupersessions.push(resolved);
          }
          if (candidate.kind === "recurrence" && CURRENT.recurrence.includes(candidate.status)) {
            const observations = new Set(extraction.evidence
              .filter((row) => row.itemKey === localItemKey && row.relation === "supports" && row.supportType === "episode_observation")
              .map((row) => row.episodeKey));
            if (observations.size < (candidate.status === "active" ? 2 : 1)) fail(token, code);
          }
        }
      } else {
        if (operation.supersedesMemoryRef !== null) fail(token, code);
        if (!nonEmpty(operation.targetMemoryRef)) fail(token, code);
        targetMemoryKey = memoryByRef.get(operation.targetMemoryRef) ?? null;
        if (targetMemoryKey === null) fail(token, code);
        const earlier = targeted.get(targetMemoryKey);
        if (earlier !== undefined && (earlier !== "confirm" || type !== "confirm")) fail(token, code);
        targeted.set(targetMemoryKey, type);
        const target = targetByKey.get(targetMemoryKey)!;
        if (!CURRENT[target.kind].includes(target.status) || candidate.kind !== target.kind) fail(token, code);
        if (type === "confirm" && !CURRENT[candidate.kind].includes(candidate.status)) fail(token, code);
        if (type === "revise" && (candidate.status === "stale" || candidate.status === "rejected")) fail(token, code);
        if (type === "mark_stale" && ((target.kind !== "recurrence" && target.kind !== "hypothesis") ||
            candidate.status !== "stale" || !extraction.evidence.some((row) =>
              row.itemKey === localItemKey && row.relation === "contradicts"))) fail(token, code);
        if (type === "reject" && (candidate.status !== "rejected" || !extraction.evidence.some((row) =>
          row.itemKey === localItemKey && row.relation === "rejects"))) fail(token, code);
      }
      translated.push({ type, candidateLocalItemKey: localItemKey, targetMemoryKey, topic, supersedesMemoryKey });
```
(Note: `targetMemoryKey` is still declared via `let targetMemoryKey: string | null = null;` exactly as today, immediately above this block — unchanged.)

8. After the `for` loop, before `if (consumed.size !== candidateByKey.size) fail(token, code);`, add:
```typescript
    for (const key of pendingSupersessions) {
      const closingType = targeted.get(key);
      if (closingType !== "reject" && closingType !== "mark_stale") fail(token, code);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts`
Expected: PASS, all cases including the pre-existing ones (no regressions).

- [ ] **Step 5: Write the failing reducer tests**

Append to `dialogueReducer.cases.test.ts` (read it first for its existing fixture style and import list):

```typescript
it("stamps replacesMemoryKey on the new item and replacedByMemoryKey on the old one when a create supersedes a reject target in the same step", async () => {
  // proposal = [reject op targeting oldKey, create op with supersedesMemoryKey: oldKey]
  const result = await applyMemoryV3DialogueStep({
    state: stateWithOneActiveEvent, at, conversationId, extraction, proposal, trustedForgetMemoryKeys: [],
  });
  const closed = result.state.items.find((i) => i.memoryKey === oldKey)!;
  const created = result.state.items.find((i) => i.status === "active" && i.replacesMemoryKey === oldKey)!;
  assert.equal(closed.replacedByMemoryKey, created.memoryKey);
  assert.equal(created.replacesMemoryKey, oldKey);
});

it("leaves replacesMemoryKey/replacedByMemoryKey null on an ordinary create with no supersedesMemoryKey, matching today's output exactly", async () => {
  const result = await applyMemoryV3DialogueStep({
    state: emptyState, at, conversationId, extraction: ordinaryExtraction, proposal: ordinaryCreateProposal,
    trustedForgetMemoryKeys: [],
  });
  const created = result.state.items[0];
  assert.equal(created.replacesMemoryKey, null);
  assert.equal(created.replacedByMemoryKey, null);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`
Expected: FAIL — the reducer doesn't read/write these fields yet, items come back without them (or `undefined`, failing the equality assertions), and `INTERNAL_OPERATION_FIELDS` rejects the new proposal shape outright.

- [ ] **Step 7: Implement the reducer changes**

In `dialogueReducer.ts`:

1. Add `"supersedesMemoryKey"` to `INTERNAL_OPERATION_FIELDS`:
```typescript
const INTERNAL_OPERATION_FIELDS = ["type", "candidateLocalItemKey", "targetMemoryKey", "topic", "supersedesMemoryKey"] as const;
```

2. In `validateInternalProposal`'s `cloned.map((raw) => { ... })`, replace the body with:
```typescript
    const row = inspectRecord(token, raw, INTERNAL_OPERATION_FIELDS);
    if (!OPERATION_TYPES.includes(row.type as MemoryV3DialogueOperationType) ||
        typeof row.candidateLocalItemKey !== "string" || !candidateRefByKey.has(row.candidateLocalItemKey) ||
        (row.targetMemoryKey !== null &&
          (typeof row.targetMemoryKey !== "string" || !MEMORY_KEY.test(row.targetMemoryKey) ||
            !memoryRefByKey.has(row.targetMemoryKey))) ||
        (row.supersedesMemoryKey !== null &&
          (typeof row.supersedesMemoryKey !== "string" || !MEMORY_KEY.test(row.supersedesMemoryKey) ||
            !memoryRefByKey.has(row.supersedesMemoryKey))) ||
        (row.topic !== null && typeof row.topic !== "string")) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    const candidateLocalItemKey = row.candidateLocalItemKey as string;
    const targetMemoryKey = row.targetMemoryKey as string | null;
    const supersedesMemoryKey = row.supersedesMemoryKey as string | null;
    return {
      type: row.type,
      candidateRef: candidateRefByKey.get(candidateLocalItemKey),
      targetMemoryRef: targetMemoryKey === null ? null : memoryRefByKey.get(targetMemoryKey),
      topic: row.topic as string | null,
      supersedesMemoryRef: supersedesMemoryKey === null ? null : memoryRefByKey.get(supersedesMemoryKey),
    };
```

3. In `applyMemoryV3DialogueStep`, right before `for (const operation of proposal) {`, add:
```typescript
    const replacementMap = new Map<string, string>();
```

4. In the `if (operation.type === "create") { ... }` branch, replace the `working.items.push({...})` call with:
```typescript
        if (operation.supersedesMemoryKey !== null) {
          replacementMap.set(operation.supersedesMemoryKey, resultingMemoryKey);
        }
        working.items.push({
          memoryKey: resultingMemoryKey,
          ...materialFromCandidate(candidate),
          topic: operation.topic,
          firstSeenAt: projected.at,
          updatedAt: projected.at,
          revision: 1,
          replacesMemoryKey: operation.supersedesMemoryKey,
          replacedByMemoryKey: null,
          evidence: incomingEvidence,
        } as MemoryV3DialogueItem);
```

5. In the final `else` branch (mark_stale/reject application), replace:
```typescript
        } else {
          working.items[index] = {
            ...target,
            status: candidate.status,
            updatedAt: projected.at,
            revision: target.revision + 1,
            evidence,
          };
        }
```
with:
```typescript
        } else {
          working.items[index] = {
            ...target,
            status: candidate.status,
            updatedAt: projected.at,
            revision: target.revision + 1,
            replacedByMemoryKey: replacementMap.get(target.memoryKey) ?? null,
            evidence,
          };
        }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`
Expected: PASS, all cases.

- [ ] **Step 9: Update the shadow-runner shape pre-check**

In `dialogueShadowRunner.ts`, find the `inspectExactRecord(operation, ["type", "candidateRef", "targetMemoryRef", "topic"], "reconciler_shape_invalid")` call (inside the `for (const operation of inspectDenseArray(...))` loop, right before `proposal = validateMemoryV3DialogueProposal(...)`). Change the field list to:
```typescript
      inspectExactRecord(
        operation,
        ["type", "candidateRef", "targetMemoryRef", "topic", "supersedesMemoryRef"],
        "reconciler_shape_invalid",
      );
```
This has no dedicated unit test in this task (the file's own existing test suite, if any, is not part of this plan's scope beyond this one line) — it is covered end-to-end by the fact that Step 1-8's fixtures already exercise `validateMemoryV3DialogueProposal` with the 5-field shape; a stale 4-field pre-check here would only matter once real LLM output flows through, which Task 1 cannot exercise without a live model call. **Review Focus**: if this line is missed, every real reconciler run fails shape validation the instant the prompt (Step 10) starts asking the model for `supersedesMemoryRef` — there is no automated test that would catch that omission in this plan, so double-check this edit by hand before moving on.

- [ ] **Step 10: Update the reconciler prompt**

In `dialoguePrompt.ts`, in `MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION`:

Replace line 18 (the JSON shape template):
```
{"operations":[{"type":"create|confirm|revise|mark_stale|reject|ignore","candidateRef":"candidate:0001","targetMemoryRef":"memory:0001 or null","topic":"person|fact|preference or null","supersedesMemoryRef":"memory:0001 or null"}]}
```

Replace line 21:
```
Every operation has exactly five keys: "type", "candidateRef", "targetMemoryRef", "topic", and "supersedesMemoryRef".
```

Add a new rule at the end of the numbered list (after rule 30, before the blank line and `If candidates is empty...`), numbered 31:
```
31. create may optionally include a non-null supersedesMemoryRef naming the existing memory this same response is also closing via reject or mark_stale. Always include it when this candidate is the direct replacement for a memory being closed in this response, even if the change seems minor -- this is a mechanical habit, not a judgment call about significance. Leave it null when no such replacement applies. A non-null supersedesMemoryRef must reference a memory also targeted by a reject or mark_stale operation in this same response; it does not need to share its candidate's kind. Every operation other than create must have supersedesMemoryRef null.
```

(Do not renumber rules 1-30 — append as 31 to avoid touching 20 lines of unrelated, already-tested prose.)

- [ ] **Step 11: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueContract.ts supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts supabase/functions/_shared/memoryV3/dialogueReducer.ts supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialoguePrompt.ts
git commit -m "feat: add was->became linking to Memory V3 dialogue pipeline"
```

---

## Task 2: Lifecycle pipeline — mirror of Task 1

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleContract.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReducer.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts`

**Interfaces:**
- Produces: `MemoryV3LifecycleItem.replacesMemoryKey`/`.replacedByMemoryKey`, `MemoryV3LifecycleProposal[number].supersedesMemoryKey` — same names and types as Task 1's dialogue side. Task 3/4 consume both sides identically.

Repeat every step of Task 1 against the lifecycle-side files, substituting:
- `MemoryV3Dialogue*` → `MemoryV3Lifecycle*` type/function names throughout.
- `dialogue_contract_invalid_*` / `dialogue_reducer_invalid_*` → `lifecycle_contract_invalid_*` / `lifecycle_reducer_invalid_*` diagnostic codes.
- `lifecyclePrompt.ts`'s topic enum in the JSON template is `life_context|communication|preference`, not `person|fact|preference` — do not copy the dialogue wording verbatim, keep each file's own existing topic list.
- The lifecycle contract/reducer have no `conversationId` — do not introduce one; the post-pass consistency check and all new validation logic in Task 1 never referenced `conversationId`, so nothing here needs it either.

Before writing, open both `lifecycleContract.ts` and `dialogueContract.ts` (and the two reducers, two shadow runners, two prompts) side by side and confirm line-for-line parity still holds at the exact spots Task 1 touched — today's read of both found them byte-identical apart from naming, but re-verify rather than trust that blindly here, since a drift would mean copying Task 1's line-numbered instructions onto the wrong lines.

- [ ] **Step 1: Write the failing contract tests** (mirror Task 1 Step 1, against `lifecycleContract.cases.test.ts`, using `validateMemoryV3LifecycleProposal`/`validateMemoryV3LifecycleState` and a lifecycle-shaped fixture with no `conversationId`)
- [ ] **Step 2: Run tests to verify they fail** — `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts`
- [ ] **Step 3: Implement the contract changes** (mirror Task 1 Step 3 exactly, in `lifecycleContract.ts`)
- [ ] **Step 4: Run tests to verify they pass** — same command as Step 2, expect PASS
- [ ] **Step 5: Write the failing reducer tests** (mirror Task 1 Step 5, against `lifecycleReducer.cases.test.ts` and `applyMemoryV3LifecycleStep`)
- [ ] **Step 6: Run tests to verify they fail** — `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts`
- [ ] **Step 7: Implement the reducer changes** (mirror Task 1 Step 7 exactly, in `lifecycleReducer.ts`)
- [ ] **Step 8: Run tests to verify they pass** — same command as Step 6, expect PASS
- [ ] **Step 9: Update `lifecycleShadowRunner.ts`'s shape pre-check** — same field-list edit as Task 1 Step 9, at its `inspectExactRecord(operation, ["type", "candidateRef", "targetMemoryRef", "topic"], ...)` call (confirmed today at line ~542).
- [ ] **Step 10: Update `lifecyclePrompt.ts`** — same three edits as Task 1 Step 10, preserving this file's own `life_context|communication|preference` topic wording everywhere it already appears.
- [ ] **Step 11: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleContract.ts supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReducer.ts supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
git commit -m "feat: add was->became linking to Memory V3 lifecycle pipeline"
```

---

## Task 3: Migration — storage columns, write-path, and protected read-context selection

**Files:**
- Create: `supabase/migrations/20261010100000_073_memory_v3_life_dynamics_linking.sql`
- Create: `supabase/functions/_shared/memoryV3/lifeDynamicsLinkingMigration.cases.test.ts`

**Interfaces:**
- Consumes: `replacesMemoryKey`/`replacedByMemoryKey` as produced by Task 1/2's reducers (camelCase in the JSON state blob `apply_memory_v3_*_state` receives).
- Produces: `replaces_memory_key`/`replaced_by_memory_key` columns on both item tables; `load_memory_v3_dialogue_read_context`/`load_memory_v3_lifecycle_read_context` now also return `replacesMemoryKey`/`replacedByMemoryKey` per item and include up to 5 additional protected pairs. Task 4 consumes this exact return shape.

- [ ] **Step 1: Write the failing migration test**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "migrations", "20261010100000_073_memory_v3_life_dynamics_linking.sql"),
  "utf8",
);

describe("Memory V3 life-dynamics linking migration", () => {
  it("adds replaces_memory_key and replaced_by_memory_key to both item tables, nullable, no FK", () => {
    assert.match(sql, /ALTER TABLE public\.memory_v3_dialogue_items\s+ADD COLUMN replaces_memory_key text,\s*\n\s*ADD COLUMN replaced_by_memory_key text;/);
    assert.match(sql, /ALTER TABLE public\.memory_v3_lifecycle_shadow_items\s+ADD COLUMN replaces_memory_key text,\s*\n\s*ADD COLUMN replaced_by_memory_key text;/);
  });

  it("round-trips both new fields through apply_memory_v3_dialogue_state's reconstruction and insert", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state"));
    assert.match(body, /'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key/);
    assert.match(body, /INSERT INTO public\.memory_v3_dialogue_items\(\s*\n\s*user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*\n\s*alternative, topic, first_seen_at, updated_at, revision, replaces_memory_key, replaced_by_memory_key\)/);
    assert.match(body, /item->>'replacesMemoryKey', item->>'replacedByMemoryKey'/);
  });

  it("round-trips both new fields through apply_memory_v3_lifecycle_shadow_state's reconstruction and insert", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_memory_v3_lifecycle_shadow_state"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state"),
    );
    assert.match(body, /'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key/);
    assert.match(body, /INSERT INTO public\.memory_v3_lifecycle_shadow_items\(\s*\n\s*user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*\n\s*alternative, topic, first_seen_at, updated_at, revision, replaces_memory_key, replaced_by_memory_key\)/);
    assert.match(body, /item->>'replacesMemoryKey', item->>'replacedByMemoryKey'/);
  });

  it("load_memory_v3_dialogue_read_context still LIMITs the plain recency window to 12 and adds a 5-pair protected selection", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context"));
    assert.match(body, /LIMIT 12/);
    assert.match(body, /LIMIT 5/);
    assert.match(body, /'replacesMemoryKey', selected\.replaces_memory_key, 'replacedByMemoryKey', selected\.replaced_by_memory_key/);
  });

  it("load_memory_v3_lifecycle_read_context still LIMITs the plain recency window to 12 and adds a 5-pair protected selection", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_read_context"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context"),
    );
    assert.match(body, /LIMIT 12/);
    assert.match(body, /LIMIT 5/);
  });

  it("never touches the viewer or export RPCs", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_viewer_items/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_viewer_items/.test(sql), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/lifeDynamicsLinkingMigration.cases.test.ts`
Expected: FAIL (file does not exist yet — "No such file or directory" for the `readFileSync` call).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261010100000_073_memory_v3_life_dynamics_linking.sql`:

```sql
-- Adds the explicit "was -> became" link between a Memory V3 item and
-- whatever replaced it (see docs/superpowers/specs/2026-10-10-memory-v3-life-dynamics-design.md).
-- No FK constraint on the new columns: referential integrity for this
-- pointer is enforced by the TypeScript contract layer
-- (dialogueContract.ts/lifecycleContract.ts's validateStateInternal post-pass)
-- before state ever reaches these functions -- the same trust boundary
-- every other item-shape invariant in these tables already relies on.
-- A composite self-referencing FK would also be awkward here: both
-- apply_* functions below replace a user's entire item set in one
-- DELETE+INSERT per write, and row-insert order within that INSERT is
-- not guaranteed to put an old end before the new end that references it.

ALTER TABLE public.memory_v3_dialogue_items
  ADD COLUMN replaces_memory_key text,
  ADD COLUMN replaced_by_memory_key text;

ALTER TABLE public.memory_v3_lifecycle_shadow_items
  ADD COLUMN replaces_memory_key text,
  ADD COLUMN replaced_by_memory_key text;

CREATE OR REPLACE FUNCTION public.apply_memory_v3_lifecycle_shadow_state(
  p_run_id uuid, p_user_id uuid, p_expected_state_revision bigint,
  p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb,
  p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_head public.memory_v3_lifecycle_shadow_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_transition_count integer;
  v_locked_run_id uuid;
  v_run_conversation_id uuid;
  v_current_items jsonb;
  v_current_state jsonb;
  v_actual_changed boolean;
  v_resulting_state_revision bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(p_state) <> 'object'
    OR p_state->>'schemaVersion' <> 'memory-v3-lifecycle-state-v1'
    OR p_state->>'userId' <> p_user_id::text
    OR pg_catalog.jsonb_typeof(p_state->'items') <> 'array'
    OR pg_catalog.jsonb_array_length(p_state->'items') > 100 THEN
    RAISE EXCEPTION 'invalid lifecycle state';
  END IF;
  SELECT COALESCE(pg_catalog.sum(pg_catalog.jsonb_array_length(item->'evidence')), 0)::integer
    INTO v_evidence_count FROM pg_catalog.jsonb_array_elements(p_state->'items') item;
  IF v_evidence_count > 500 THEN RAISE EXCEPTION 'invalid lifecycle state'; END IF;
  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF pg_catalog.jsonb_typeof(p_extraction) <> 'object' OR pg_catalog.jsonb_typeof(p_operations) <> 'array'
    OR pg_catalog.jsonb_typeof(p_transitions) <> 'array' THEN RAISE EXCEPTION 'invalid lifecycle audit'; END IF;
  v_transition_count := pg_catalog.jsonb_array_length(p_transitions);

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = (evidence->>'conversationId')::uuid
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid lifecycle evidence ownership' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_head FROM public.memory_v3_lifecycle_shadow_heads
  WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle head is missing'; END IF;
  SELECT id, conversation_id INTO v_locked_run_id, v_run_conversation_id
    FROM public.memory_v3_lifecycle_shadow_runs
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved'
      AND expected_state_revision = p_expected_state_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run is not reservable'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_extraction->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = v_run_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid lifecycle extraction ownership' USING ERRCODE = '42501'; END IF;
  IF v_head.state_revision <> p_expected_state_revision THEN
    UPDATE public.memory_v3_lifecycle_shadow_runs SET
      status = 'failed', diagnostic_code = 'state_conflict', completed_at = pg_catalog.now()
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
      'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
      'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
      'replacesMemoryKey', i.replaces_memory_key, 'replacedByMemoryKey', i.replaced_by_memory_key,
      'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
        'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
        'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
        ORDER BY e.conversation_id, e.source_message_id, e.relation COLLATE "C")
        FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key), '[]'::jsonb)
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_current_items
  FROM public.memory_v3_lifecycle_shadow_items i WHERE i.user_id = p_user_id;
  v_current_state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_current_items);
  v_actual_changed := (p_state - 'stateRevision') IS DISTINCT FROM (v_current_state - 'stateRevision');
  IF p_changed IS DISTINCT FROM v_actual_changed THEN
    RAISE EXCEPTION 'invalid lifecycle changed flag';
  END IF;
  v_resulting_state_revision := p_expected_state_revision
    + CASE WHEN v_actual_changed THEN 1 ELSE 0 END;
  IF (p_state->>'stateRevision')::bigint <> v_resulting_state_revision THEN
    RAISE EXCEPTION 'invalid lifecycle revision';
  END IF;

  IF v_actual_changed THEN
    DELETE FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id;
    INSERT INTO public.memory_v3_lifecycle_shadow_items(
      user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,
      alternative, topic, first_seen_at, updated_at, revision, replaces_memory_key, replaced_by_memory_key)
    SELECT p_user_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
      item->>'topic',
      (item->>'firstSeenAt')::timestamptz, (item->>'updatedAt')::timestamptz, (item->>'revision')::bigint,
      item->>'replacesMemoryKey', item->>'replacedByMemoryKey'
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item;

    INSERT INTO public.memory_v3_lifecycle_shadow_evidence(
      user_id, memory_key, conversation_id, source_message_id, relation, support_type,
      episode_key, provenance_role, mention_time)
    SELECT p_user_id, item->>'memoryKey', (evidence->>'conversationId')::uuid,
      (evidence->>'sourceMessageId')::uuid, evidence->>'relation', evidence->>'supportType',
      evidence->>'episodeKey', evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence;

    UPDATE public.memory_v3_lifecycle_shadow_heads SET
      state_revision = state_revision + 1,
      next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
      updated_at = pg_catalog.now()
    WHERE user_id = p_user_id;
  END IF;
  resulting_state_revision := v_resulting_state_revision;
  UPDATE public.memory_v3_lifecycle_shadow_runs SET
    status = 'succeeded',
    resulting_state_revision = v_resulting_state_revision,
    extraction = p_extraction, operations = p_operations, transitions = p_transitions,
    item_count = v_item_count, evidence_count = v_evidence_count, transition_count = v_transition_count,
    extractor_prompt_tokens = (p_extractor_usage->>'promptTokens')::integer,
    extractor_completion_tokens = (p_extractor_usage->>'completionTokens')::integer,
    extractor_cost_usd = (p_extractor_usage->>'costUsd')::numeric,
    reconciler_prompt_tokens = (p_reconciler_usage->>'promptTokens')::integer,
    reconciler_completion_tokens = (p_reconciler_usage->>'completionTokens')::integer,
    reconciler_cost_usd = (p_reconciler_usage->>'costUsd')::numeric,
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run completion failed'; END IF;
  result := 'succeeded'; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state(
  p_run_id uuid, p_user_id uuid, p_conversation_id uuid, p_expected_state_revision bigint,
  p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb,
  p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_transition_count integer;
  v_locked_run_id uuid;
  v_current_items jsonb;
  v_current_state jsonb;
  v_actual_changed boolean;
  v_resulting_state_revision bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(p_state) <> 'object'
    OR p_state->>'schemaVersion' <> 'memory-v3-dialogue-state-v1'
    OR p_state->>'userId' <> p_user_id::text
    OR p_state->>'conversationId' <> p_conversation_id::text
    OR pg_catalog.jsonb_typeof(p_state->'items') <> 'array'
    OR pg_catalog.jsonb_array_length(p_state->'items') > 100 THEN
    RAISE EXCEPTION 'invalid dialogue state';
  END IF;
  SELECT COALESCE(pg_catalog.sum(pg_catalog.jsonb_array_length(item->'evidence')), 0)::integer
    INTO v_evidence_count FROM pg_catalog.jsonb_array_elements(p_state->'items') item;
  IF v_evidence_count > 500 THEN RAISE EXCEPTION 'invalid dialogue state'; END IF;
  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF pg_catalog.jsonb_typeof(p_extraction) <> 'object' OR pg_catalog.jsonb_typeof(p_operations) <> 'array'
    OR pg_catalog.jsonb_typeof(p_transitions) <> 'array' THEN RAISE EXCEPTION 'invalid dialogue audit'; END IF;
  v_transition_count := pg_catalog.jsonb_array_length(p_transitions);

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid dialogue evidence ownership' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue head is missing'; END IF;

  SELECT id INTO v_locked_run_id
    FROM public.memory_v3_dialogue_runs
    WHERE id = p_run_id AND user_id = p_user_id AND conversation_id = p_conversation_id AND status = 'reserved'
      AND expected_state_revision = p_expected_state_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_extraction->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid dialogue extraction ownership' USING ERRCODE = '42501'; END IF;

  IF v_head.state_revision <> p_expected_state_revision THEN
    UPDATE public.memory_v3_dialogue_runs SET
      status = 'failed', diagnostic_code = 'state_conflict', completed_at = pg_catalog.now()
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
      'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
      'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
      'replacesMemoryKey', i.replaces_memory_key, 'replacedByMemoryKey', i.replaced_by_memory_key,
      'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
        'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
        'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
        ORDER BY e.source_message_id, e.relation COLLATE "C")
        FROM public.memory_v3_dialogue_evidence e
        WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id AND e.memory_key = i.memory_key),
        '[]'::jsonb)
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_current_items
  FROM public.memory_v3_dialogue_items i WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
  v_current_state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id, 'conversationId', v_head.conversation_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_current_items);
  v_actual_changed := (p_state - 'stateRevision') IS DISTINCT FROM (v_current_state - 'stateRevision');
  IF p_changed IS DISTINCT FROM v_actual_changed THEN
    RAISE EXCEPTION 'invalid dialogue changed flag';
  END IF;
  v_resulting_state_revision := p_expected_state_revision + CASE WHEN v_actual_changed THEN 1 ELSE 0 END;
  IF (p_state->>'stateRevision')::bigint <> v_resulting_state_revision THEN
    RAISE EXCEPTION 'invalid dialogue revision';
  END IF;

  IF v_actual_changed THEN
    DELETE FROM public.memory_v3_dialogue_items WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
    INSERT INTO public.memory_v3_dialogue_items(
      user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,
      alternative, topic, first_seen_at, updated_at, revision, replaces_memory_key, replaced_by_memory_key)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
      item->>'topic',
      (item->>'firstSeenAt')::timestamptz, (item->>'updatedAt')::timestamptz, (item->>'revision')::bigint,
      item->>'replacesMemoryKey', item->>'replacedByMemoryKey'
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item;

    INSERT INTO public.memory_v3_dialogue_evidence(
      user_id, conversation_id, memory_key, source_message_id, relation, support_type,
      episode_key, provenance_role, mention_time)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey',
      (evidence->>'sourceMessageId')::uuid, evidence->>'relation', evidence->>'supportType',
      evidence->>'episodeKey', evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence;

    UPDATE public.memory_v3_dialogue_heads SET
      state_revision = state_revision + 1,
      next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
      updated_at = pg_catalog.now()
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
  END IF;
  resulting_state_revision := v_resulting_state_revision;
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'succeeded',
    resulting_state_revision = v_resulting_state_revision,
    extraction = p_extraction, operations = p_operations, transitions = p_transitions,
    item_count = v_item_count, evidence_count = v_evidence_count, transition_count = v_transition_count,
    extractor_prompt_tokens = (p_extractor_usage->>'promptTokens')::integer,
    extractor_completion_tokens = (p_extractor_usage->>'completionTokens')::integer,
    extractor_cost_usd = (p_extractor_usage->>'costUsd')::numeric,
    reconciler_prompt_tokens = (p_reconciler_usage->>'promptTokens')::integer,
    reconciler_completion_tokens = (p_reconciler_usage->>'completionTokens')::integer,
    reconciler_cost_usd = (p_reconciler_usage->>'costUsd')::numeric,
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run completion failed'; END IF;
  result := 'succeeded'; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_read_context(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-lifecycle-read-context-v1',
    'stateRevision', h.state_revision,
    'items', COALESCE(projected.items, '[]'::jsonb)
  )
  FROM public.memory_v3_lifecycle_shadow_heads AS h
  LEFT JOIN LATERAL (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', selected.kind,
        'claim', selected.claim,
        'status', selected.status,
        'sensitivity', selected.sensitivity,
        'eventTimeStart', selected.event_time_start,
        'eventTimeEnd', selected.event_time_end,
        'alternative', selected.alternative,
        'updatedAt', selected.updated_at,
        'replacesMemoryKey', selected.replaces_memory_key,
        'replacedByMemoryKey', selected.replaced_by_memory_key
      )
      ORDER BY selected.updated_at DESC, selected.memory_key COLLATE "C"
    ) AS items
    FROM (
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_lifecycle_shadow_items AS i
        WHERE i.user_id = p_user_id
          AND (
            (i.kind = 'event' AND i.status = 'active')
            OR (i.kind = 'recurrence' AND i.status = 'active')
            OR (i.kind = 'hypothesis' AND i.status = 'supported')
          )
        ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
        LIMIT 12
      )
      UNION
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_lifecycle_shadow_items AS i
        JOIN (
          SELECT new_item.memory_key AS new_key, new_item.replaces_memory_key AS old_key
          FROM public.memory_v3_lifecycle_shadow_items AS new_item
          JOIN public.memory_v3_lifecycle_shadow_items AS old_item
            ON old_item.user_id = p_user_id AND old_item.memory_key = new_item.replaces_memory_key
          WHERE new_item.user_id = p_user_id AND new_item.replaces_memory_key IS NOT NULL
            AND (new_item.sensitivity = 'sensitive' OR old_item.sensitivity = 'sensitive')
          ORDER BY new_item.updated_at DESC
          LIMIT 5
        ) AS protected_pair
          ON i.memory_key IN (protected_pair.new_key, protected_pair.old_key)
        WHERE i.user_id = p_user_id
      )
    ) AS selected
  ) AS projected ON true
  WHERE h.user_id = p_user_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_lifecycle_read_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_lifecycle_read_context(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-dialogue-read-context-v1',
    'stateRevision', h.state_revision,
    'items', COALESCE(projected.items, '[]'::jsonb)
  )
  FROM public.memory_v3_dialogue_heads AS h
  LEFT JOIN LATERAL (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', selected.kind,
        'claim', selected.claim,
        'status', selected.status,
        'sensitivity', selected.sensitivity,
        'eventTimeStart', selected.event_time_start,
        'eventTimeEnd', selected.event_time_end,
        'alternative', selected.alternative,
        'updatedAt', selected.updated_at,
        'replacesMemoryKey', selected.replaces_memory_key,
        'replacedByMemoryKey', selected.replaced_by_memory_key
      )
      ORDER BY selected.updated_at DESC, selected.memory_key COLLATE "C"
    ) AS items
    FROM (
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_dialogue_items AS i
        WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id
          AND (
            (i.kind = 'event' AND i.status = 'active')
            OR (i.kind = 'recurrence' AND i.status = 'active')
            OR (i.kind = 'hypothesis' AND i.status = 'supported')
          )
        ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
        LIMIT 12
      )
      UNION
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_dialogue_items AS i
        JOIN (
          SELECT new_item.memory_key AS new_key, new_item.replaces_memory_key AS old_key
          FROM public.memory_v3_dialogue_items AS new_item
          JOIN public.memory_v3_dialogue_items AS old_item
            ON old_item.user_id = p_user_id AND old_item.conversation_id = p_conversation_id
            AND old_item.memory_key = new_item.replaces_memory_key
          WHERE new_item.user_id = p_user_id AND new_item.conversation_id = p_conversation_id
            AND new_item.replaces_memory_key IS NOT NULL
            AND (new_item.sensitivity = 'sensitive' OR old_item.sensitivity = 'sensitive')
          ORDER BY new_item.updated_at DESC
          LIMIT 5
        ) AS protected_pair
          ON i.memory_key IN (protected_pair.new_key, protected_pair.old_key)
        WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id
      )
    ) AS selected
  ) AS projected ON true
  WHERE h.user_id = p_user_id AND h.conversation_id = p_conversation_id;
$function$;
```

(The `UNION` between the two inner selects de-duplicates automatically — the same `(memory_key, ...)` row produced by both branches collapses to one, which is correct: an item that's already in the top-12 by recency and also happens to be part of a protected pair should appear once, not twice.)

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/lifeDynamicsLinkingMigration.cases.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Apply the migration to the local/linked project and verify no SQL error**

Run: `npx supabase db push --linked` (or the project's established local-first workflow if one is in use — check `supabase/config.toml` / recent commit history for which this repo actually uses before running against production; if in doubt, surface this to Настя before pushing to the live database, per this session's established pattern of confirming before any direct production write).
Expected: migration applies cleanly, no error. If `db push` reports a conflict or is blocked (this session saw an inconsistent `[Blind Apply]` block earlier today), stop and report rather than retrying blindly.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261010100000_073_memory_v3_life_dynamics_linking.sql supabase/functions/_shared/memoryV3/lifeDynamicsLinkingMigration.cases.test.ts
git commit -m "feat: add Memory V3 life-dynamics linking migration"
```

---

## Task 4: Read-store validators — accept the narrow CLOSED-status exception

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/dialogueReadStore.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadStore.ts`
- Test: `supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts`

**Interfaces:**
- Consumes: the `replacesMemoryKey`/`replacedByMemoryKey` fields Task 3's RPCs now include in every returned item.
- Produces: `MemoryV3DialogueReadContext`/`MemoryV3LifecycleReadContext`'s item type gains `replacesMemoryKey: string | null` and `replacedByMemoryKey: string | null`; `projectMemoryV3DialogueReadContext`/`projectMemoryV3LifecycleReadContext` accept a CLOSED status only when one of these is non-null.

- [ ] **Step 1: Write the failing tests**

Append to `dialogueReadStore.cases.test.ts`:

```typescript
it("accepts an event/recurrence item in a CLOSED status when it carries replacedByMemoryKey (the old end of a linked pair)", () => {
  const closedLinkedItem = {
    kind: "event", claim: "boa", status: "corrected", sensitivity: "normal",
    eventTimeStart: null, eventTimeEnd: null, alternative: null,
    updatedAt: "2026-01-01T00:00:00Z",
    replacesMemoryKey: null, replacedByMemoryKey: "a".repeat(64),
  };
  const value = {
    schemaVersion: MEMORY_V3_DIALOGUE_READ_SCHEMA_VERSION, stateRevision: 0,
    items: [closedLinkedItem],
  };
  assert.doesNotThrow(() => projectMemoryV3DialogueReadContext(value));
});

it("still rejects a bare CLOSED item with no link pointer, exactly as before", () => {
  const bareClosedItem = {
    kind: "event", claim: "boa", status: "corrected", sensitivity: "normal",
    eventTimeStart: null, eventTimeEnd: null, alternative: null,
    updatedAt: "2026-01-01T00:00:00Z",
    replacesMemoryKey: null, replacedByMemoryKey: null,
  };
  const value = {
    schemaVersion: MEMORY_V3_DIALOGUE_READ_SCHEMA_VERSION, stateRevision: 0,
    items: [bareClosedItem],
  };
  assert.throws(() => projectMemoryV3DialogueReadContext(value));
});

it("keeps today's output for an ordinary active item with both link fields null", () => {
  const ordinary = {
    kind: "event", claim: "boa", status: "active", sensitivity: "normal",
    eventTimeStart: null, eventTimeEnd: null, alternative: null,
    updatedAt: "2026-01-01T00:00:00Z",
    replacesMemoryKey: null, replacedByMemoryKey: null,
  };
  const value = {
    schemaVersion: MEMORY_V3_DIALOGUE_READ_SCHEMA_VERSION, stateRevision: 0,
    items: [ordinary],
  };
  const result = projectMemoryV3DialogueReadContext(value);
  assert.equal(result.items[0].replacesMemoryKey, null);
  assert.equal(result.items[0].replacedByMemoryKey, null);
});
```

(Mirror these three for `lifecycleReadStore.cases.test.ts` against `projectMemoryV3LifecycleReadContext`/`MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION` — identical fixture shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts`
Expected: FAIL — `ITEM_FIELDS` doesn't include the new keys yet (`inspectRecord` rejects the extra keys as not in `fields`), and the CLOSED-status branch has no exception yet.

- [ ] **Step 3: Implement the read-store changes**

In both `dialogueReadStore.ts` and `lifecycleReadStore.ts` (identical edit in each file):

1. Add to the item type inside the `*ReadContext` interface (after `updatedAt: string;`):
```typescript
    replacesMemoryKey: string | null;
    replacedByMemoryKey: string | null;
```

2. Add to `ITEM_FIELDS` (after `"updatedAt"`):
```typescript
  "replacesMemoryKey",
  "replacedByMemoryKey",
```

3. In the item-mapping callback, replace the existing status-branch block:
```typescript
      if (item.kind === "event" || item.kind === "recurrence") {
        if (item.status !== "active" || item.alternative !== null) throw fail();
      } else if (item.kind === "hypothesis") {
        if (item.status !== "supported" || !isNonEmptyString(item.alternative)) {
          throw fail();
        }
      } else {
        throw fail();
      }
```
with:
```typescript
      const isLinked = item.replacesMemoryKey !== null || item.replacedByMemoryKey !== null;
      if (
        item.replacesMemoryKey !== null &&
        (typeof item.replacesMemoryKey !== "string" || item.replacesMemoryKey.length !== 64)
      ) throw fail();
      if (
        item.replacedByMemoryKey !== null &&
        (typeof item.replacedByMemoryKey !== "string" || item.replacedByMemoryKey.length !== 64)
      ) throw fail();
      if (item.kind === "event" || item.kind === "recurrence") {
        const currentOk = item.status === "active";
        const closedLinkedOk = isLinked && (item.status === "corrected" || item.status === "stale" || item.status === "rejected");
        if ((!currentOk && !closedLinkedOk) || item.alternative !== null) throw fail();
      } else if (item.kind === "hypothesis") {
        const currentOk = item.status === "supported";
        const closedLinkedOk = isLinked && (item.status === "stale" || item.status === "rejected");
        if ((!currentOk && !closedLinkedOk) || !isNonEmptyString(item.alternative)) {
          throw fail();
        }
      } else {
        throw fail();
      }
```
(This accepts a CLOSED item of any kind, including a closed `hypothesis`, as long as it carries a link pointer — Task 6's consumer never requests a closed hypothesis through this path in practice, since Task 3's SQL only ever selects a protected pair's two real stored rows, but the validator itself should not assume that and should accept whatever shape the RPC can legitimately produce.)

4. In the final returned object literal (the one built from `item.kind`/`item.claim`/etc.), add:
```typescript
        replacesMemoryKey: item.replacesMemoryKey as string | null,
        replacedByMemoryKey: item.replacedByMemoryKey as string | null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts`
Expected: PASS, all cases including pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueReadStore.ts supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReadStore.ts supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts
git commit -m "feat: accept linked-pair CLOSED items in Memory V3 read-context validators"
```

---

## Task 5: Export projection — carry the link fields through

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/viewerProjection.ts`
- Test: `supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks directly (this reads from `load_memory_v3_*_viewer_items`/`load_memory_v3_dialogue_viewer_items_all`, which this plan does not modify — those RPCs don't select `replaces_memory_key`/`replaced_by_memory_key` today). Per the spec, this task adds the fields to the TypeScript projection's input/output shape so Task 6 can rely on them once a future change (out of this plan's scope) threads them through those RPCs too — **for this plan, both fields will read as `undefined`/absent from the live RPC response and must default to `null`,** since the viewer RPCs themselves are untouched here.
- Produces: `MemoryV3ExportItem.replacesMemoryKey: string | null`, `.replacedByMemoryKey: string | null`.

Wait — re-read the spec before implementing this task: it says `projectMemoryV3ExportItems` "passes through unchanged from the stored item," implying the underlying RPC already returns these fields. Since this plan's Task 3 only modified the **read-context** RPCs (`load_memory_v3_*_read_context`), not the **viewer** RPCs (`load_memory_v3_*_viewer_items*`) that `exportMemoryV3Data()` actually calls, those two new columns do not yet reach `MemoryV3ViewerSourceItem` in practice. **Ruling for this task:** add a seventh migration-touching step here — extend `load_memory_v3_lifecycle_viewer_items` and `load_memory_v3_dialogue_viewer_items_all` (the two viewer RPCs Task 3 did not touch) to also select `replaces_memory_key`/`replaced_by_memory_key`, in a small addendum to Task 3's migration file (same file, since it's not yet pushed/merged — do not create a second migration for one line of scope creep within the same unreleased change). This keeps the spec's claim ("passes through unchanged from the stored item") actually true rather than silently false.

- [ ] **Step 1: Extend Task 3's migration with the viewer RPCs** (same file: `supabase/migrations/20261010100000_073_memory_v3_life_dynamics_linking.sql` — if Task 3 is already committed, amend with a new commit here rather than reopening Task 3's; do not rewrite a pushed migration)

Find today's live definitions of `load_memory_v3_lifecycle_viewer_items` and `load_memory_v3_dialogue_viewer_items_all` (most recently touched in `20261001220000_062_memory_v3_export.sql`/`20261001210000_061_memory_v3_viewer_first_seen_at.sql` — read whichever migration most recently `CREATE OR REPLACE`s each one, in full, before editing) and append two more `CREATE OR REPLACE FUNCTION` blocks to the bottom of `20261010100000_073_memory_v3_life_dynamics_linking.sql`: identical bodies to what's currently live, with `'replacesMemoryKey', i.replaces_memory_key, 'replacedByMemoryKey', i.replaced_by_memory_key` added to each one's `jsonb_build_object` call. Do not change their `REVOKE`/`GRANT` lines, parameter lists, or any other behavior.

- [ ] **Step 2: Extend the migration test**

Add to `lifeDynamicsLinkingMigration.cases.test.ts`:
```typescript
  it("also threads the link fields through both viewer RPCs so the export path can show them", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_viewer_items[\s\S]*?'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_viewer_items_all[\s\S]*?'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key/);
  });
```
Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/lifeDynamicsLinkingMigration.cases.test.ts` — expect FAIL before Step 1's SQL addendum exists, PASS after.

- [ ] **Step 3: Write the failing projection test**

Append to `viewerProjection.cases.test.ts`:

```typescript
it("projectMemoryV3ExportItems passes replacesMemoryKey/replacedByMemoryKey through unchanged when present, and defaults both to null when absent", () => {
  const withLinks: MemoryV3ViewerSourceItem = {
    memoryKey: "a".repeat(64), kind: "event", claim: "boa", status: "corrected",
    eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: null,
    firstSeenAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", alternative: null,
    replacesMemoryKey: null, replacedByMemoryKey: "b".repeat(64),
  } as MemoryV3ViewerSourceItem;
  const withoutLinks: MemoryV3ViewerSourceItem = {
    memoryKey: "c".repeat(64), kind: "event", claim: "fact", status: "active",
    eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: null,
    firstSeenAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", alternative: null,
  } as MemoryV3ViewerSourceItem;
  const [first, second] = projectMemoryV3ExportItems([withLinks, withoutLinks]);
  assert.equal(first.replacedByMemoryKey, "b".repeat(64));
  assert.equal(first.replacesMemoryKey, null);
  assert.equal(second.replacesMemoryKey, null);
  assert.equal(second.replacedByMemoryKey, null);
});

it("projectMemoryV3ViewerItems's own output is unchanged -- it never gains these fields", () => {
  const item: MemoryV3ViewerSourceItem = {
    memoryKey: "a".repeat(64), kind: "event", claim: "boa", status: "active",
    eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: null,
    firstSeenAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", alternative: null,
    replacesMemoryKey: null, replacedByMemoryKey: "b".repeat(64),
  } as MemoryV3ViewerSourceItem;
  const [result] = projectMemoryV3ViewerItems([item]);
  assert.deepEqual(Object.keys(result).sort(), [
    "claim", "eventTimeStart", "eventTimeEnd", "firstSeenAt", "kind",
    "memoryKey", "sensitivity", "topic", "updatedAt",
  ]);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: FAIL — `MemoryV3ViewerSourceItem` doesn't declare the two new fields yet (TypeScript shape mismatch) and `projectMemoryV3ExportItems`'s output omits them.

- [ ] **Step 5: Implement the projection change**

In `viewerProjection.ts`:

1. Add to `MemoryV3ViewerSourceItem` (after the `conversationId?: string;` comment block):
```typescript
  replacesMemoryKey?: string | null;
  replacedByMemoryKey?: string | null;
```
(optional, matching the existing `conversationId?` precedent for a field only some source rows carry — the viewer-only RPC path that lacks these columns today, before Step 1 of this task lands, would otherwise fail to type-check.)

2. Add to `MemoryV3ExportItem` (after `conversationId: string | null;`):
```typescript
  replacesMemoryKey: string | null;
  replacedByMemoryKey: string | null;
```

3. In `projectMemoryV3ExportItems`'s `.map()` return object, add:
```typescript
      replacesMemoryKey: item.replacesMemoryKey ?? null,
      replacedByMemoryKey: item.replacedByMemoryKey ?? null,
```

Do not touch `projectMemoryV3ViewerItems` at all.

- [ ] **Step 6: Run test to verify it passes**

Run: `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261010100000_073_memory_v3_life_dynamics_linking.sql supabase/functions/_shared/memoryV3/lifeDynamicsLinkingMigration.cases.test.ts supabase/functions/_shared/memoryV3/viewerProjection.ts supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts
git commit -m "feat: thread Memory V3 link fields through the viewer RPCs and export projection"
```

---

## Task 6: Weekly dynamics screen + weekly-reflection prompt

**Files:**
- Modify: `src/lib/conversationDynamicsView.ts`
- Modify: `supabase/functions/_shared/weeklyReflection.ts`
- Test: `src/lib/conversationDynamicsView.cases.test.ts` (create if it does not already exist — check first)
- Test: `supabase/functions/_shared/weeklyReflection.cases.test.ts`

**Interfaces:**
- Consumes: `exportMemoryV3Data()` (`src/lib/memoryV3Viewer.ts`, unchanged by this plan) returning `MemoryV3ExportItem[]` with `replacesMemoryKey`/`replacedByMemoryKey` per Task 5.
- Produces: `DynamicsChangingView`'s `newItems`/`fadedItems` now sourced from real pairs; a new `buildLinkedPairsPromptBlock(pairs)` export in `weeklyReflection.ts` consumed by `buildWeeklyReflectionPrompt`.

- [ ] **Step 1: Read the current state of both target files in full**

`conversationDynamicsView.ts` and `weeklyReflection.ts` were both read in full earlier this session — re-read them now regardless, since Tasks 1-5 did not touch them and nothing here should have drifted, but this step keeps the no-blind-patch discipline consistent across the whole plan.

- [ ] **Step 2: Write the failing frontend test**

Create (or extend, if a file already exists) `src/lib/conversationDynamicsView.cases.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

// conversationDynamicsView.ts imports the real Supabase client at module
// scope (Deno/browser-only in this form) -- same reason context.cases.test.ts
// and userLifeMemory.cases.test.ts read the raw source instead of importing
// the real module.
const source = await readFile(new URL("./conversationDynamicsView.ts", import.meta.url), "utf8");

it("fetchCrossMemoryForUser calls exportMemoryV3Data() instead of querying user_memory directly", () => {
  assert.match(source, /import\s*\{[^}]*exportMemoryV3Data[^}]*\}\s*from\s*['"]\.\/memoryV3Viewer['"]/);
  assert.doesNotMatch(source, /from\(['"]user_memory['"]\)/);
});

it("buildChangingView sources newItems/fadedItems from real linked pairs, not compareWeeklies text diffing", () => {
  assert.doesNotMatch(source, /function compareWeeklies/);
  assert.match(source, /replacesMemoryKey/);
  assert.match(source, /replacedByMemoryKey/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test src/lib/conversationDynamicsView.cases.test.ts`
Expected: FAIL (both assertions) — today's source still queries `user_memory` and still defines `compareWeeklies`.

- [ ] **Step 4: Implement the frontend change**

In `conversationDynamicsView.ts`:

1. Add the import:
```typescript
import { exportMemoryV3Data } from './memoryV3Viewer';
```

2. Replace `fetchCrossMemoryForUser` entirely. Confirmed today by reading
   `ConversationDynamicsScreen.tsx:378-393`: `crossMemory` (its result) is
   fetched and stored into `dynamicsData.crossMemory` but **is not read by
   `buildChangingView`, `buildRepeatingView`, or `buildAliveView` today** —
   it is already fully dead at the UI layer too, not just pointing at a
   retired table. This means the replacement is a straight swap of the
   field itself, not a second parameter:
```typescript
export interface LinkedMemoryPair {
  newClaim: string;
  oldClaim: string;
  newUpdatedAt: string;
}

export async function fetchLinkedMemoryPairs(): Promise<LinkedMemoryPair[]> {
  const result = await exportMemoryV3Data();
  if (result.error) return [];
  const all = [...result.accountWide, ...result.dialogue];
  const byKey = new Map(all.map((item) => [item.memoryKey, item]));
  const pairs: LinkedMemoryPair[] = [];
  for (const item of all) {
    if (!item.replacesMemoryKey) continue;
    const old = byKey.get(item.replacesMemoryKey);
    if (!old) continue;
    pairs.push({ newClaim: item.claim, oldClaim: old.claim, newUpdatedAt: item.updatedAt });
  }
  return pairs.sort((a, b) => (a.newUpdatedAt < b.newUpdatedAt ? 1 : -1));
}
```

3. In `ConversationDynamicsData`, replace:
```typescript
  crossMemory: UserMemory[];
```
with:
```typescript
  linkedPairs: LinkedMemoryPair[];
```

4. Remove `compareWeeklies`, `splitWeeklyPhrases`, `fetchCrossMemoryForUser`,
   and the now-unused `import type { UserMemory } from '../types';` — search
   the file to confirm nothing else references `UserMemory` before deleting
   the import.

5. Replace `buildChangingView`'s body to source `newItems`/`fadedItems`
   from `data.linkedPairs` instead of `data.weeklies`, keeping its existing
   single-argument signature:
```typescript
export function buildChangingView(data: ConversationDynamicsData): DynamicsChangingView {
  const latestWeeklyAt = data.weeklies[0]?.created_at;
  const previousWeeklyAt = data.weeklies[1]?.created_at;
  const sincePrevious = previousWeeklyAt
    ? data.linkedPairs.filter((p) =>
        p.newUpdatedAt > previousWeeklyAt && (!latestWeeklyAt || p.newUpdatedAt <= latestWeeklyAt))
    : [];
  const newItems = sincePrevious.map((p) => p.newClaim).slice(0, 4);
  const fadedItems = sincePrevious.map((p) => p.oldClaim).slice(0, 4);
  const activityText = buildActivityText(data.messageActivity);
  const empty = newItems.length === 0 && fadedItems.length === 0 && !activityText;
  return { newItems, fadedItems, repeatedItems: [], activityText, empty };
}
```
(`repeatedItems` has no real-data equivalent in this plan's scope — return
an empty array rather than inventing a new concept; the type keeps the
field so `ConversationDynamicsScreen.tsx`'s existing render of it degrades
to "nothing in this section" rather than a type error. Note this to
Настя as a small, visible UI change when this ships, not a bug.)

6. In `ConversationDynamicsScreen.tsx` (confirmed today, lines 378-393):
   change the `Promise.all` destructuring from
   `const [weeklyRows, memory, tensions, crossMemory, activity, cd] = await Promise.all([...])`
   to `const [weeklyRows, memory, tensions, linkedPairs, activity, cd] = await Promise.all([...])`,
   replace the `fetchCrossMemoryForUser(user.id)` entry in that array with
   `fetchLinkedMemoryPairs()`, and change `setDynamicsData({ ..., crossMemory, ... })`
   to `setDynamicsData({ ..., linkedPairs, ... })`. Update the matching
   import at the top of the file from `fetchCrossMemoryForUser` to
   `fetchLinkedMemoryPairs`. No other line in this file reads `crossMemory`
   (confirmed above), so no further changes are needed here.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/lib/conversationDynamicsView.cases.test.ts`
Expected: PASS, both cases.

- [ ] **Step 6: Run the project's typecheck to catch the `ConversationDynamicsScreen.tsx` call-site change**

Run: `npm run typecheck` (or the project's equivalent — confirm the exact script name in `package.json` before running; this session's earlier work used `npm run typecheck` and `npx eslint` as its established bar for UI-adjacent changes).
Expected: no new errors. A leftover call to `fetchCrossMemoryForUser` or the old two-argument-less `buildChangingView` signature surfaces here as a type error if Step 4.5 was missed.

- [ ] **Step 7: Write the failing weekly-reflection prompt test**

Append to `weeklyReflection.cases.test.ts` (read it first for its existing style):

```typescript
it("buildWeeklyReflectionPrompt includes a linked-pairs block when pairs are passed, instructing model judgment on attribution", () => {
  const withPairs = buildWeeklyReflectionPrompt({
    title: "эта беседа", memory: null, transcript: [], userMarks: [], activeDays: 1,
    linkedPairs: [{ newClaim: "сменила работу", oldClaim: "боялась сменить работу" }],
  });
  assert.match(withPairs, /сменила работу/);
  assert.match(withPairs, /боялась сменить работу/);
  assert.match(withPairs, /на ваше усмотрение/i);
});

it("buildWeeklyReflectionPrompt omits the linked-pairs block entirely when none are passed", () => {
  const withoutPairs = buildWeeklyReflectionPrompt({
    title: "эта беседа", memory: null, transcript: [], userMarks: [], activeDays: 1,
    linkedPairs: [],
  });
  assert.doesNotMatch(withoutPairs, /ПЕРЕМЕНЫ/);
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/weeklyReflection.cases.test.ts`
Expected: FAIL — `buildWeeklyReflectionPrompt` doesn't accept a `linkedPairs` parameter yet (TypeScript error / runtime `undefined` access).

- [ ] **Step 9: Implement the prompt change**

In `weeklyReflection.ts`:

1. Add an exported type near the top:
```typescript
export interface WeeklyReflectionLinkedPair {
  newClaim: string;
  oldClaim: string;
}
```

2. In `buildWeeklyReflectionPrompt`'s input type, add `linkedPairs: WeeklyReflectionLinkedPair[];`.

3. Inside the function body, before the `return` template string, add:
```typescript
  const pairsBlock = input.linkedPairs.length
    ? `\n\nПЕРЕМЕНЫ, КОТОРЫЕ УЖЕ ПРОИЗОШЛИ (раньше было иначе, сейчас стало так):\n${input.linkedPairs
        .map((p) => `• было: ${p.oldClaim} → стало: ${p.newClaim}`)
        .join("\n")}\nМожете упомянуть это, если оно естественно откликается на неделю ниже -- включая то, связывать ли это с работой здесь, оставляю на ваше усмотрение.`
    : "";
```

4. In the returned template string, add `${pairsBlock}` right after the existing `СЛЕДЫ, КОТОРЫЕ ПОЛЬЗОВАТЕЛЬ САМ СОХРАНИЛ:\n${marksBlock}` block (before `ФРАГМЕНТЫ ПЕРЕПИСКИ...`).

5. In `generateWeeklyReflectionText`, add a `linkedPairs: WeeklyReflectionLinkedPair[]` parameter to its own input (threaded in from whatever calls it — the `weekly-reflection` edge function's `index.ts` — add a call to a new small helper, `fetchLinkedPairsForConversation(supabase, conversationId)`, mirroring `fetchWeekUserMarks`'s existing query style but reading `memory_v3_dialogue_items` directly for rows where `conversation_id = meta.conversationId AND replaces_memory_key IS NOT NULL`, joined back to their `replaces_memory_key` row for the old claim — same two-step lookup as Step 4.2's frontend version, server-side). Pass its result into `buildWeeklyReflectionPrompt`'s call within this function.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/weeklyReflection.cases.test.ts`
Expected: PASS, all cases including pre-existing ones (no regressions to the `memoryBlock`/`marksBlock`/`transcriptBlock` tests).

- [ ] **Step 11: Commit**

```bash
git add src/lib/conversationDynamicsView.ts src/lib/conversationDynamicsView.cases.test.ts src/components/screens/ConversationDynamicsScreen.tsx supabase/functions/_shared/weeklyReflection.ts supabase/functions/_shared/weeklyReflection.cases.test.ts supabase/functions/weekly-reflection/index.ts
git commit -m "feat: wire Memory V3 linked pairs into the weekly dynamics screen and reflection prompt"
```

---

## Final steps (after all tasks, per superpowers:executing-plans)

- Run the project's full relevant test surface once more end to end:
  - `deno test --allow-read --allow-env --no-check supabase/functions/_shared/memoryV3/` (expect the two pre-existing, unrelated `lifecycleTransport`/`dialogueTransport` timeout-abort failures documented in `knowledge/staysee-deno-test-memoryv3-allow-env.md`, nothing else).
  - `npm run test:offline` (the Node/tsx frontend+shared suite).
  - `npm run typecheck` and `npx eslint` on all changed frontend files.
- Final whole-branch review per `superpowers:executing-plans`' own process (fresh reviewer on the most capable available model), focused on the Review Focus list above.
- Do not merge, deploy, or push `db push`/`functions deploy` as part of this plan's own completion — per this session's established pattern, Настя confirms the merge and runs the deploy steps herself afterward. Open a normal PR against `main` with a plain-Russian description, pushing the spec commits (`27441d5`, `25d4e20`, plus Task 3's self-review tightening) together with this branch's commits, per the no-wasted-CI-cycle reasoning already agreed for this change.
