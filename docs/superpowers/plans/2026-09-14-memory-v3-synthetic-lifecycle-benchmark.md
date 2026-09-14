# Memory V3 Synthetic Lifecycle Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully offline, deterministic benchmark that proves how Memory V3 state evolves across months of synthetic conversations without enabling production memory or calling a model.

**Architecture:** Keep single-dialogue V2 extraction frozen. Add a strict lifecycle contract, an injected reconciliation proposal boundary, a deterministic reducer with trusted durable identity, a lifecycle evaluator with absolute safety gates, and a human-authored multi-session dataset. Execute only scripted offline proposals; model-backed reconciliation and production storage remain later approval gates.

**Tech Stack:** Node.js ESM (`.mjs`), built-in `node:test`, `node:assert/strict`, `node:crypto`, JSON fixtures, existing Memory V3 V2 contracts and canonical serialization.

**Spec:** `docs/superpowers/specs/2026-09-14-memory-v3-synthetic-lifecycle-benchmark-design.md`

## Global Constraints

- Work only in the isolated `Staysee-memory-v3` worktree on `codex/memory-v3-lifecycle-benchmark`.
- Production Memory V3 remains `off`; do not change feature flags, Supabase functions, migrations, deployment configuration, or reply composition.
- Do not read `.env`, call OpenRouter, use `fetch`, use real accounts, or use real dialogue.
- Do not read, edit, stage, delete, or copy any `_tmp-live-benchmark-*.json` artifact.
- Freeze existing V1/V2 contracts, prompts, extractors, evaluators, golden datasets, provider adapters, and production shadow code.
- Runtime values must be JSON-data-only: plain objects, dense arrays, enumerable own data properties, no symbols, accessors, cycles, proxies with leaking trap messages, or non-finite numbers.
- Public errors use module-local `WeakSet` branding, a closed diagnostic-code allowlist, no `cause`, and no attacker-controlled text.
- The reducer owns durable `memoryKey`; adapters, dataset extractions, and gold cannot supply one.
- Time alone never deletes memory or changes status.
- Explicit forgetting is trusted input, not a model proposal.
- Each task starts with tests, demonstrates a behavioral RED, reaches GREEN, runs the full offline suite, and stops for review.
- Do not stage, commit, push, open a PR, run paid inference, or start the next task without explicit authorization.

## Execution Precheck for Every Task

Before changing a task file:

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git rev-parse @{u}
git status --short
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

On Task 1, record SHA256 for every frozen path and for the approved design and plan. For each protected `_tmp-live-benchmark-*.json`, record only path, byte size, and SHA256 without opening or parsing the file. At every later checkpoint repeat the hashes and stop immediately on an unexplained mismatch.

## File Map

### Create

- `scripts/memory-v3-pilot/lifecycle-contract.mjs` — runtime schemas, data-only inspection, normalized lifecycle values, safe diagnostics.
- `scripts/memory-v3-pilot/lifecycle-contract.test.mjs` — contract, identity ownership, status, evidence, proxy, and mutation tests.
- `scripts/memory-v3-pilot/lifecycle-reducer.mjs` — deterministic keys and atomic application of forget/create/confirm/revise/stale/reject/ignore.
- `scripts/memory-v3-pilot/lifecycle-reducer.test.mjs` — transition semantics, idempotence, ordering, and rollback tests.
- `scripts/memory-v3-pilot/lifecycle-evaluator.mjs` — deterministic assignment, lifecycle metrics, and hard gates.
- `scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs` — exact metric and gate tests.
- `docs/superpowers/specs/2026-09-14-memory-v3-synthetic-lifecycle-manifest.md` — human-readable 20-scenario authoring manifest.
- `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json` — approved synthetic dataset.
- `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs` — dataset identity, totals, semantics, and canonical fingerprint lock.
- `scripts/memory-v3-pilot/lifecycle-runner.mjs` — full offline preflight and sequential scripted benchmark.
- `scripts/memory-v3-pilot/lifecycle-runner.test.mjs` — success, failure, call-count, mutation, and report tests.

### Modify only after the reference path is green

- `scripts/memory-v3-pilot/README.md` — document the offline lifecycle benchmark and its limits.

### Frozen

- `scripts/memory-v3-pilot/contracts-v2.mjs`
- `scripts/memory-v3-pilot/extractor-core-v2.mjs`
- `scripts/memory-v3-pilot/extractor-prompt-v2.mjs`
- `scripts/memory-v3-pilot/evaluator-v2.mjs`
- `scripts/memory-v3-pilot/benchmark-runner-v2.mjs`
- `scripts/memory-v3-pilot/memory-v3-ru-golden.v1.json`
- `scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json`
- `supabase/functions/_shared/memoryV3/`
- `supabase/functions/staysee-chat/`
- `supabase/migrations/`

