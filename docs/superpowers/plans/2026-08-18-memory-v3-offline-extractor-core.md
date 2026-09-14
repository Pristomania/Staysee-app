# Memory V3 Offline Extractor Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-neutral offline extraction core that exposes synthetic messages to an injected adapter without gold leakage and converts strict adapter JSON into a contract-valid Memory V3 extraction.

**Architecture:** A pure prompt builder owns the data boundary. A separate async core owns the single adapter call, strict parsing, trusted metadata derivation, deterministic item identity, and contract validation. Provider adapters and benchmark runners remain deferred.

**Tech Stack:** Node.js ESM, `node:test`, existing `contracts.mjs`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-memory-v3-offline-extractor-core-design.md`

## Global Constraints

- Work only in `D:\Staisy-main Приложение\Staysee-memory-v3` on `codex/memory-v3-pilot`.
- No network, provider, database, Supabase, `.env`, production, deploy, migration, commit, push, or PR.
- Use TDD and stop after each task for review.
- Never pass `gold`, `mustNotRemember`, category, title, or evaluator data to the adapter.
- Do not modify existing contract, dataset, or evaluator semantics.

---

### Task 1: Provider-neutral prompt boundary

**Files:**
- Create: `scripts/memory-v3-pilot/extractor-prompt.mjs`
- Create: `scripts/memory-v3-pilot/extractor-prompt.test.mjs`

**Interfaces:**
- Consumes: `validateCase(caseData)` from `contracts.mjs`.
- Produces: `buildExtractorRequest(caseData) -> { system: string, input: { caseId: string, messages: Array<{id, role, text, createdAt}> } }`.

- [ ] **Step 1: Write failing boundary tests**

Create tests with a valid case containing conspicuous sentinel values in `title`, `category`, `gold`, and `mustNotRemember`. Assert deep equality of `request.input` to only `caseId` and four-field messages. Assert `JSON.stringify(request)` contains none of the forbidden sentinels. Assert the system instruction contains the exact item kinds, statuses, evidence relations, user-only support rule, distinct-episode recurrence rule, hypothesis alternative rule, JSON-only rule, abstention rule, and diagnosis/reasoning/attachment bans.

```js
const request = buildExtractorRequest(caseData);
assert.deepEqual(Object.keys(request).sort(), ['input', 'system']);
assert.deepEqual(request.input, {
  caseId: 'prompt-boundary-01',
  messages: caseData.messages.map(({ id, role, text, createdAt }) => ({
    id,
    role,
    text,
    createdAt,
  })),
});
for (const sentinel of ['LEAK_TITLE', 'LEAK_CATEGORY', 'LEAK_GOLD', 'LEAK_FORBIDDEN']) {
  assert.equal(JSON.stringify(request).includes(sentinel), false);
}
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test scripts/memory-v3-pilot/extractor-prompt.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extractor-prompt.mjs`, not a syntax/setup failure.

- [ ] **Step 3: Implement the minimal prompt builder**

Validate the full case first, then construct a fresh allowlisted message array. Freeze no caller data and mutate nothing. Return only `system` and `input`. The system string must describe the adapter response schema from the spec, including response-local `itemRef`; it must not interpolate case content.

```js
export function buildExtractorRequest(caseData) {
  const validated = validateCase(caseData);
  return {
    system: EXTRACTOR_SYSTEM_INSTRUCTION,
    input: {
      caseId: validated.caseId,
      messages: validated.messages.map(({ id, role, text, createdAt }) => ({
        id,
        role,
        text,
        createdAt,
      })),
    },
  };
}
```

- [ ] **Step 4: Verify GREEN and regression suite**

Run:

```bash
node --test scripts/memory-v3-pilot/extractor-prompt.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/extractor-prompt.mjs
git diff --check
```

Expected: all tests pass; no syntax or whitespace errors.

- [ ] **Step 5: Stop for review**

Report the first expected RED, exact test totals, changed paths, diff summary, and `git status --short`. Do not commit or begin Task 2.

---

### Task 2: Single-call extraction and strict normalization

**Files:**
- Create: `scripts/memory-v3-pilot/extractor-core.mjs`
- Create: `scripts/memory-v3-pilot/extractor-core.test.mjs`
- Modify: `scripts/memory-v3-pilot/README.md`

**Interfaces:**
- Consumes: `buildExtractorRequest`, `validateCase`, `validateExtraction`, `makeLocalItemKey`.
- Produces: `extractCase(caseData, modelAdapter, { extractorVersion }) -> Promise<Extraction>`.

- [ ] **Step 1: Write failing core tests**

Use async fake adapters, never mocks of contract functions. Cover a valid empty object, valid event as object and JSON string, exactly one adapter call, deterministic keys, derived scope/provenance/mention time, duplicate/unresolved `itemRef`, unknown fields, malformed JSON, adapter rejection without retry, unknown source ID, non-user evidence for every relation, evidence-free items, the complete status/relation matrix, one-episode recurrence, and hypothesis without alternative. Plain-object cases also cover accessors, symbols, non-enumerable fields, sparse/extended arrays, Proxy traps, cyclic values, and spoofed extractor error names.

```js
const extraction = await extractCase(caseData, async () => ({
  items: [{
    itemRef: 'item-1',
    kind: 'event',
    claim: 'Переехала в Казань',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: null,
    eventTimeEnd: null,
    alternative: null,
  }],
  evidence: [{
    itemRef: 'item-1',
    sourceMessageId: 'm1',
    episodeKey: 'move-kazan',
    relation: 'supports',
  }],
}), { extractorVersion: 'offline-core-v1' });
assert.equal(extraction.items[0].scope, 'cross_conversation');
assert.equal(extraction.evidence[0].provenanceRole, 'user');
assert.equal(extraction.evidence[0].mentionTime, caseData.messages[0].createdAt);
```

- [ ] **Step 2: Verify RED**

Run `node --test scripts/memory-v3-pilot/extractor-core.test.mjs`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extractor-core.mjs`.

- [ ] **Step 3: Implement strict shape parsing and normalization**

Call the adapter exactly once. Accept only a JSON string or JSON-data-only plain object. Allowlist every top-level, item, and evidence field and reject accessors, symbols, non-enumerable properties, sparse/extended arrays, and non-primitive schema values. Build all normalized items first, generate keys by output order, map `itemRef` to keys, then derive evidence role/time from the cited validated user message. Require related user evidence and the status-specific relation in the central contract; active/candidate recurrences still require two distinct episode keys. Wrap failures with the four stable prefixes without including message text, and recognize internal errors through an unforgeable module-local identity rather than `error.name`. Run `validateExtraction(result, validatedCase)` last and return the result unchanged.

- [ ] **Step 4: Verify GREEN and full suite**

Run:

```bash
node --test scripts/memory-v3-pilot/extractor-core.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/extractor-core.mjs
node --check scripts/memory-v3-pilot/extractor-core.test.mjs
git diff --check
```

Expected: all tests pass; no network-capable imports; no syntax or whitespace errors.

- [ ] **Step 5: Document and stop**

Add the two public APIs, adapter contract, error prefixes, and offline boundary to README. Report TDD evidence, full totals, privacy scan, paths, and status. Do not commit, add a provider, or run Task 3.