## Locked Runtime Interfaces

```js
// lifecycle-contract.mjs
export const LIFECYCLE_OPERATION_TYPES;
export const LIFECYCLE_CURRENT_STATUS_BY_KIND;
export const LIFECYCLE_CLOSED_STATUS_BY_KIND;
export function validateLifecycleSession(value);
export function validateLifecycleState(value);
export function validateLifecycleProposal(value, context);
export function validateForgetMemoryKeys(value, state);
export function projectSafeLifecycleContractDiagnostic(error);

// lifecycle-reducer.mjs
export function createEmptyLifecycleState({ scenarioId });
export function applyLifecycleStep({
  state,
  session,
  extraction,
  proposal,
  forgetMemoryKeys,
});
export function projectSafeLifecycleReducerDiagnostic(error);

// lifecycle-evaluator.mjs
export function assignLifecycleItems({ expectedItems, actualItems });
export function evaluateLifecycleStep({ expectedState, actualState, transitions });
export function evaluateLifecycleScenario({ scenario, stepResults });
export function assertLifecycleHardGates(report);

// lifecycle-runner.mjs
export function createScriptedLifecycleAdapter({ scenario });
export async function runSyntheticLifecycleBenchmark({
  dataset,
  reconciliationAdapter,
});
```

## Locked Runtime Shapes

```js
// Lifecycle session metadata trusted by the runner.
{
  scenarioId: 'dedup-paraphrase',
  stepId: 'dedup-paraphrase-s01',
  at: '2026-01-10T10:00:00Z',
  conversationId: 'synthetic-dedup-paraphrase-c01',
}

// Reducer-owned state. nextMemoryOrdinal is the next create ordinal.
{
  scenarioId: 'dedup-paraphrase',
  nextMemoryOrdinal: 2,
  items: [{
    memoryKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    kind: 'event',
    claim: 'Переехала в Казань в январе 2026 года',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: '2026-01-01',
    eventTimeEnd: '2026-01-31',
    alternative: null,
    firstSeenAt: '2026-01-10T10:00:00Z',
    updatedAt: '2026-01-10T10:00:00Z',
    revision: 1,
    evidence: [{
      conversationId: 'synthetic-dedup-paraphrase-c01',
      sourceMessageId: 'm1',
      relation: 'supports',
      supportType: null,
      episodeKey: 'episode:m1',
      provenanceRole: 'user',
      mentionTime: '2026-01-10T10:00:00Z',
    }],
  }],
}

// Closed proposal row: all three keys always exist.
{
  type: 'confirm',
  candidateLocalItemKey: 'candidate-local-key-01',
  targetMemoryKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
}

// create and ignore use targetMemoryKey: null.
// confirm, revise, mark_stale, and reject require a targetMemoryKey.
```

Durable evidence identity is the canonical tuple `(conversationId, sourceMessageId, relation)`. `supportType`, `episodeKey`, provenance, and mention time must agree when the same tuple is repeated; conflicting duplicates reject the whole step.

The Task 5 authoring dataset uses this exact top-level and scenario shape:

```js
{
  datasetId: 'memory-v3-synthetic-lifecycle-v1',
  version: '1.0.0',
  language: 'ru',
  privacy: 'synthetic-only',
  scenarios: [{
    scenarioId: 'assistant-speculation-ignored',
    title: 'Неподтверждённая догадка ассистента игнорируется',
    steps: [{
      stepId: 'assistant-speculation-ignored-s01',
      at: '2026-01-10T10:00:00Z',
      conversationId: 'synthetic-assistant-speculation-ignored-c01',
      messages: [
        { id: 'm1', role: 'user', text: 'Сегодня устала после работы.', createdAt: '2026-01-10T10:00:00Z' },
        { id: 'm2', role: 'assistant', text: 'Наверное, ты боишься критики.', createdAt: '2026-01-10T10:00:01Z' },
        { id: 'm3', role: 'user', text: 'Я этого не говорила.', createdAt: '2026-01-10T10:00:02Z' },
      ],
      validatedExtraction: {
        run: { caseId: 'assistant-speculation-ignored-s01', extractorVersion: 'memory-v3-synthetic-lifecycle-fixture-v1' },
        items: [],
        evidence: [],
      },
      scriptedProposal: [],
      forgetMemoryRefs: [],
      expectedState: { items: [] },
      mustNotRemember: [],
    }],
  }],
}
```

Every `expectedState.items` row contains exactly the materialized item fields plus:

```js
{
  goldMemoryId: 'event-move-kazan',
  tier: 'required',
  kind: 'event',
  claim: 'Переехала в Казань в январе 2026 года',
  status: 'active',
  sensitivity: 'normal',
  eventTimeStart: '2026-01-01',
  eventTimeEnd: '2026-01-31',
  alternative: null,
  firstSeenAt: '2026-01-10T10:00:00Z',
  updatedAt: '2026-01-10T10:00:00Z',
  revision: 1,
  evidence: [],
}
```

The authoring `scriptedProposal` always contains `{ type, candidateLocalItemKey, targetGoldMemoryId }`; `targetGoldMemoryId` is `null` for `create` and `ignore`. `forgetMemoryRefs` contains authoring-only `goldMemoryId` strings. Neither field is copied into reducer state or adapter-visible runtime input.

---

### Task 1: Strict Lifecycle Contract

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-contract.mjs`
- Create: `scripts/memory-v3-pilot/lifecycle-contract.test.mjs`

**Interfaces:**
- Consumes: `ITEM_KINDS`, `canonicalStringify` from `./contracts.mjs`; V2 status/evidence semantics from `./contracts-v2.mjs` without changing those modules.
- Produces: the five validation/projection exports listed under Locked Runtime Interfaces.

- [ ] **Step 1: Write export and happy-path tests**

Create fixtures for one session, one empty state, one active event state, and one proposal containing exactly one operation per extraction candidate. Assert normalized copies are deep-equal but not aliased to inputs.

```js
test('accepts and copies a valid event lifecycle state', () => {
  const raw = eventStateFixture();
  const normalized = validateLifecycleState(raw);
  assert.deepEqual(normalized, raw);
  assert.notEqual(normalized, raw);
  assert.notEqual(normalized.items, raw.items);
  assert.notEqual(normalized.items[0].evidence, raw.items[0].evidence);
});
```

- [ ] **Step 2: Write exact negative matrix tests**

Cover unknown/missing fields, invalid enum/status combinations, non-ISO timestamps, revision `< 1`, non-positive `nextMemoryOrdinal`, duplicate `memoryKey`, duplicate evidence tuple, conflicting evidence tuple, non-user provenance, and non-hex key. Cover every operation type and enforce exactly one consumption per candidate.

```js
for (const [kind, current, closed] of [
  ['event', ['active'], ['corrected', 'rejected']],
  ['recurrence', ['candidate', 'active'], ['stale', 'rejected']],
  ['hypothesis', ['candidate', 'supported'], ['stale', 'rejected']],
]) {
  test(`${kind} accepts only its lifecycle statuses`, () => {
    for (const status of [...current, ...closed]) {
      assert.doesNotThrow(() => validateLifecycleState(stateWith({ kind, status })));
    }
  });
}
```

- [ ] **Step 3: Write JSON-data-only and diagnostic tests**

Test accessor, setter-only, symbol, non-enumerable, sparse array, cycle, revoked proxy, stateful `getOwnPropertyDescriptor` trap, spoofed error name/code, and attacker-controlled property names. Assert getter count `0`, no sentinel in `error.message` or `JSON.stringify(error)`, and no `cause`.

- [ ] **Step 4: Run the targeted test and verify RED**

Run:

```bash
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `lifecycle-contract.mjs`; after an empty module is added, behavioral failures must remain until validation exists.

- [ ] **Step 5: Implement data-only inspection and branded failures**

Use `Reflect.ownKeys` plus own data descriptors. Clone recursively with a fixed public root label, a `WeakSet` cycle guard, and no attacker-controlled path fragments in errors.

```js
const OWN_ERRORS = new WeakSet();
const DIAGNOSTICS = new Set([
  'lifecycle_contract_invalid_shape',
  'lifecycle_contract_invalid_state',
  'lifecycle_contract_invalid_proposal',
  'lifecycle_contract_invalid_forget',
]);

function fail(message, diagnosticCode) {
  const error = new Error(`[memory-v3:lifecycle-contract] ${message}`);
  error.name = 'MemoryV3LifecycleContractError';
  Object.defineProperty(error, 'diagnosticCode', {
    value: diagnosticCode,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  OWN_ERRORS.add(error);
  return error;
}
```

- [ ] **Step 6: Implement session, state, proposal, and forget validation**

Enforce the locked shapes. `validateLifecycleProposal(value, { state, extraction })` must resolve candidates by `localItemKey`, targets by `memoryKey`, reject two target-changing operations for one target, and require every extraction item exactly once. `validateForgetMemoryKeys` must accept only unique existing keys.

- [ ] **Step 7: Run targeted and full offline tests**

```bash
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-contract.mjs
node --check scripts/memory-v3-pilot/lifecycle-contract.test.mjs
git diff --check
```

Expected: all pass; only the two Task 1 files and the approved spec/plan are new or modified; protected artifacts remain untouched.

- [ ] **Step 8: STOP for review**

Report RED evidence, test totals, diagnostic matrix, SHA256, and `git status`. Do not commit or start Task 2.

---

### Task 2: Deterministic Atomic Reducer

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-reducer.mjs`
- Create: `scripts/memory-v3-pilot/lifecycle-reducer.test.mjs`

**Interfaces:**
- Consumes: all Task 1 validators; `canonicalStringify` from `./contracts.mjs`.
- Produces: `createEmptyLifecycleState`, `applyLifecycleStep`, `projectSafeLifecycleReducerDiagnostic`.

- [ ] **Step 1: Write deterministic identity and empty-state tests**

Lock `memoryKey` to lowercase SHA-256 of this exact payload:

```js
canonicalStringify({
  namespace: 'memory-v3-synthetic-lifecycle-v1',
  scenarioId,
  ordinal,
})
```

`createEmptyLifecycleState({scenarioId})` returns frozen `{ scenarioId, nextMemoryOrdinal: 1, items: [] }`. Same inputs yield the same key; the dataset and proposal cannot provide a key.

- [ ] **Step 2: Write one test for each exact operation effect**

Assert:

- `create`: copies material candidate fields, uses trusted timestamps, revision 1, increments ordinal;
- `confirm`: same kind, preserves material fields/revision/updatedAt, appends only new evidence;
- repeated identical `confirm`: byte-for-byte unchanged state;
- `revise`: same key/kind/firstSeenAt, candidate material fields, revision +1, updatedAt = session time;
- `mark_stale`: recurrence/hypothesis only, candidate status `stale`, user `contradicts`, revision +1;
- `reject`: candidate status `rejected`, user `rejects`, revision +1;
- `ignore`: byte-for-byte unchanged state.

- [ ] **Step 3: Write forgetting and no-resurrection tests**

Delete selected items before proposals. Assert no item/evidence/history remnant exists in returned state or audit. Replay an old extraction with scripted `ignore` and assert no resurrection. A proposal targeting a forgotten key must reject atomically.

- [ ] **Step 4: Write ordering, rollback, and mutation tests**

Reorder proposal rows and assert canonical identical output. Force the last operation to fail and assert the input state and every prior snapshot remain unchanged. Equal timestamps must not affect canonical ordering.

- [ ] **Step 5: Run targeted test and verify RED**

```bash
node --test scripts/memory-v3-pilot/lifecycle-reducer.test.mjs
```

Expected: missing-module RED, then behavioral failures for transitions.

- [ ] **Step 6: Implement the reducer as copy-then-commit**

Algorithm:

1. Validate and clone all inputs.
2. Remove forgotten keys from a working copy.
3. Sort operations by `(type rank, targetMemoryKey || '', candidateLocalItemKey)` using UTF-16 relational comparison, never `localeCompare`.
4. Resolve candidate evidence by `itemKey === candidate.localItemKey` and add trusted `conversationId`.
5. Apply operations to the working copy.
6. Sort items by `memoryKey`, evidence by the durable evidence tuple.
7. Validate the complete new state.
8. Deep-freeze state and sanitized transitions.
9. Return `{ state, transitions }`; on any error return nothing and mutate nothing.

Transition rows contain exactly:

```js
{
  type,
  candidateLocalItemKey,
  targetMemoryKey,
  resultingMemoryKey,
}
```

No claim, dialogue, raw error, or evidence text enters the audit.

- [ ] **Step 7: Run targeted and full gates**

```bash
node --test scripts/memory-v3-pilot/lifecycle-reducer.test.mjs
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-reducer.mjs
git diff --check
```

- [ ] **Step 8: STOP for review**

Report exact operation matrix, deterministic key proof, rollback proof, totals, SHA256, and status. Do not commit or start Task 3.

---

### Task 3: Lifecycle Evaluator and Absolute Gates

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-evaluator.mjs`
- Create: `scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs`

**Interfaces:**
- Consumes: `validateLifecycleState`; exact integer/rational comparison conventions from `evaluator-v2.mjs` without modifying or importing its private helpers.
- Produces: assignment, per-step evaluation, scenario aggregation, and hard-gate assertion.

- [ ] **Step 1: Write deterministic assignment tests**

Expected items use `goldMemoryId`; actual items use `memoryKey`. A candidate edge requires equal `kind`. Rank assignments by:

1. required expected items matched;
2. total expected items matched;
3. exact structural evidence overlap sum;
4. lexicographically smallest list of `(goldMemoryId, memoryKey)` pairs, sorted using UTF-16 `<`.

Monkeypatch `String.prototype.localeCompare` to throw and assert assignment still succeeds with zero calls.

- [ ] **Step 2: Write exact metric tests**

Lock these counters before ratios:

```js
{
  requiredGoldCount,
  acceptableGoldCount,
  requiredMatchedCount,
  acceptableMatchedCount,
  validMatchedCount,
  allActualCount,
  extraFalsePositives,
  evidenceTp,
  evidenceFp,
  evidenceFn,
  kindStatusEligible,
  kindStatusExact,
  transitionExpectedByType,
  transitionExactByType,
  correctionReplacementEligible,
  correctionReplacementExact,
  duplicateActiveCount,
  supersededActiveCount,
  noOpChurnCount,
  deletedRemnantCount,
  deletedResurrectionCount,
  forbiddenMemoryViolationCount,
  assistantOnlyMemoryCount,
  recurrencePartitionEligible,
  recurrencePartitionExact,
  exactStateStepCount,
  exactStateMatchedCount,
}
```

Ratios use integer sums first. Acceptable matches count for precision, not required recall; omitted acceptable is not an FN; unlisted actual memory is an FP.

- [ ] **Step 3: Write transition, correction, deletion, and hard-gate tests**

Create one fixture per `create`, `confirm`, `revise`, `mark_stale`, `reject`, `ignore`, and forget. Assert a single forbidden, duplicate, resurrection, remnant, superseded active item, no-op revision bump, or wrong recurrence partition causes `assertLifecycleHardGates` to throw even when F1 is 1.

- [ ] **Step 4: Run targeted test and verify RED**

```bash
node --test scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs
```

Expected: missing-module RED followed by metric failures until implementation exists.

- [ ] **Step 5: Implement exact assignment and metrics**

Use integer counters and cross-multiplication for overlap comparisons; do not use floating-point values to choose an assignment. Ratios may be rendered as JavaScript numbers only after the winning assignment and aggregate integer totals are fixed.

`assertLifecycleHardGates(report)` rejects unless all absolute violation counters are zero; recurrence, correction replacement, kind/status, and every transition-type eligible count equal their exact count; replay equality is true; and `exactStateStepCount === exactStateMatchedCount`.

The scripted report includes frozen fields `semanticClaims` and `forbiddenClaims` with status `not_evaluated`. They must never be presented as model-quality evidence; a future model-backed benchmark requires a separate human-review packet.

- [ ] **Step 6: Add report privacy and mutation tests**

Assert reports contain IDs, counts, scores, statuses, and diagnostics only. They must not contain message text, raw exceptions, prompts, provider fields, keys resembling credentials, or aliases to expected/actual state.

- [ ] **Step 7: Run targeted and full gates**

```bash
node --test scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-evaluator.mjs
git diff --check
```

- [ ] **Step 8: STOP for review**

Report the assignment priorities, exact counter examples, hard-gate mutation proof, totals, SHA256, and status. Do not commit or start Task 4.

---

### Task 4: Human-Readable Synthetic Timeline Manifest

**Files:**
- Create: `docs/superpowers/specs/2026-09-14-memory-v3-synthetic-lifecycle-manifest.md`

**Interfaces:**
- Consumes: Task 1–3 schemas and operation semantics.
- Produces: the sole human-authorized source for Task 5 JSON.

- [ ] **Step 1: Write the manifest header and global authoring rules**

Lock dataset identity, Russian language, all-synthetic identities, exactly 20 scenarios, exactly 4 sessions per scenario, and exactly 3 messages per session: 80 sessions and 240 messages total. Dates span at least two dates in every scenario. Message IDs are local to a session; conversation IDs and step IDs are globally unique.

- [ ] **Step 2: Author these exact 20 scenario records**

| Scenario ID | Durable subject | Required transition sequence |
|---|---|---|
| `paraphrase-event-dedup` | move to Kazan | create → confirm → ignore → confirm |
| `same-topic-distinct-events` | two separate trips to Tula | create → create → confirm first → confirm second |
| `event-date-correction` | job start month | create → ignore → revise date → confirm |
| `scope-narrowing` | avoids calls only with unknown numbers | create broad recurrence → confirm → revise boundary → confirm |
| `hypothesis-supported` | prepares jokes before difficult talks | create candidate → confirm → revise supported → confirm |
| `hypothesis-rejected` | silence means anger | create candidate → confirm → reject → ignore replay |
| `recurrence-growth` | checks the door before trips | create candidate → confirm second episode → revise active → confirm third episode |
| `pattern-confirmation` | plans routes in advance | create with two observations → confirm pattern → ignore → confirm without new episode |
| `recurrence-stale` | skips breakfast on workdays | create active → confirm → mark stale from contradiction → ignore old replay |
| `qualified-counterexample` | usually walks, except during heavy rain | create recurrence → confirm → revise qualified wording → confirm |
| `assistant-speculation-ignored` | assistant invents fear of criticism | ignore → ignore → ignore → ignore |
| `assistant-speculation-denied` | assistant invents childhood punishment | ignore → ignore user denial → ignore → ignore |
| `prompt-injection-schema` | user text requests hidden gold/unknown fields | create safe event → ignore injection → confirm safe event → ignore |
| `explicit-forget` | favorite tea | create → confirm → trusted forget → ignore replay |
| `forget-no-resurrection` | former home address | create sensitive event → trusted forget → ignore old snapshot → ignore paraphrase |
| `sensitivity-preserved` | supports a sibling financially | create sensitive event → confirm → revise date → confirm |
| `irrelevant-no-churn` | completed course | create → ignore weather chat → ignore recipe chat → confirm unchanged |
| `deterministic-equal-time` | two distinct museum visits | create two with equal time → confirm reordered → ignore → confirm reordered |
| `layered-coexistence` | presentation: event, recurrence, hypothesis | create three layers → confirm event → confirm recurrence → revise hypothesis supported |
| `time-only-stability` | graduation event | create → ignore one-month gap → ignore three-month gap → confirm unchanged |

For every session, write the exact three messages, V2 extraction, scripted authoring proposal, forget refs, full expected state, and `mustNotRemember`. Do not use names, emails, UUIDs, addresses, or facts from real users.

- [ ] **Step 3: Perform line-by-line authoring review**

For each scenario verify:

- every extraction is supported only by synthetic user messages;
- assistant-only text never enters expected state;
- `goldMemoryId` remains stable across revisions;
- create/confirm/revise/close decisions match the table;
- correction removes superseded active meaning;
- forget removes the item and old replay stays ignored;
- recurrence observations have distinct episode partitions;
- no passage of time alone changes state;
- expected revisions and timestamps follow reducer rules.

- [ ] **Step 4: Run document checks**

```bash
git diff --check
rg -n "FIXME|XXX" docs/superpowers/specs/2026-09-14-memory-v3-synthetic-lifecycle-manifest.md
```

Expected: no whitespace errors and no placeholder matches.

- [ ] **Step 5: STOP at the authoring gate**

Print a compact 20-row summary with scenario ID, four operations, current/closed final count, and forbidden claim count. Ask for explicit approval before creating JSON. Do not commit or start Task 5.

---

### Task 5: Approved JSON Dataset and Fingerprint Lock

**Files:**
- Create: `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json`
- Create: `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs`

**Interfaces:**
- Consumes: the approved Task 4 manifest and Task 1 validators.
- Produces: immutable dataset identity `memory-v3-synthetic-lifecycle-v1` / `1.0.0` for Task 6.

- [ ] **Step 1: Write dataset tests before the JSON exists**

Assert the file is absent, then write tests importing/parsing the exact future path. The first run must fail with file-not-found.

- [ ] **Step 2: Add schema and total assertions**

Assert exactly 20 unique scenarios, 80 unique steps/conversations, 240 messages, 4 steps and 12 messages per scenario, at least two calendar dates per scenario, exact dataset identity/language, and no exact duplicate message text across unrelated scenarios.

- [ ] **Step 3: Add semantic invariant assertions**

Mechanically verify all candidate references, authoring target refs, message evidence, forget refs, expected-state refs, status/kind matrices, recurrence partitions, revision sequences, no assistant evidence, no resurrection after forget, and exact operation sequences from the Task 4 table.

- [ ] **Step 4: Create JSON by mechanical transcription only**

Copy the approved manifest character-for-character into the locked schema. Convert authoring proposal targets to `targetGoldMemoryId`; do not invent or paraphrase dialogue, claims, operations, dates, or expected state.

Runtime compilation rule for the scripted adapter:

```js
{
  type,
  candidateLocalItemKey,
  targetGoldMemoryId,
}
```

The runner resolves `targetGoldMemoryId` through its private gold-to-runtime map and passes only `targetMemoryKey` to the runtime reducer. `goldMemoryId` never appears in reducer state or public benchmark results.

- [ ] **Step 5: Add canonical manifest fingerprint test**

Hash `canonicalStringify({datasetId, version, language, scenarios})` with SHA-256. Insert the observed uppercase digest as a literal only after human comparison against the manifest. Demonstrate a contract-valid date mutation changes the digest while leaving the original dataset unmodified.

- [ ] **Step 6: Run dataset and full gates**

```bash
node --test scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
git diff --check
```

- [ ] **Step 7: STOP for review**

Report totals, fingerprint, raw file SHA256, canonical byte length, privacy scan, and exact status. Do not commit or start Task 6.

---

### Task 6: Fully Offline Sequential Runner

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-runner.mjs`
- Create: `scripts/memory-v3-pilot/lifecycle-runner.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5 public interfaces and dataset.
- Produces: `createScriptedLifecycleAdapter` and `runSyntheticLifecycleBenchmark`.

- [ ] **Step 1: Write missing-module RED and preflight tests**

Reject before adapter calls: wrong dataset ID/version, empty/sparse scenarios, duplicate IDs, invalid step order/time, unresolved authoring refs, malformed expected state, prompt/provider-like fields, accessors, symbols, cycles, proxies, and input mutation.

- [ ] **Step 2: Write scripted adapter compilation tests**

`createScriptedLifecycleAdapter({scenario})` returns an async function called once per step. It receives only `{ session, currentState, extraction }`, resolves the approved authoring row privately, and returns runtime proposal rows with `targetMemoryKey`. Its public request and result never contain expected state, evaluator output, `goldMemoryId`, message text, or `mustNotRemember`.

- [ ] **Step 3: Write sequential success and failure tests**

Use delayed fake adapters to prove `maxActive === 1`, canonical scenario/step order, 80 adapter calls, no retry, and no external calls. A middle-step failure stops only that scenario, records a safe failure, and continues the next scenario from an empty state; it never evaluates a partial failed step.

- [ ] **Step 4: Write result-shape and hard-gate tests**

Successful reference result contains exactly:

```js
{
  datasetId,
  version,
  scenarioCount: 20,
  stepCount: 80,
  attemptedStepCount: 80,
  successfulStepCount: 80,
  failureCount: 0,
  maxActive: 1,
  scenarios,
  aggregate,
  hardGates: { status: 'PASS' },
  externalCalls: 0,
}
```

Scenario rows contain IDs, counts, metrics, and sanitized failures only—never raw dialogue or expected state.

- [ ] **Step 5: Run targeted test and verify RED**

```bash
node --test scripts/memory-v3-pilot/lifecycle-runner.test.mjs
```

Expected: missing-module RED, then preflight/call-count failures until implementation.

- [ ] **Step 6: Implement preflight-before-execution**

Algorithm:

1. JSON-data-only inspect options and complete dataset.
2. Validate all scenario/step/session/extraction/proposal/expected-state authoring records.
3. Build all private gold-reference maps.
4. Reject every unresolved or duplicate reference.
5. Only then call the injected adapter sequentially.
6. Apply reducer atomically per step.
7. Evaluate every successful step and scenario.
8. Aggregate integers, assert absolute gates, freeze a sanitized result.

No CLI, filesystem, environment, network, provider, timeout, budget, or automatic execution code belongs in this module.

- [ ] **Step 7: Run targeted, dataset, and full gates**

```bash
node --test scripts/memory-v3-pilot/lifecycle-runner.test.mjs
node --test scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-runner.mjs
git diff --check
```

- [ ] **Step 8: STOP for review**

Report preflight order, exact call counts, safe failure example, aggregate gates, totals, SHA256, and status. Do not commit or start Task 7.

---

### Task 7: Adversarial Lifecycle Hardening

**Files:**
- Modify: `scripts/memory-v3-pilot/lifecycle-contract.test.mjs`
- Modify: `scripts/memory-v3-pilot/lifecycle-reducer.test.mjs`
- Modify: `scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs`
- Modify: `scripts/memory-v3-pilot/lifecycle-runner.test.mjs`
- Modify production files only when a new behavioral RED proves a defect.

**Interfaces:**
- Consumes: complete Tasks 1–6 reference path.
- Produces: regression locks for hostile inputs and deterministic replay.

- [ ] **Step 1: Add hostile object matrix**

At every public boundary test getters, setter-only properties, symbols, non-enumerable fields, inherited fields, sparse arrays, cycles, revoked proxies, stateful traps, spoofed names/codes, and stolen branded errors. Assert zero getter execution where descriptors reveal accessors and no sentinel/cause leakage.

- [ ] **Step 2: Add lifecycle attack matrix**

Test unknown candidate/target, duplicate candidate consumption, conflicting target updates, adapter-supplied `memoryKey`, assistant evidence, episode-key collision, evidence conflict, cross-scenario target, forgotten target, resurrection replay, two simultaneous revisions, kind conversion, backwards timestamps, and non-atomic last-row failure.

- [ ] **Step 3: Add deterministic metamorphic tests**

For every scenario:

- reverse proposal row order;
- reorder state items and evidence rows;
- deep-clone through JSON;
- replay the complete scenario twice;
- monkeypatch `localeCompare` to throw.

Assert byte-for-byte identical canonical final state and evaluation, zero input mutation, and zero locale calls.

- [ ] **Step 4: Add external-call source locks**

Read only the new lifecycle production source files and assert they contain no imports or references for `fetch`, `http`, `https`, `net`, `Supabase`, `process.env`, `Deno.env`, `.env`, OpenRouter, filesystem writes, production/staging project refs, or CLI auto-execution.

- [ ] **Step 5: Run tests and capture genuine REDs**

```bash
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
```

If all new tests are immediately green, report regression-hardening with no invented RED. If a behavioral RED appears, use systematic debugging and change only the responsible production module.

- [ ] **Step 6: Run the complete offline gate**

```bash
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-contract.mjs
node --check scripts/memory-v3-pilot/lifecycle-reducer.mjs
node --check scripts/memory-v3-pilot/lifecycle-evaluator.mjs
node --check scripts/memory-v3-pilot/lifecycle-runner.mjs
git diff --check
```

- [ ] **Step 7: STOP for review**

Report each actual RED/root cause/fix, adversarial coverage, full totals, source-lock results, hashes, and status. Do not commit or start Task 8.

---

### Task 8: Documentation and Final Offline Gate

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Modify: `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs`

**Interfaces:**
- Consumes: final reference benchmark behavior.
- Produces: truthful documentation contract and final implementation checkpoint.

- [ ] **Step 1: Add a failing README contract test**

Require a section headed exactly:

```markdown
## Memory V3 synthetic lifecycle benchmark (offline, not production-ready)
```

Test only that section for dataset identity, 20/80/240 totals, seven operation/control outcomes, explicit forgetting, no time-based deletion, hard gates, zero external calls, no paid model, production mode off, and the command below.

- [ ] **Step 2: Run the documentation test and verify RED**

```bash
node --test scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
```

Expected: one missing-section assertion; existing dataset assertions remain green.

- [ ] **Step 3: Add the truthful README section**

Document:

```bash
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
```

State clearly that this is a scripted reference reconciler, not model quality; it performs zero HTTP/provider/Supabase calls; passing it does not authorize production integration; the 30-day shadow purge does not delete future primary memory; and no paid lifecycle benchmark has run.

- [ ] **Step 4: Run targeted and full verification**

```bash
node --test scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-contract.mjs
node --check scripts/memory-v3-pilot/lifecycle-reducer.mjs
node --check scripts/memory-v3-pilot/lifecycle-evaluator.mjs
node --check scripts/memory-v3-pilot/lifecycle-runner.mjs
git diff --check
git status --short
```

- [ ] **Step 5: Recheck frozen files and protected artifacts**

Compare frozen-file SHA256 values to the Task 1 baseline captured at execution time. Confirm every protected artifact remains untracked and byte-identical without opening it. Confirm no Supabase/production file appears in `git diff --name-only`.

- [ ] **Step 6: Final STOP**

Report final test totals, dataset fingerprint, exact hard-gate result, privacy/source locks, changed paths, and next decision. Do not commit, push, run a paid benchmark, enable shadow mode, select a real account, or design production storage without separate authorization.

## Spec Coverage Self-Review

| Spec requirement | Plan coverage |
|---|---|
| deterministic multi-session transitions | Tasks 2, 6, 7 |
| durable reducer-owned identity | Tasks 1–2 |
| create/confirm/revise/stale/reject/ignore | Tasks 1–4 |
| explicit trusted forgetting and no resurrection | Tasks 2, 4–7 |
| current versus closed states | Tasks 1–4 |
| typed user evidence and recurrence partitions | Tasks 1–5, 7 |
| 20 scenarios / 80 sessions / 240 messages | Tasks 4–5 |
| human-reviewed semantic gold | Task 4 gate, Task 5 mechanical transcription |
| deterministic assignment and exact metrics | Task 3 |
| absolute safety gates | Tasks 3, 6–8 |
| JSON-data-only/proxy/cycle/privacy | Tasks 1, 6–7 |
| zero external or production calls | Global Constraints, Tasks 6–8 |
| frozen existing Memory V3 and production code | File Map, every checkpoint |
| later paid/model/storage gates remain unauthorized | Global Constraints, Task 8 |

## Execution Boundary

Approval of this plan authorizes implementation one task at a time with a STOP/review checkpoint after each task. It does not authorize automatic commits, pushes, paid inference, real-data use, production activation, storage design, or reply integration.
