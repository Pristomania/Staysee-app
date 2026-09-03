# Memory V3 V2 Profile-Driven Live Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dedicated six-case V2 live stack with one shared profile-driven engine, keep the public six-case surface unchanged, and add a thin hypothesis-four contour without a second execution loop.

**Architecture:** Frozen profile constants live in `live-benchmark-profiles-v2.mjs`. Shared engine, CLI, and composition root accept only an allowlisted string `profileId`, resolve it with `getLiveBenchmarkProfileV2`, and never take a profile object. Six-case and hypothesis-four files are thin wrappers that bind one canonical id. Full-24 is not implemented.

**Tech Stack:** Node.js ESM, `node:test`, existing Memory V3 V2 modules (`contracts-v2.mjs`, `extractor-prompt-v2.mjs`, `benchmark-runner-v2.mjs`, `evaluator-v2.mjs`, `benchmark-budget.mjs`, `openrouter-adapter.mjs`, `openrouter-fetch-transport.mjs`), Golden V2 JSON, injected fake `fetchImpl`.

**Spec:** `docs/superpowers/specs/2026-09-03-memory-v3-v2-profile-driven-live-benchmark-design.md`

## Global Constraints

- Work only in `D:\Staisy-main Приложение\Staysee-memory-v3` on `codex/memory-v3-pilot`.
- Do not edit the approved spec.
- Do not start Task N+1 until Codex accepts Task N.
- After every task: no `git add`, no `git commit`, no `git push`, no PR, no amend, no rebase, no force push.
- Do not read `.env`, call OpenRouter, or run a paid/live benchmark.
- Do not create, modify, delete, rename, parse, or stage `scripts/memory-v3-pilot/_tmp-live-benchmark-six-v2-gemini-20260902.json`.
- Do not implement a full-24 profile, extractorVersion, execute flag, or paid budget.
- Do not add `options.profile` to any shared API.
- Direct lookup `getLiveBenchmarkProfileV2(profileId)` accepts only a primitive non-empty string (`typeof profileId === "string"`). That argument has no property descriptor.
- Object APIs require `options.profileId` to be an own enumerable string data descriptor and must not execute getters.
- Profile object, spread copy, frozen clone, structurally identical copy, argv JSON, and filesystem profile loaders are forbidden.
- Budget numbers live as top-level profile fields. There is no nested `profile.budget`. Runtime `options.budget` is a separate seven-key object. The six non-cap fields strictly equal canonical. `maxBudgetUsd` is a finite number `<= canonical.maxBudgetUsd` that still passes `assertBudgetGate`; a smaller sufficient caller cap is accepted and is not rewritten. Callers cannot widen N, prices, or the canonical hard maximum. CLI still accepts only `canonical.maxBudgetUsdArg`.
- HTTP cap helper is `createProfileBoundedOpenRouterFetch(fetchImpl, profileId)`. It reads `maxRequests` and `httpCapError` only from the registry. There is no public `createAtMostNOpenRouterFetch`.
- Bounded-fetch order is: if `callCount >= canonical.maxRequests` throw the canonical cap error; then `callCount += 1`; then call inner `fetchImpl` once. Inner throw/reject still counts as an attempt. The rejected extra call does not invoke inner fetch.
- Engine, CLI, and run branding come only from the canonical profile. Callers cannot pass prefix, name, or `httpCapError`.
- Sequential execution: `maxActive` is always `1`. Continue after case failure. No application retry, fallback, or repair.
- Safe-output remains opt-in `--safe-output-file` on composition roots only. Preflight target and `` `${output}.tmp` `` before `.env` and HTTP. Publish with `wx` then `link` no-clobber. Unlink only owned tmp.
- `actualUsage` and `actualCostUsd` remain `null`.
- Shared modules never import wrappers. Wrappers never import other wrappers.
- Frozen modules listed below must keep the same bytes as Task 1 records.
- Synthetic Golden V2 fixtures only. No production, staging, or Supabase access.
- Public errors, stdout benchmark JSON, and stderr must not contain filesystem paths, API keys, `OPENROUTER_API_KEY`, `Authorization`, raw provider bodies, extractor system instruction, `.env` contents, or gold/title/category inside `benchmarkResult`.
- Import of engine, CLI, or run modules must not start a benchmark.
- This plan does not authorize any paid execute.

---

## File map

### Create

| File | Owner | Responsibility |
|------|-------|----------------|
| `scripts/memory-v3-pilot/live-benchmark-profiles-v2.mjs` | Task 2 | Frozen `six-category-v2` and `hypothesis-four-v2`; `getLiveBenchmarkProfileV2` |
| `scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs` | Task 2 | Direct-lookup and schema tests |
| `scripts/memory-v3-pilot/live-benchmark-engine-v2.mjs` | Task 3 | `runProfileLiveBenchmarkV2`, `buildProfileSemanticReviewPacketV2`, `createProfileBoundedOpenRouterFetch` |
| `scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs` | Task 3 | Object-API identity, fake-fetch, packet, HTTP cap |
| `scripts/memory-v3-pilot/live-benchmark-cli-v2.mjs` | Task 5 | `runProfileBenchmarkFromArgvV2` |
| `scripts/memory-v3-pilot/live-benchmark-cli-v2.test.mjs` | Task 5 | Argv, env-once, execute-flag isolation |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.mjs` | Task 5 | Thin CLI bound to `"hypothesis-four-v2"` |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.test.mjs` | Task 5 | Four-case CLI flags and isolation |
| `scripts/memory-v3-pilot/live-benchmark-run-v2.mjs` | Task 6 | Shared `main`, safe-output, packet via engine |
| `scripts/memory-v3-pilot/live-benchmark-run-v2.test.mjs` | Task 6 | Shared run and safe-output |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs` | Task 6 | Thin executable bound to `"hypothesis-four-v2"` |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.test.mjs` | Task 6 | Import safety, dry-run, safe-output |

### Modify

| File | Owner | Change |
|------|-------|--------|
| `scripts/memory-v3-pilot/live-benchmark-six-v2.mjs` | Task 4 | Delegate to shared engine; keep public exports |
| `scripts/memory-v3-pilot/live-benchmark-six-cli-v2.mjs` | Task 5 | Delegate to shared CLI; keep `runSixCaseBenchmarkFromArgvV2` |
| `scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs` | Task 6 | Delegate to shared run; keep `main` and local identifier aliases |
| `scripts/memory-v3-pilot/README.md` | Task 7 | Document hypothesis-four dry-run; do not claim a paid run |

### Frozen

Do not edit these files in this plan:

- `scripts/memory-v3-pilot/evaluator-v2.mjs`
- `scripts/memory-v3-pilot/contracts-v2.mjs`
- `scripts/memory-v3-pilot/extractor-core-v2.mjs`
- `scripts/memory-v3-pilot/extractor-prompt-v2.mjs`
- `scripts/memory-v3-pilot/benchmark-runner-v2.mjs`
- `scripts/memory-v3-pilot/benchmark-budget.mjs`
- `scripts/memory-v3-pilot/openrouter-adapter.mjs`
- `scripts/memory-v3-pilot/openrouter-fetch-transport.mjs`
- `scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json`
- `scripts/memory-v3-pilot/memory-v3-ru-golden.v1.json`
- `scripts/memory-v3-pilot/live-benchmark-six.mjs`
- `scripts/memory-v3-pilot/live-benchmark-six-cli.mjs`
- `scripts/memory-v3-pilot/live-benchmark-six-run.mjs`
- `scripts/memory-v3-pilot/evaluator.mjs`
- `scripts/memory-v3-pilot/live-benchmark-six-v2.test.mjs`
- `scripts/memory-v3-pilot/live-benchmark-six-cli-v2.test.mjs`
- `scripts/memory-v3-pilot/live-benchmark-six-run-v2.test.mjs`
- `scripts/memory-v3-pilot/_tmp-live-benchmark-six-v2-gemini-20260902.json`
- `docs/superpowers/specs/2026-09-03-memory-v3-v2-profile-driven-live-benchmark-design.md`

Expected SHA256 for the spec, checked on every Frozen reprint:

`69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A`

Expected SHA256 for the artifact, checked on every Frozen reprint:

`4C853A7FF2DEDDB2AE544DCE767B039F9E7A5DBC16B437CBDD1AB9DE76DD93FB`

---

## Locked signatures

```
getLiveBenchmarkProfileV2(profileId)

runProfileLiveBenchmarkV2({
  dataset,
  profileId,
  model,
  extractorVersion,
  budget,
  maxPromptRequestBytesPerCase,
  execute,
  apiKey?,
  fetchImpl?
})

buildProfileSemanticReviewPacketV2({
  profileId,
  dataset,
  benchmarkResult
})

createProfileBoundedOpenRouterFetch(fetchImpl, profileId)

runProfileBenchmarkFromArgvV2({
  argv,
  dataset,
  profileId,
  fetchImpl?,
  readEnvText?
})

main({
  argv,
  readFileImpl,
  fetchImpl,
  writeStdout,
  writeStderr,
  profileId,
  writeFileImpl?,
  linkImpl?,
  unlinkImpl?,
  accessImpl?
})
```

Six-case compatibility exports, unchanged names and arities:

```
SIX_CASE_BENCHMARK_V2_CASE_IDS
SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION
createAtMostSixOpenRouterFetch(fetchImpl)
runSixCaseLiveBenchmarkV2({
  dataset,
  model,
  extractorVersion,
  budget,
  maxPromptRequestBytesPerCase,
  execute,
  apiKey?,
  fetchImpl?
})
buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult })
runSixCaseBenchmarkFromArgvV2({ argv, dataset, fetchImpl?, readEnvText? })
main({
  argv,
  readFileImpl,
  fetchImpl,
  writeStdout,
  writeStderr,
  writeFileImpl?,
  linkImpl?,
  unlinkImpl?,
  accessImpl?
})
```

Public six-case `main` does not accept `profileId` from callers. The wrapper injects `"six-category-v2"`.

### Exact profile own keys

No extras. Forbidden on a profile: `budget`, `errorPrefix`, `errorName`.

`profileId`, `caseIds`, `model`, `extractorVersion`, `datasetId`, `datasetVersion`, `reasoningEffort`, `maxOutputTokensPerCase`, `maxInputTokensPerCase`, `inputUsdPerMillion`, `outputUsdPerMillion`, `maxBudgetUsd`, `maxRequests`, `caseCount`, `timeoutMs`, `maxResponseBytes`, `maxPromptRequestBytesPerCase`, `maxTokensParameter`, `allowFallbacks`, `responseContract`, `executeFlag`, `maxBudgetUsdArg`, `engineErrorPrefix`, `engineErrorName`, `cliErrorPrefix`, `cliErrorName`, `runErrorPrefix`, `runErrorName`, `httpCapError`

### Runtime `options.budget` keys

Exactly: `caseCount`, `maxInputTokensPerCase`, `maxOutputTokensPerCase`, `inputUsdPerMillion`, `outputUsdPerMillion`, `maxRequests`, `maxBudgetUsd`

### six-category-v2 values

- `profileId`: `six-category-v2`
- `caseIds`: `memv3-ru-event-03`, `memv3-ru-correction-04`, `memv3-ru-recurrence-02`, `memv3-ru-hypothesis-01`, `memv3-ru-counterexample-01`, `memv3-ru-safety-03`
- `model`: `google/gemini-3.7-flash`
- `extractorVersion`: `memory-v3-openrouter-gemini-3.7-flash-six-v2`
- `datasetId`: `memory-v3-ru-golden-v2`
- `datasetVersion`: `2.0.0`
- `reasoningEffort`: `low`
- `maxOutputTokensPerCase`: `1200`
- `maxInputTokensPerCase`: `16384`
- `inputUsdPerMillion`: `0.75`
- `outputUsdPerMillion`: `3.75`
- `maxBudgetUsd`: `0.11`
- `maxBudgetUsdArg`: `"0.11"`
- `caseCount`: `6`
- `maxRequests`: `6`
- `timeoutMs`: `60000`
- `maxResponseBytes`: `1000000`
- `maxPromptRequestBytesPerCase`: `20000`
- `maxTokensParameter`: `max_tokens`
- `allowFallbacks`: `true`
- `responseContract`: `v2`
- `executeFlag`: `--execute-six-paid-requests`
- `engineErrorPrefix`: `[memory-v3:live-benchmark-six-v2]`
- `engineErrorName`: `MemoryV3SixCaseBenchmarkV2Error`
- `cliErrorPrefix`: `[memory-v3:live-benchmark-six-cli-v2]`
- `cliErrorName`: `MemoryV3SixCaseBenchmarkCliV2Error`
- `runErrorPrefix`: `[memory-v3:live-benchmark-six-run-v2]`
- `runErrorName`: `MemoryV3SixCaseBenchmarkRunV2Error`
- `httpCapError`: `seventh fetch is not allowed`
- ceiling: `absoluteCostUsd = 0.100728`, `absoluteCostNanodollars = "100728000"`, gate PASS against `0.11`

### hypothesis-four-v2 values

- `profileId`: `hypothesis-four-v2`
- `caseIds`: `memv3-ru-hypothesis-01`, `memv3-ru-hypothesis-02`, `memv3-ru-hypothesis-03`, `memv3-ru-hypothesis-04`
- `model`: `google/gemini-3.7-flash`
- `extractorVersion`: `memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2`
- `datasetId`: `memory-v3-ru-golden-v2`
- `datasetVersion`: `2.0.0`
- `reasoningEffort`: `low`
- `maxOutputTokensPerCase`: `1200`
- `maxInputTokensPerCase`: `16384`
- `inputUsdPerMillion`: `0.75`
- `outputUsdPerMillion`: `3.75`
- `maxBudgetUsd`: `0.075`
- `maxBudgetUsdArg`: `"0.075"`
- `caseCount`: `4`
- `maxRequests`: `4`
- `timeoutMs`: `60000`
- `maxResponseBytes`: `1000000`
- `maxPromptRequestBytesPerCase`: `20000`
- `maxTokensParameter`: `max_tokens`
- `allowFallbacks`: `true`
- `responseContract`: `v2`
- `executeFlag`: `--execute-hypothesis-four-paid-requests`
- `engineErrorPrefix`: `[memory-v3:live-benchmark-hypothesis-four-v2]`
- `engineErrorName`: `MemoryV3HypothesisFourBenchmarkV2Error`
- `cliErrorPrefix`: `[memory-v3:live-benchmark-hypothesis-four-cli-v2]`
- `cliErrorName`: `MemoryV3HypothesisFourBenchmarkCliV2Error`
- `runErrorPrefix`: `[memory-v3:live-benchmark-hypothesis-four-run-v2]`
- `runErrorName`: `MemoryV3HypothesisFourBenchmarkRunV2Error`
- `httpCapError`: `fifth fetch is not allowed`
- ceiling: `absoluteInputTokens = 65536`, `absoluteOutputTokens = 4800`, `inputCostUsd = 0.049152`, `outputCostUsd = 0.018`, `absoluteCostUsd = 0.067152`, `absoluteCostNanodollars = "67152000"`, gate PASS against `0.075`

### Exact dependency map

```
live-benchmark-profiles-v2.mjs
  (no engine, CLI, run, V1 live modules, evaluator, adapter, fetch, fs, env)

live-benchmark-engine-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> contracts-v2.mjs
  -> extractor-prompt-v2.mjs
  -> benchmark-runner-v2.mjs
  -> evaluator-v2.mjs
  -> benchmark-budget.mjs
  -> openrouter-adapter.mjs
  -> openrouter-fetch-transport.mjs

live-benchmark-cli-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-engine-v2.mjs

live-benchmark-run-v2.mjs
  -> live-benchmark-cli-v2.mjs
  -> live-benchmark-engine-v2.mjs
  -> node:fs/promises and node:path only here and in wrapper direct-invocation defaults

live-benchmark-six-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-engine-v2.mjs

live-benchmark-six-cli-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-cli-v2.mjs

live-benchmark-six-run-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-run-v2.mjs

live-benchmark-hypothesis-four-cli-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-cli-v2.mjs

live-benchmark-hypothesis-four-run-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-run-v2.mjs
```

`live-benchmark-six-run-v2.mjs` must not import `live-benchmark-six-v2.mjs` or `live-benchmark-six-cli-v2.mjs`. Keep characterization greps GREEN with local aliases:

```
function runSixCaseBenchmarkFromArgvV2(options) {
  return runProfileBenchmarkFromArgvV2({
    argv: options.argv,
    dataset: options.dataset,
    fetchImpl: options.fetchImpl,
    readEnvText: options.readEnvText,
    profileId: 'six-category-v2',
  });
}

function buildSixCaseSemanticReviewPacketV2(options) {
  return buildProfileSemanticReviewPacketV2({
    dataset: options.dataset,
    benchmarkResult: options.benchmarkResult,
    profileId: 'six-category-v2',
  });
}
```

Those aliases must be imported from shared-run re-exports (`runProfileBenchmarkFromArgvV2` and `buildProfileSemanticReviewPacketV2` re-exported by `live-benchmark-run-v2.mjs`). Shared run may re-export CLI and packet builder. Shared run must not import six or hypothesis wrappers.

### Compatibility `createAtMostSixOpenRouterFetch`

In `live-benchmark-six-v2.mjs` only:

```
export function createAtMostSixOpenRouterFetch(fetchImpl) {
  return createProfileBoundedOpenRouterFetch(fetchImpl, 'six-category-v2');
}
```

### HTTP cap algorithm

Do not increment-then-compare. The returned wrapper keeps an integer `callCount` starting at `0` and exposes it as an own enumerable getter named `callCount`.

1. Before inner fetch, if `callCount >= canonical.maxRequests`, throw the branded error whose message is `canonical.engineErrorPrefix + ' ' + canonical.httpCapError`. Do not increment. Do not call inner fetch.
2. Then set `callCount = callCount + 1`.
3. Then call inner `fetchImpl` exactly once with the same `url` and `init`.
4. If inner fetch throws or rejects, the attempt still counts. `callCount` stays incremented.
5. For `six-category-v2`, calls 1 through 6 succeed; call 7 is blocked.
6. For `hypothesis-four-v2`, calls 1 through 4 succeed; call 5 is blocked.
7. A blocked call does not invoke inner fetch.

### Object API `profileId` descriptor matrix

Every object API below must have separate RED assertions for each invalid kind, plus one GREEN assertion for a primitive own enumerable string data field. Invalid cases must not run the side effects listed.

| API | getter | setter-only | non-enumerable data | symbol-keyed substitute | inherited `profileId` | valid own enumerable string | Side effects that stay at 0 |
|-----|--------|-------------|---------------------|-------------------------|-----------------------|-----------------------------|-----------------------------|
| `runProfileLiveBenchmarkV2` | RED, `getterCalls === 0` | RED, setter not called | RED | RED | RED | GREEN dry-run | `fetchImpl` calls |
| `buildProfileSemanticReviewPacketV2` | RED, `getterCalls === 0` | RED, setter not called | RED | RED | RED | GREEN packet | no packet object returned |
| `runProfileBenchmarkFromArgvV2` | RED, `getterCalls === 0` | RED, setter not called | RED | RED | RED | GREEN dry-run | `readEnvText` calls and `fetchImpl` calls |
| shared `main` | RED, `getterCalls === 0` | RED, setter not called | RED | RED | RED | GREEN dry-run | dataset reads, env reads, fetch, fs mutations |

Helper to install those forgeries on an otherwise valid options object. Copy this helper into each new test file that covers an object API. Do not pass a profile object as the whole `options` value.

```javascript
function withProfileIdDescriptor(baseOptions, kind, probe) {
  const options = Object.assign({}, baseOptions);
  delete options.profileId;
  if (kind === 'valid-own-enumerable-string') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return options;
  }
  if (kind === 'getter') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      get() {
        probe.getterCalls += 1;
        return 'six-category-v2';
      },
    });
    return options;
  }
  if (kind === 'setter-only') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      set() {
        probe.setterCalls += 1;
      },
    });
    return options;
  }
  if (kind === 'non-enumerable') {
    Object.defineProperty(options, 'profileId', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return options;
  }
  if (kind === 'symbol-keyed') {
    Object.defineProperty(options, Symbol('profileId'), {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return options;
  }
  if (kind === 'inherited') {
    const proto = { profileId: 'six-category-v2' };
    return Object.assign(Object.create(proto), options);
  }
  throw new Error('unknown descriptor kind');
}
```

---

## Shared test fixtures used by later tasks

Put these helpers inside each new test file that needs them. Do not create a shared test-helper module. Do not import wrappers from shared tests.

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3.7-flash';
const API_KEY = 'test-memory-v3-profile-v2-key';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';

const PROFILE_OWN_KEYS = Object.freeze([
  'profileId',
  'caseIds',
  'model',
  'extractorVersion',
  'datasetId',
  'datasetVersion',
  'reasoningEffort',
  'maxOutputTokensPerCase',
  'maxInputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'maxBudgetUsd',
  'maxRequests',
  'caseCount',
  'timeoutMs',
  'maxResponseBytes',
  'maxPromptRequestBytesPerCase',
  'maxTokensParameter',
  'allowFallbacks',
  'responseContract',
  'executeFlag',
  'maxBudgetUsdArg',
  'engineErrorPrefix',
  'engineErrorName',
  'cliErrorPrefix',
  'cliErrorName',
  'runErrorPrefix',
  'runErrorName',
  'httpCapError',
]);

const SIX_BUDGET = Object.freeze({
  caseCount: 6,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxRequests: 6,
  maxBudgetUsd: 0.11,
});

const HYPOTHESIS_BUDGET = Object.freeze({
  caseCount: 4,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxRequests: 4,
  maxBudgetUsd: 0.075,
});

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-profile-v2',
    object: 'chat.completion',
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content, refusal: null },
      },
    ],
  };
}

function jsonResponse(body) {
  return {
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init);
    return jsonResponse(officialOpenRouterHttpBody());
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function caseIdFromRequest(init) {
  const body = JSON.parse(init.body);
  const input = JSON.parse(body.messages[1].content);
  return input.caseId;
}

function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes('OPENROUTER_API_KEY'), false);
  assert.equal(text.includes('Authorization'), false);
  assert.equal(text.includes('.env'), false);
}
```

Regression command used at the end of every task after Task 1:

```
node --test scripts/memory-v3-pilot/*.test.mjs
```

Expect fail 0. Record pass/fail totals in the task report. Then run `node --check` on every `.mjs` file listed in that task's Files block, then `git diff --check`.

Privacy scan on public errors and stdout JSON: `assertNoSecrets` plus no env path, output path, temp path, gold claim arrays, or `mustNotRemember` inside `benchmarkResult`.

---

### Task 1: Characterization baseline and frozen compatibility locks

**Files:**
- Create: none
- Modify: none
- Test: existing `live-benchmark-six-v2.test.mjs`, `live-benchmark-six-cli-v2.test.mjs`, `live-benchmark-six-run-v2.test.mjs`

**Interfaces:**
- Consumes: current six-case V2 public surface
- Produces: recorded pass/fail totals and SHA256 of every Frozen file, used by later tasks as the compatibility lock

- [ ] **Step 1: Run six-case characterization**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-six-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-six-cli-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-six-run-v2.test.mjs
```

Expected: fail 0. Copy the printed pass count into the task report. Do not edit those three test files.

- [ ] **Step 2: Run full offline glob**

Run:

```
node --test scripts/memory-v3-pilot/*.test.mjs
```

Expected: fail 0. Copy pass/fail totals into the task report.

- [ ] **Step 3: Record SHA256 of Frozen files**

Run from the worktree root:

```
python -c "from pathlib import Path; import hashlib, sys
root=Path('scripts/memory-v3-pilot')
names=['evaluator-v2.mjs','contracts-v2.mjs','extractor-core-v2.mjs','extractor-prompt-v2.mjs','benchmark-runner-v2.mjs','benchmark-budget.mjs','openrouter-adapter.mjs','openrouter-fetch-transport.mjs','memory-v3-ru-golden.v2.json','memory-v3-ru-golden.v1.json','live-benchmark-six.mjs','live-benchmark-six-cli.mjs','live-benchmark-six-run.mjs','evaluator.mjs','live-benchmark-six-v2.test.mjs','live-benchmark-six-cli-v2.test.mjs','live-benchmark-six-run-v2.test.mjs','_tmp-live-benchmark-six-v2-gemini-20260902.json']
for n in names:
    print(n, hashlib.sha256((root/n).read_bytes()).hexdigest().upper())
spec=Path('docs/superpowers/specs/2026-09-03-memory-v3-v2-profile-driven-live-benchmark-design.md')
spec_hash=hashlib.sha256(spec.read_bytes()).hexdigest().upper()
print('SPEC', spec_hash)
if spec_hash != '69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A':
    sys.exit(1)
art_hash=hashlib.sha256((root/'_tmp-live-benchmark-six-v2-gemini-20260902.json').read_bytes()).hexdigest().upper()
if art_hash != '4C853A7FF2DEDDB2AE544DCE767B039F9E7A5DBC16B437CBDD1AB9DE76DD93FB':
    sys.exit(1)
"
```

Copy the printed table into the task report. Tasks 2-8 must rerun this exact command. Spec hash must remain `69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A`. Artifact hash must remain `4C853A7FF2DEDDB2AE544DCE767B039F9E7A5DBC16B437CBDD1AB9DE76DD93FB`. Other Frozen hashes must match the Task 1 printout.

- [ ] **Step 4: Confirm working tree**

Run:

```
git status --short
```

Expected: only

```
?? scripts/memory-v3-pilot/_tmp-live-benchmark-six-v2-gemini-20260902.json
```

plus this plan file if it is still untracked. No production files modified.

- [ ] **Step 5: STOP for Codex review**

Do not stage, commit, or push. Do not start Task 2.

---

### Task 2: Frozen profile registry and direct lookup

**Files:**
- Create: `scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-profiles-v2.mjs`
- Modify: none

**Interfaces:**
- Consumes: none from later tasks
- Produces: `getLiveBenchmarkProfileV2(profileId)` returning the registry-owned deeply frozen constant

- [ ] **Step 1: Write the failing direct-lookup tests**

Create `scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs` with the fixtures `PROFILE_OWN_KEYS`, `SIX_BUDGET`, and `HYPOTHESIS_BUDGET` from the shared fixtures block, then:

```javascript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';

describe('getLiveBenchmarkProfileV2 direct lookup', () => {
  it('returns the same deeply frozen six-category-v2 constant twice', () => {
    const first = getLiveBenchmarkProfileV2('six-category-v2');
    const second = getLiveBenchmarkProfileV2('six-category-v2');
    assert.equal(Object.is(first, second), true);
    assert.deepEqual(Object.getOwnPropertyNames(first).sort(), [...PROFILE_OWN_KEYS].sort());
    assert.equal(Object.prototype.hasOwnProperty.call(first, 'budget'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(first, 'errorPrefix'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(first, 'errorName'), false);
    assert.deepEqual([...first.caseIds], [
      'memv3-ru-event-03',
      'memv3-ru-correction-04',
      'memv3-ru-recurrence-02',
      'memv3-ru-hypothesis-01',
      'memv3-ru-counterexample-01',
      'memv3-ru-safety-03',
    ]);
    assert.equal(first.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-six-v2');
    assert.equal(first.maxRequests, 6);
    assert.equal(first.maxBudgetUsd, 0.11);
    assert.equal(first.maxBudgetUsdArg, '0.11');
    assert.equal(first.executeFlag, '--execute-six-paid-requests');
    assert.equal(first.engineErrorPrefix, '[memory-v3:live-benchmark-six-v2]');
    assert.equal(first.engineErrorName, 'MemoryV3SixCaseBenchmarkV2Error');
    assert.equal(first.cliErrorPrefix, '[memory-v3:live-benchmark-six-cli-v2]');
    assert.equal(first.cliErrorName, 'MemoryV3SixCaseBenchmarkCliV2Error');
    assert.equal(first.runErrorPrefix, '[memory-v3:live-benchmark-six-run-v2]');
    assert.equal(first.runErrorName, 'MemoryV3SixCaseBenchmarkRunV2Error');
    assert.equal(first.httpCapError, 'seventh fetch is not allowed');
    assert.equal(first.caseCount, first.caseIds.length);
    assert.equal(first.maxRequests, first.caseIds.length);
    assert.equal(first.datasetId, 'memory-v3-ru-golden-v2');
    assert.equal(first.datasetVersion, '2.0.0');
    assert.equal(first.model, 'google/gemini-3.7-flash');
    assert.equal(first.reasoningEffort, 'low');
    assert.equal(first.maxOutputTokensPerCase, 1200);
    assert.equal(first.maxInputTokensPerCase, 16384);
    assert.equal(first.inputUsdPerMillion, 0.75);
    assert.equal(first.outputUsdPerMillion, 3.75);
    assert.equal(first.timeoutMs, 60000);
    assert.equal(first.maxResponseBytes, 1000000);
    assert.equal(first.maxPromptRequestBytesPerCase, 20000);
    assert.equal(first.maxTokensParameter, 'max_tokens');
    assert.equal(first.allowFallbacks, true);
    assert.equal(first.responseContract, 'v2');
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.caseIds), true);
    assert.deepEqual(Object.getOwnPropertyNames(first).sort(), [...PROFILE_OWN_KEYS].sort());
    assert.throws(() => {
      first.model = 'other-model';
    }, TypeError);
    assert.throws(() => {
      first.caseIds.push('memv3-ru-event-01');
    }, TypeError);
    assert.throws(() => {
      first.caseIds[0] = 'memv3-ru-event-01';
    }, TypeError);
  });

  it('returns the frozen hypothesis-four-v2 values and budget math inputs', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.caseIds), true);
    assert.deepEqual(Object.getOwnPropertyNames(profile).sort(), [...PROFILE_OWN_KEYS].sort());
    assert.throws(() => {
      profile.maxRequests = 24;
    }, TypeError);
    assert.deepEqual([...profile.caseIds], [
      'memv3-ru-hypothesis-01',
      'memv3-ru-hypothesis-02',
      'memv3-ru-hypothesis-03',
      'memv3-ru-hypothesis-04',
    ]);
    assert.equal(profile.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2');
    assert.equal(profile.maxRequests, 4);
    assert.equal(profile.caseCount, 4);
    assert.equal(profile.maxBudgetUsd, 0.075);
    assert.equal(profile.maxBudgetUsdArg, '0.075');
    assert.equal(profile.executeFlag, '--execute-hypothesis-four-paid-requests');
    assert.equal(profile.engineErrorPrefix, '[memory-v3:live-benchmark-hypothesis-four-v2]');
    assert.equal(profile.engineErrorName, 'MemoryV3HypothesisFourBenchmarkV2Error');
    assert.equal(profile.cliErrorPrefix, '[memory-v3:live-benchmark-hypothesis-four-cli-v2]');
    assert.equal(profile.cliErrorName, 'MemoryV3HypothesisFourBenchmarkCliV2Error');
    assert.equal(profile.runErrorPrefix, '[memory-v3:live-benchmark-hypothesis-four-run-v2]');
    assert.equal(profile.runErrorName, 'MemoryV3HypothesisFourBenchmarkRunV2Error');
    assert.equal(profile.httpCapError, 'fifth fetch is not allowed');
    assert.equal(profile.maxInputTokensPerCase * profile.caseCount, 65536);
    assert.equal(profile.maxOutputTokensPerCase * profile.caseCount, 4800);
  });

  it('rejects non-primitive lookup arguments without executing getters', () => {
    let getterCalls = 0;
    const getterContainer = {
      get profileId() {
        getterCalls += 1;
        return 'six-category-v2';
      },
    };
    const rejected = [
      {},
      { profileId: 'six-category-v2' },
      new String('six-category-v2'),
      getterContainer,
      ['six-category-v2'],
      null,
      Symbol('six-category-v2'),
      'full-24-v2',
      '',
      'six-category-v2 ',
    ];
    for (const value of rejected) {
      assert.throws(() => getLiveBenchmarkProfileV2(value));
    }
    assert.equal(getterCalls, 0);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm RED**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs
```

Expected RED: `ERR_MODULE_NOT_FOUND` for `./live-benchmark-profiles-v2.mjs`, or missing export `getLiveBenchmarkProfileV2`. Do not treat a syntax error in the test file as the required RED.

- [ ] **Step 3: Implement the registry**

Create `scripts/memory-v3-pilot/live-benchmark-profiles-v2.mjs`.

Rules:

- No imports of engine, CLI, run, V1 live modules, evaluator, adapter, fetch, fs, or env.
- Two literals only: `six-category-v2` and `hypothesis-four-v2`.
- Deep-freeze each profile, including `caseIds`.
- Every own key is an enumerable string data descriptor.
- Validate exact own keys, `caseCount === caseIds.length`, `maxRequests === caseIds.length`, unique non-empty caseIds, dataset identity, `responseContract === "v2"`, `maxTokensParameter` in `{ max_tokens, max_completion_tokens }`, execute flags start with `--` and do not collide.
- `getLiveBenchmarkProfileV2(profileId)`:
  - if `typeof profileId !== "string"` or `profileId.length === 0` or `profileId.trim() !== profileId`, throw;
  - look up the primitive string in a private map;
  - unknown string throws;
  - return the registry-owned constant;
  - `Object.is(getLiveBenchmarkProfileV2(id), getLiveBenchmarkProfileV2(id)) === true`.

- [ ] **Step 4: Run targeted GREEN**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs
node --check scripts/memory-v3-pilot/live-benchmark-profiles-v2.mjs
```

Expected: pass. fail 0.

- [ ] **Step 5: Characterization plus full regression**

Run the Task 1 characterization command and `node --test scripts/memory-v3-pilot/*.test.mjs`. Expected: fail 0; six-case totals not lower than Task 1. Rerun the Task 1 Frozen SHA256 command, including the spec hash `69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A`.

- [ ] **Step 6: STOP for Codex review**

Do not stage, commit, or push.

---

### Task 3: Shared engine, bounded fetch, and semantic packet

**Files:**
- Create: `scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-engine-v2.mjs`
- Modify: none

**Interfaces:**
- Consumes: `getLiveBenchmarkProfileV2(profileId)`
- Produces: `runProfileLiveBenchmarkV2`, `buildProfileSemanticReviewPacketV2`, `createProfileBoundedOpenRouterFetch`

- [ ] **Step 1: Write failing object-API, HTTP-cap, execute, and packet tests**

Create `scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs`. Include the shared fixtures and copy `withProfileIdDescriptor` from Object API `profileId` descriptor matrix. Then add these cases:

```javascript
import {
  buildProfileSemanticReviewPacketV2,
  createProfileBoundedOpenRouterFetch,
  runProfileLiveBenchmarkV2,
} from './live-benchmark-engine-v2.mjs';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';

function sixEngineOptions(overrides = {}) {
  return {
    dataset: loadGoldenDataset(),
    profileId: 'six-category-v2',
    model: MODEL,
    extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-six-v2',
    budget: { ...SIX_BUDGET },
    maxPromptRequestBytesPerCase: 20000,
    execute: false,
    ...overrides,
  };
}

describe('runProfileLiveBenchmarkV2 identity', () => {
  it('rejects a profile clone as options.profileId inside otherwise valid options, with zero HTTP', async () => {
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    const fetchImpl = recordingFetch();
    const structuralCopy = {
      profileId: 'six-category-v2',
      caseIds: [...canonical.caseIds],
      model: canonical.model,
      extractorVersion: canonical.extractorVersion,
      inputUsdPerMillion: canonical.inputUsdPerMillion,
      outputUsdPerMillion: canonical.outputUsdPerMillion,
      maxRequests: canonical.maxRequests,
      maxBudgetUsd: canonical.maxBudgetUsd,
    };
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: { ...canonical }, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          profileId: Object.freeze({ ...canonical }),
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: structuralCopy, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: canonical, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: 'full-24-v2', fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects unknown outer field profile with zero HTTP', async () => {
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          profile: canonical,
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects invalid profileId descriptors without executing getters and with zero HTTP', async () => {
    const fetchImpl = recordingFetch();
    const base = sixEngineOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      const forged = withProfileIdDescriptor(base, kind, probe);
      await assert.rejects(() => runProfileLiveBenchmarkV2(forged));
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
    }
    const valid = withProfileIdDescriptor(base, 'valid-own-enumerable-string', {
      getterCalls: 0,
      setterCalls: 0,
    });
    valid.execute = false;
    const dry = await runProfileLiveBenchmarkV2(valid);
    assert.equal(dry.providerHttpCalls, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('dry-run six-category-v2 returns a plan with zero HTTP and null costs', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ fetchImpl }),
    );
    assert.equal(result.providerHttpCalls, 0);
    assert.equal(result.maxActive, 1);
    assert.equal(result.attemptedCount, 0);
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    assert.equal(result.configuredBudget.absoluteCostUsd, 0.100728);
    assert.equal(result.configuredBudget.absoluteCostNanodollars, '100728000');
    assert.equal(result.configuredBudget.gate, 'PASS');
    assert.deepEqual(result.caseIds, getLiveBenchmarkProfileV2('six-category-v2').caseIds);
    assert.equal(fetchImpl.calls.length, 0);
    assertNoSecrets(result);
  });

  it('execute six-category-v2 is sequential, N=6, and blocks the seventh fetch', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.providerHttpCalls, 6);
    assert.equal(result.maxActive, 1);
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    for (const call of fetchImpl.calls) {
      assert.equal(call.url, OPENROUTER_URL);
      assert.equal(call.init.method, 'POST');
    }
    const guarded = createProfileBoundedOpenRouterFetch(fetchImpl, 'six-category-v2');
    for (let index = 0; index < 6; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    assert.equal(guarded.callCount, 6);
    await assert.rejects(
      () => guarded(OPENROUTER_URL, { method: 'POST' }),
      (error) =>
        error.name === 'MemoryV3SixCaseBenchmarkV2Error' &&
        String(error.message) ===
          '[memory-v3:live-benchmark-six-v2] seventh fetch is not allowed',
    );
    assert.equal(guarded.callCount, 6);
    const inner = recordingFetch();
    const capped = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2', 100);
    for (let index = 0; index < 6; index += 1) {
      await capped(OPENROUTER_URL, { method: 'POST' });
    }
    await assert.rejects(() => capped(OPENROUTER_URL, { method: 'POST' }));
    assert.equal(inner.calls.length, 6);
    assert.equal(capped.callCount, 6);
    assert.throws(() => createProfileBoundedOpenRouterFetch(inner, { maxRequests: 100 }));
    assert.throws(() => createProfileBoundedOpenRouterFetch(inner, { profileId: 'six-category-v2' }));
  });

  it('counts an inner fetch rejection as an attempt and still blocks the seventh call', async () => {
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      if (innerCalls === 1) {
        throw new Error('inner boom');
      }
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2');
    await assert.rejects(() => guarded(OPENROUTER_URL, { method: 'POST' }));
    assert.equal(innerCalls, 1);
    assert.equal(guarded.callCount, 1);
    for (let index = 0; index < 5; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    assert.equal(innerCalls, 6);
    assert.equal(guarded.callCount, 6);
    await assert.rejects(() => guarded(OPENROUTER_URL, { method: 'POST' }));
    assert.equal(innerCalls, 6);
    assert.equal(guarded.callCount, 6);
  });

  it('execute hypothesis-four-v2 uses four ids, $0.067152 ceiling, and fifth-fetch cap', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2({
      dataset: loadGoldenDataset(),
      profileId: 'hypothesis-four-v2',
      model: MODEL,
      extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
      budget: { ...HYPOTHESIS_BUDGET },
      maxPromptRequestBytesPerCase: 20000,
      execute: true,
      apiKey: API_KEY,
      fetchImpl,
    });
    assert.equal(fetchImpl.calls.length, 4);
    assert.equal(result.providerHttpCalls, 4);
    assert.equal(result.maxActive, 1);
    assert.deepEqual(result.caseIds, [
      'memv3-ru-hypothesis-01',
      'memv3-ru-hypothesis-02',
      'memv3-ru-hypothesis-03',
      'memv3-ru-hypothesis-04',
    ]);
    assert.equal(result.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2');
    assert.equal(result.configuredBudget.absoluteInputTokens, 65536);
    assert.equal(result.configuredBudget.absoluteOutputTokens, 4800);
    assert.equal(result.configuredBudget.inputCostUsd, 0.049152);
    assert.equal(result.configuredBudget.outputCostUsd, 0.018);
    assert.equal(result.configuredBudget.absoluteCostUsd, 0.067152);
    assert.equal(result.configuredBudget.absoluteCostNanodollars, '67152000');
    assert.equal(result.configuredBudget.gate, 'PASS');
    const inner = recordingFetch();
    const capped = createProfileBoundedOpenRouterFetch(inner, 'hypothesis-four-v2');
    for (let index = 0; index < 4; index += 1) {
      await capped(OPENROUTER_URL, { method: 'POST' });
    }
    await assert.rejects(
      () => capped(OPENROUTER_URL, { method: 'POST' }),
      (error) =>
        error.name === 'MemoryV3HypothesisFourBenchmarkV2Error' &&
        String(error.message) ===
          '[memory-v3:live-benchmark-hypothesis-four-v2] fifth fetch is not allowed',
    );
    assert.equal(inner.calls.length, 4);
    assert.equal(capped.callCount, 4);
  });

  it('continues after a middle-case failure without retry', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      if (caseIdFromRequest(init) === 'memv3-ru-recurrence-02') {
        return jsonResponse({
          id: 'chatcmpl-fail',
          object: 'chat.completion',
          created: 1,
          model: MODEL,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: EMPTY_CONTENT,
                refusal: 'RAW_PROVIDER_MESSAGE_SENTINEL',
              },
            },
          ],
        });
      }
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.failureCount, 1);
    assert.equal(result.successCount, 5);
    assert.equal(result.aggregate, null);
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(Object.keys(failed).sort(), ['caseId', 'diagnosticCode', 'stage']);
    assertNoSecrets(result);
    assert.equal(JSON.stringify(result).includes('RAW_PROVIDER_MESSAGE_SENTINEL'), false);
  });
});
```

Also add packet tests:

```javascript
function hypothesisEngineOptions(overrides = {}) {
  return {
    dataset: loadGoldenDataset(),
    profileId: 'hypothesis-four-v2',
    model: MODEL,
    extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
    budget: { ...HYPOTHESIS_BUDGET },
    maxPromptRequestBytesPerCase: 20000,
    execute: false,
    ...overrides,
  };
}

describe('buildProfileSemanticReviewPacketV2', () => {
  it('rejects a profile clone as profileId while dataset and benchmarkResult are valid', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: { ...canonical },
        dataset,
        benchmarkResult: dry,
      });
    });
    assert.throws(() => {
      buildProfileSemanticReviewPacketV2({
        profileId: Object.freeze({ ...canonical }),
        dataset,
        benchmarkResult: dry,
      });
    });
    assert.equal(packet, undefined);
  });

  it('rejects invalid profileId descriptors and returns no packet', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const base = {
      profileId: 'six-category-v2',
      dataset: loadGoldenDataset(),
      benchmarkResult: dry,
    };
    for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      let packet;
      assert.throws(() => {
        packet = buildProfileSemanticReviewPacketV2(
          withProfileIdDescriptor(base, kind, probe),
        );
      });
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
      assert.equal(packet, undefined);
    }
    const valid = withProfileIdDescriptor(base, 'valid-own-enumerable-string', {
      getterCalls: 0,
      setterCalls: 0,
    });
    const packet = buildProfileSemanticReviewPacketV2(valid);
    assert.deepEqual(
      packet.cases.map((entry) => entry.caseId),
      getLiveBenchmarkProfileV2('six-category-v2').caseIds,
    );
  });

  it('rejects unknown outer field profile and returns no packet', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset: loadGoldenDataset(),
        benchmarkResult: dry,
        profile: getLiveBenchmarkProfileV2('six-category-v2'),
      });
    });
    assert.equal(packet, undefined);
  });

  it('aligns hypothesis-four packet cases to canonical order', async () => {
    const dry = await runProfileLiveBenchmarkV2(hypothesisEngineOptions());
    const packet = buildProfileSemanticReviewPacketV2({
      profileId: 'hypothesis-four-v2',
      dataset: loadGoldenDataset(),
      benchmarkResult: dry,
    });
    assert.deepEqual(
      packet.cases.map((entry) => entry.caseId),
      [
        'memv3-ru-hypothesis-01',
        'memv3-ru-hypothesis-02',
        'memv3-ru-hypothesis-03',
        'memv3-ru-hypothesis-04',
      ],
    );
    assert.equal(packet.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2');
    for (const entry of packet.cases) {
      assert.equal(entry.semanticVerdict, null);
      assert.equal(entry.forbiddenMeaningVerdict, null);
      assert.equal(entry.reviewerNotes, null);
      for (const message of entry.messages) {
        assert.deepEqual(Object.keys(message).sort(), ['id', 'role', 'text']);
      }
    }
  });

  it('rejects duplicate, missing, extra, or reordered benchmarkResult cases', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const reordered = {
      ...dry,
      caseIds: [...dry.caseIds].reverse(),
      cases: [...dry.cases].reverse(),
    };
    const missing = {
      ...dry,
      caseIds: dry.caseIds.slice(1),
      cases: dry.cases.slice(1),
    };
    const extra = {
      ...dry,
      caseIds: [...dry.caseIds, 'memv3-ru-event-01'],
      cases: [...dry.cases, { caseId: 'memv3-ru-event-01' }],
    };
    const duplicate = {
      ...dry,
      caseIds: [...dry.caseIds, dry.caseIds[0]],
      cases: [...dry.cases, dry.cases[0]],
    };
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: reordered,
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: missing,
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: extra,
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: duplicate,
      }),
    );
  });

  it('rejects benchmarkResult model or extractorVersion mismatch', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: { ...dry, model: 'openai/gpt-5.6-luna' },
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: {
          ...dry,
          extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
        },
      }),
    );
  });
});

describe('runProfileLiveBenchmarkV2 preflight negatives', () => {
  it('rejects wrong datasetId before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.datasetId = 'memory-v3-ru-golden-v1';
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects wrong dataset version before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.version = '1.0.0';
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects missing or duplicate selected cases before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const missing = JSON.parse(JSON.stringify(dataset));
    missing.cases = missing.cases.filter((entry) => entry.caseId !== 'memv3-ru-event-03');
    const duplicate = JSON.parse(JSON.stringify(dataset));
    const copy = duplicate.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    duplicate.cases.push(JSON.parse(JSON.stringify(copy)));
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset: missing, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset: duplicate, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('keeps canonical case order when dataset.cases is reversed, with zero HTTP', async () => {
    const fetchImpl = recordingFetch();
    const reversed = JSON.parse(JSON.stringify(loadGoldenDataset()));
    reversed.cases.reverse();
    const dry = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ dataset: reversed, fetchImpl }),
    );
    assert.deepEqual(dry.caseIds, [
      'memv3-ru-event-03',
      'memv3-ru-correction-04',
      'memv3-ru-recurrence-02',
      'memv3-ru-hypothesis-01',
      'memv3-ru-counterexample-01',
      'memv3-ru-safety-03',
    ]);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects wrong model before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          model: 'openai/gpt-5.6-luna',
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects wrong extractorVersion before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects missing, extra, or mismatched budget fields before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const missing = { ...SIX_BUDGET };
    delete missing.maxRequests;
    const extra = { ...SIX_BUDGET, absoluteMaxRequests: 6 };
    const mismatched = { ...SIX_BUDGET, maxRequests: 24 };
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ budget: missing, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ budget: extra, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ budget: mismatched, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects maxPromptRequestBytesPerCase mismatch before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          maxPromptRequestBytesPerCase: 19999,
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects actual prompt byte overflow before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = JSON.parse(JSON.stringify(loadGoldenDataset()));
    const target = dataset.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    target.messages[0].text = 'x'.repeat(30000);
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects sparse cases and getter options before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const sparse = { ...dataset, cases: dataset.cases.slice() };
    sparse.cases[2] = undefined;
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset: sparse, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    const withModelGetter = sixEngineOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    let modelReads = 0;
    Object.defineProperty(withModelGetter, 'model', {
      enumerable: true,
      configurable: true,
      get() {
        modelReads += 1;
        return MODEL;
      },
    });
    await assert.rejects(() => runProfileLiveBenchmarkV2(withModelGetter));
    assert.equal(modelReads, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});
```

These negatives keep every required engine field present except the one under test. Expected RED after the module exists is the missing named check (dataset identity, budget field match, prompt byte cap), not `options must be a plain object` and not `profileId is missing`.

Engine source must not import wrappers:

```javascript
it('does not import six or hypothesis wrappers', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./live-benchmark-engine-v2.mjs', import.meta.url)),
    'utf8',
  );
  assert.equal(source.includes('live-benchmark-six-v2.mjs'), false);
  assert.equal(source.includes('live-benchmark-six-cli-v2.mjs'), false);
  assert.equal(source.includes('live-benchmark-six-run-v2.mjs'), false);
  assert.equal(source.includes('live-benchmark-hypothesis-four-cli-v2.mjs'), false);
  assert.equal(source.includes('live-benchmark-hypothesis-four-run-v2.mjs'), false);
  assert.equal(source.includes('createAtMostNOpenRouterFetch'), false);
  assert.equal(source.includes('process.env'), false);
});
```

- [ ] **Step 2: Run engine tests and confirm RED**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs
```

Expected RED: `ERR_MODULE_NOT_FOUND` for `./live-benchmark-engine-v2.mjs`, or missing named exports. Not a test syntax error. After stub exports exist, remaining RED must be the named check (invalid `profileId`, dataset identity, budget mismatch, prompt byte cap, packet alignment), not `options must be a plain object` and not a missing required outer key.

- [ ] **Step 3: Implement the shared engine**

Create `scripts/memory-v3-pilot/live-benchmark-engine-v2.mjs`.

Must:

- Import only profiles-v2 plus frozen V2 modules listed in the dependency map.
- Inspect options as JSON-data-only. Required keys exactly: `dataset`, `profileId`, `model`, `extractorVersion`, `budget`, `maxPromptRequestBytesPerCase`, `execute`. Optional: `apiKey`, `fetchImpl`. Unknown keys fail. Getters fail.
- Read `options.profileId` only as an own enumerable string data descriptor. Do not execute getters. Then call `getLiveBenchmarkProfileV2` with that primitive string.
- Compare `options.model`, `options.extractorVersion`, and `options.maxPromptRequestBytesPerCase` to the canonical profile. Compare the six non-cap `options.budget` keys with strict equality. Accept `maxBudgetUsd` as a finite number `<= canonical.maxBudgetUsd` that still passes `assertBudgetGate` (rejects below the computed ceiling and above the canonical hard maximum before HTTP).
- Select Golden cases in canonical `caseIds` order. Dataset may contain other cases.
- Measure `buildExtractorRequestV2` bytes against `canonical.maxPromptRequestBytesPerCase`.
- `assertBudgetGate(options.budget)` and `configuredBudget.absoluteMaxRequests === canonical.maxRequests`.
- Dry-run: HTTP 0, `cases = canonical.caseIds.map((caseId) => ({ caseId }))`, `aggregate` null, `actualUsage` null, `actualCostUsd` null, `maxActive` 1, `semanticReview.status === "required"`.
- Execute: require `fetchImpl` and `apiKey`. Wrap with `createProfileBoundedOpenRouterFetch(fetchImpl, primitiveProfileId)`. Transport timeout and byte cap from the profile. Adapter: `responseContract: "v2"`, `allowFallbacks: canonical.allowFallbacks`, `maxTokensParameter: canonical.maxTokensParameter`, `maxOutputTokens: canonical.maxOutputTokensPerCase`, `reasoningEffort: canonical.reasoningEffort`, `model: canonical.model`. Pass subset `cases` in canonical order to `runOfflineBenchmarkV2` with `budget.caseCount === subset.cases.length === canonical.caseCount`.
- Brand engine errors with `canonical.engineErrorPrefix` and `canonical.engineErrorName`.
- Bounded fetch: primitive `profileId` only; lookup via `getLiveBenchmarkProfileV2`; follow the locked HTTP cap algorithm (check `callCount >= canonical.maxRequests` before increment; increment; then inner fetch once; inner throw still counts). Public text is `canonical.httpCapError`. Ignore extra arguments. Reject a second argument that is not a primitive allowlisted string. Require POST to `https://openrouter.ai/api/v1/chat/completions`. Expose `callCount` as an own enumerable getter.
- Packet builder required keys exactly `profileId`, `dataset`, `benchmarkResult`. Same identity rules. Align cases to canonical order. Messages `{ id, role, text }` only.
- Project diagnostics through existing WeakSet helpers and the V2 extractor allowlist already used by six-case V2.
- Do not export `createAtMostNOpenRouterFetch`.

- [ ] **Step 4: Targeted GREEN**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs
node --check scripts/memory-v3-pilot/live-benchmark-engine-v2.mjs
```

Expected: pass. fail 0.

- [ ] **Step 5: Characterization plus full regression**

Run Task 1 characterization and full glob. Expected: fail 0. Rerun the Task 1 Frozen SHA256 command, including spec and artifact hashes. Artifact untracked and unmodified.

- [ ] **Step 6: STOP for Codex review**

Do not stage, commit, or push.

---

### Task 4: Six-case engine compatibility wrapper

**Files:**
- Modify: `scripts/memory-v3-pilot/live-benchmark-six-v2.mjs`
- Test: existing `live-benchmark-six-v2.test.mjs` (do not edit)

**Interfaces:**
- Consumes: `runProfileLiveBenchmarkV2`, `buildProfileSemanticReviewPacketV2`, `createProfileBoundedOpenRouterFetch`
- Produces: unchanged public six-case engine exports

- [ ] **Step 1: Characterization RED lock before editing**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-six-v2.test.mjs
```

Expected: fail 0. If this is already red, stop and fix Task 3. Do not weaken assertions.

- [ ] **Step 2: Replace the six-case engine body with a wrapper**

Keep these exports with the same names:

- `SIX_CASE_BENCHMARK_V2_CASE_IDS`
- `SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION`
- `createAtMostSixOpenRouterFetch`
- `runSixCaseLiveBenchmarkV2`
- `buildSixCaseSemanticReviewPacketV2`

Implementation:

- Import only `./live-benchmark-profiles-v2.mjs` and `./live-benchmark-engine-v2.mjs`.
- `SIX_CASE_BENCHMARK_V2_CASE_IDS` must remain a frozen array of the six ids in the listed order. Either export `getLiveBenchmarkProfileV2('six-category-v2').caseIds` (same registry reference is allowed) or a local freeze of the same six strings. Do not change the export name.
- `SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION` remains the exact string `memory-v3-openrouter-gemini-3.7-flash-six-v2`.
- `runSixCaseLiveBenchmarkV2(options)` inspects the current public keys only (`dataset`, `model`, `extractorVersion`, `budget`, `maxPromptRequestBytesPerCase`, `execute`, optional `apiKey`, `fetchImpl`). Unknown keys still fail. It must not accept `profile` or `profileId` from the caller. Internally call `runProfileLiveBenchmarkV2({ ...inspected, profileId: 'six-category-v2' })`.
- `buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult })` calls `buildProfileSemanticReviewPacketV2({ dataset, benchmarkResult, profileId: 'six-category-v2' })`.
- `createAtMostSixOpenRouterFetch(fetchImpl)` returns `createProfileBoundedOpenRouterFetch(fetchImpl, 'six-category-v2')`.
- Public errors of the wrapper itself, if any unknown-option failures happen before delegation, keep prefix `[memory-v3:live-benchmark-six-v2]` and name `MemoryV3SixCaseBenchmarkV2Error`.

- [ ] **Step 3: Targeted GREEN**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-six-v2.test.mjs
node --check scripts/memory-v3-pilot/live-benchmark-six-v2.mjs
```

Expected: fail 0. If a characterization assertion fails, fix the wrapper or shared engine, not the test.

- [ ] **Step 4: Full regression**

Run characterization of all three six-case test files plus `node --test scripts/memory-v3-pilot/*.test.mjs`. Expected: fail 0. Rerun the Task 1 Frozen SHA256 command.

- [ ] **Step 5: STOP for Codex review**

Do not stage, commit, or push.

---

### Task 5: Shared CLI and thin CLI wrappers

**Files:**
- Create: `scripts/memory-v3-pilot/live-benchmark-cli-v2.test.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-cli-v2.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.test.mjs`
- Modify: `scripts/memory-v3-pilot/live-benchmark-six-cli-v2.mjs`
- Test: existing `live-benchmark-six-cli-v2.test.mjs` (do not edit)

**Interfaces:**
- Consumes: `getLiveBenchmarkProfileV2`, `runProfileLiveBenchmarkV2`
- Produces: `runProfileBenchmarkFromArgvV2`; six and hypothesis-four CLI wrappers

- [ ] **Step 1: Write failing shared CLI and hypothesis-four CLI tests**

`live-benchmark-cli-v2.test.mjs`:

```javascript
import { runProfileBenchmarkFromArgvV2 } from './live-benchmark-cli-v2.mjs';

describe('runProfileBenchmarkFromArgvV2', () => {
  it('dry-run six-category-v2 does not read env or fetch', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = async () => {
      throw new Error('env should not be read');
    };
    const result = await runProfileBenchmarkFromArgvV2({
      argv: ['--model', MODEL, '--max-budget-usd', '0.11'],
      dataset: loadGoldenDataset(),
      profileId: 'six-category-v2',
      fetchImpl,
      readEnvText,
    });
    assert.equal(result.providerHttpCalls, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects unknown flags, six/hypothesis execute cross-use, and --profile with zero HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    await assert.rejects(() =>
      runProfileBenchmarkFromArgvV2({
        argv: ['--model', MODEL, '--max-budget-usd', '0.11', '--profile', 'six-category-v2'],
        dataset,
        profileId: 'six-category-v2',
        fetchImpl,
      }),
    );
    await assert.rejects(() =>
      runProfileBenchmarkFromArgvV2({
        argv: ['--model', MODEL, '--max-budget-usd', '0.11', '--execute-hypothesis-four-paid-requests'],
        dataset,
        profileId: 'six-category-v2',
        fetchImpl,
      }),
    );
    await assert.rejects(() =>
      runProfileBenchmarkFromArgvV2({
        argv: ['--model', MODEL, '--max-budget-usd', '0.075', '--execute-six-paid-requests'],
        dataset,
        profileId: 'hypothesis-four-v2',
        fetchImpl,
      }),
    );
    await assert.rejects(() =>
      runProfileBenchmarkFromArgvV2({
        argv: ['--model', MODEL, '--max-budget-usd', '0.11', '--api-key', 'x'],
        dataset,
        profileId: 'six-category-v2',
        fetchImpl,
      }),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects invalid profileId descriptors before env and HTTP', async () => {
    const fetchImpl = recordingFetch();
    let envReads = 0;
    const readEnvText = async () => {
      envReads += 1;
      return 'OPENROUTER_API_KEY=test-memory-v3-profile-v2-key\n';
    };
    const base = {
      argv: [
        '--model',
        MODEL,
        '--max-budget-usd',
        '0.11',
        '--env-file',
        'masked.env',
        '--execute-six-paid-requests',
      ],
      dataset: loadGoldenDataset(),
      profileId: 'six-category-v2',
      fetchImpl,
      readEnvText,
    };
    for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      await assert.rejects(() =>
        runProfileBenchmarkFromArgvV2(withProfileIdDescriptor(base, kind, probe)),
      );
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
    }
    assert.equal(envReads, 0);
    assert.equal(fetchImpl.calls.length, 0);
    const valid = withProfileIdDescriptor(
      {
        argv: ['--model', MODEL, '--max-budget-usd', '0.11'],
        dataset: loadGoldenDataset(),
        profileId: 'six-category-v2',
        fetchImpl,
        readEnvText,
      },
      'valid-own-enumerable-string',
      { getterCalls: 0, setterCalls: 0 },
    );
    const dry = await runProfileBenchmarkFromArgvV2(valid);
    assert.equal(dry.providerHttpCalls, 0);
    assert.equal(envReads, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('reads env once on execute and brands CLI errors from the profile', async () => {
    const fetchImpl = recordingFetch();
    let reads = 0;
    const result = await runProfileBenchmarkFromArgvV2({
      argv: [
        '--model',
        MODEL,
        '--max-budget-usd',
        '0.075',
        '--env-file',
        'masked.env',
        '--execute-hypothesis-four-paid-requests',
      ],
      dataset: loadGoldenDataset(),
      profileId: 'hypothesis-four-v2',
      fetchImpl,
      readEnvText: async () => {
        reads += 1;
        return 'OPENROUTER_API_KEY=test-memory-v3-profile-v2-key\n';
      },
    });
    assert.equal(reads, 1);
    assert.equal(fetchImpl.calls.length, 4);
    assert.equal(result.providerHttpCalls, 4);
    assertNoSecrets(result);
    await assert.rejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: ['--model', MODEL],
          dataset: loadGoldenDataset(),
          profileId: 'hypothesis-four-v2',
        }),
      (error) =>
        error.name === 'MemoryV3HypothesisFourBenchmarkCliV2Error' &&
        String(error.message).startsWith('[memory-v3:live-benchmark-hypothesis-four-cli-v2]'),
    );
  });
});
```

`live-benchmark-cli-v2.test.mjs` must copy `withProfileIdDescriptor` and the shared fixtures.

`live-benchmark-hypothesis-four-cli-v2.test.mjs` must import `runHypothesisFourBenchmarkFromArgvV2` from the thin wrapper and assert:

- dry-run argv is exactly `--model google/gemini-3.7-flash --max-budget-usd 0.075`
- execute flag is `--execute-hypothesis-four-paid-requests`
- `--execute-six-paid-requests` is rejected
- wrapper source imports only `live-benchmark-profiles-v2.mjs` and `live-benchmark-cli-v2.mjs`
- wrapper binds `profileId: "hypothesis-four-v2"` and does not accept a profile object

- [ ] **Step 2: Confirm RED**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-cli-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.test.mjs
```

Expected RED: missing modules or missing exports.

- [ ] **Step 3: Implement shared CLI and wrappers**

`runProfileBenchmarkFromArgvV2` required keys: `argv`, `dataset`, `profileId`. Optional: `fetchImpl`, `readEnvText`.

- Validate `options.profileId` as own enumerable string data descriptor, then `getLiveBenchmarkProfileV2`.
- Allowed argv flags exactly: `--model`, `--max-budget-usd`, `--env-file`, `canonical.executeFlag`.
- Reject `--api-key` and any argv token starting with `OPENROUTER_API_KEY`.
- `--model` must equal `canonical.model`. `--max-budget-usd` must equal `canonical.maxBudgetUsdArg` as a string.
- Dry-run: `runProfileLiveBenchmarkV2` with `execute: false` and the same `profileId`; do not read env; do not require `fetchImpl`.
- Execute: require `readEnvText` and `fetchImpl`; read env once; parse lines as in the spec (`\r?\n`, skip empty and `#`, `export NAME=value`, strip matching quotes, duplicate `OPENROUTER_API_KEY` fails, other names ignored); then `execute: true`.
- Brand with `canonical.cliErrorPrefix` / `canonical.cliErrorName`.
- Never put key, env path, or env body into errors.
- No fs, no `process.env`, no `globalThis.fetch`.

Thin six wrapper `runSixCaseBenchmarkFromArgvV2({ argv, dataset, fetchImpl?, readEnvText? })` calls shared CLI with `profileId: "six-category-v2"`. It must not add a `profile` field.

Thin hypothesis wrapper:

```
export async function runHypothesisFourBenchmarkFromArgvV2(options) {
  return runProfileBenchmarkFromArgvV2({
    argv: options.argv,
    dataset: options.dataset,
    fetchImpl: options.fetchImpl,
    readEnvText: options.readEnvText,
    profileId: 'hypothesis-four-v2',
  });
}
```

Inspect public keys the same way six-cli currently inspects `argv`/`dataset` plus optional fetch/readEnvText. Unknown `profile` fails.

- [ ] **Step 4: Targeted GREEN plus six-cli characterization**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-cli-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-six-cli-v2.test.mjs
node --check scripts/memory-v3-pilot/live-benchmark-cli-v2.mjs scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.mjs scripts/memory-v3-pilot/live-benchmark-six-cli-v2.mjs
```

Expected: fail 0. Do not edit `live-benchmark-six-cli-v2.test.mjs`.

- [ ] **Step 5: Full regression**

Run full glob and characterization of all three original six-case files. Rerun the Task 1 Frozen SHA256 command.

- [ ] **Step 6: STOP for Codex review**

Do not stage, commit, or push.

---

### Task 6: Shared safe-output run root and thin executables

**Files:**
- Create: `scripts/memory-v3-pilot/live-benchmark-run-v2.test.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-run-v2.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs`
- Create: `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.test.mjs`
- Modify: `scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs`
- Test: existing `live-benchmark-six-run-v2.test.mjs` (do not edit)

**Interfaces:**
- Consumes: `runProfileBenchmarkFromArgvV2`, `buildProfileSemanticReviewPacketV2`, `getLiveBenchmarkProfileV2`
- Produces: shared `main`; six and hypothesis-four composition roots

- [ ] **Step 1: Write failing shared-run and hypothesis-four-run tests**

Shared `main` required keys: `argv`, `readFileImpl`, `fetchImpl`, `writeStdout`, `writeStderr`, `profileId`. Optional: `writeFileImpl`, `linkImpl`, `unlinkImpl`, `accessImpl`.

Tests that must exist:

1. Import of `live-benchmark-run-v2.mjs` does not call `main` and does not call fetch.
2. Dry-run six-category-v2 loads Golden V2 once, HTTP 0, stdout one JSON object `{ benchmarkResult, semanticReviewPacket: null }`.
3. `--safe-output-file` without execute fails `safe-output-file requires execute` before env/HTTP.
4. Execute with `--safe-output-file`: `access(target)` then `access(target + ".tmp")`; both must be ENOENT via own enumerable data `error.code`; then env; then HTTP; then stdout serialize; then `writeFile(tmp, text, { encoding: "utf8", flag: "wx" })`; set `tempCreated` only after that write resolves; then `link(tmp, target)`; then `unlink(tmp)`.
5. Existing target fails `output file already exists` before env/HTTP and does not unlink.
6. Existing tmp fails `output file already exists` before env/HTTP and does not unlink the foreign tmp.
7. `link` EEXIST unlinks owned tmp only and does not replace the racing target.
8. Getter on `error.code` is not treated as ENOENT.
9. Public errors omit the output path, env path, and API key.
10. Full `profileId` descriptor matrix against otherwise valid shared `main` options. Copy `withProfileIdDescriptor`. Invalid kinds: getter, setter-only, non-enumerable, symbol-keyed, inherited. Valid kind: own enumerable string. Side effects that stay at 0 on invalid cases: `readFileImpl` calls, env reads inside `readFileImpl` for `.env`, `fetchImpl` calls, `writeFileImpl` calls, `linkImpl` calls, `unlinkImpl` calls.

```javascript
it('rejects invalid profileId descriptors before dataset, env, fetch, and fs', async () => {
  const counts = { read: 0, fetch: 0, write: 0, link: 0, unlink: 0, access: 0 };
  const base = {
    argv: [
      '--model',
      MODEL,
      '--max-budget-usd',
      '0.11',
      '--env-file',
      'C:\\synthetic\\.env',
      '--execute-six-paid-requests',
    ],
    profileId: 'six-category-v2',
    readFileImpl: async () => {
      counts.read += 1;
      return '{}';
    },
    fetchImpl: recordingFetch(),
    writeStdout: async () => {},
    writeStderr: async () => {},
    writeFileImpl: async () => {
      counts.write += 1;
    },
    linkImpl: async () => {
      counts.link += 1;
    },
    unlinkImpl: async () => {
      counts.unlink += 1;
    },
    accessImpl: async () => {
      counts.access += 1;
    },
  };
  for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
    const probe = { getterCalls: 0, setterCalls: 0 };
    await assert.rejects(() => main(withProfileIdDescriptor(base, kind, probe)));
    assert.equal(probe.getterCalls, 0);
    assert.equal(probe.setterCalls, 0);
  }
  assert.equal(counts.read, 0);
  assert.equal(base.fetchImpl.calls.length, 0);
  assert.equal(counts.write, 0);
  assert.equal(counts.link, 0);
  assert.equal(counts.unlink, 0);
  assert.equal(counts.access, 0);
  const valid = withProfileIdDescriptor(
    {
      argv: ['--model', MODEL, '--max-budget-usd', '0.11'],
      profileId: 'six-category-v2',
      readFileImpl: async () => REAL_GOLDEN_TEXT,
      fetchImpl: recordingFetch(),
      writeStdout: async (text) => {
        counts.stdout = text;
      },
      writeStderr: async () => {},
    },
    'valid-own-enumerable-string',
    { getterCalls: 0, setterCalls: 0 },
  );
  await main(valid);
  assert.equal(valid.fetchImpl.calls.length, 0);
});
```

Load Golden V2 bytes in the test file with:

```javascript
const REAL_GOLDEN_TEXT = readFileSync(new URL('./memory-v3-ru-golden.v2.json', import.meta.url), 'utf8');
```

The valid descriptor case is dry-run, so env and HTTP stay at 0.
11. Hypothesis-four dry-run command uses `--max-budget-usd 0.075` and `--execute-hypothesis-four-paid-requests` isolation.
12. Shared run source does not import six or hypothesis wrappers.
13. Hypothesis-four-run source imports only profiles-v2 and shared run.

Hypothesis-four public `main` injects `profileId: "hypothesis-four-v2"` and does not accept caller `profileId`. Direct command:

```
node scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.075
```

Spawn that dry-run in the test with injected absence of execute. Expect exit 0, no env, no network.

- [ ] **Step 2: Confirm RED**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-run-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.test.mjs
```

Expected RED: missing modules or missing `main`.

- [ ] **Step 3: Implement shared run and wrappers**

Preflight order from the spec, steps 1-9, then CLI 10-12.

Safe-output algorithm:

1. After stdout serialization of the exact payload, `writeFile(tempPath, text, { encoding: "utf8", flag: "wx" })`.
2. `tempCreated = true` only after that write resolves.
3. `link(tempPath, outputPath)`.
4. `unlink(tempPath)` of owned temp.
5. On failure after `tempCreated === true`, unlink owned temp only.
6. `link` EEXIST is generic `output file cannot be written`.

Forbidden: `rename` as publish, overwrite flags, retry, random temp names, writing the target directly, deleting a pre-existing temp.

`main` does not call `process.exit`. Direct-invocation sets `process.exitCode = 1` on failure. `globalThis.fetch` only in `runDirect`.

Re-export from shared run:

```
export { runProfileBenchmarkFromArgvV2 } from './live-benchmark-cli-v2.mjs';
export { buildProfileSemanticReviewPacketV2 } from './live-benchmark-engine-v2.mjs';
```

Six-run wrapper:

- Import profiles-v2 and shared run only.
- Public `main(options)` inspects current six-run keys (no `profileId` from caller) and calls shared `main` with `profileId: "six-category-v2"`.
- Define local aliases `runSixCaseBenchmarkFromArgvV2` and `buildSixCaseSemanticReviewPacketV2` as specified in Exact dependency map so `live-benchmark-six-run-v2.test.mjs` source greps stay GREEN.
- Keep branding `[memory-v3:live-benchmark-six-run-v2]` / `MemoryV3SixCaseBenchmarkRunV2Error` for wrapper-level option errors. Shared run uses `canonical.runErrorPrefix` after resolve.

Hypothesis-four-run wrapper binds `"hypothesis-four-v2"` the same way.

- [ ] **Step 4: Targeted GREEN plus six-run characterization**

Run:

```
node --test scripts/memory-v3-pilot/live-benchmark-run-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.test.mjs scripts/memory-v3-pilot/live-benchmark-six-run-v2.test.mjs
node --check scripts/memory-v3-pilot/live-benchmark-run-v2.mjs scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs
```

Expected: fail 0. If the six-run grep for `runSixCaseBenchmarkFromArgvV2` or `buildSixCaseSemanticReviewPacketV2` fails, add the local aliases. Do not import `live-benchmark-six-v2.mjs` or `live-benchmark-six-cli-v2.mjs`.

- [ ] **Step 5: Full regression**

Run all three original six-case files plus full glob. Rerun the Task 1 Frozen SHA256 command. Artifact still untracked.

- [ ] **Step 6: STOP for Codex review**

Do not stage, commit, or push.

---

### Task 7: README and full offline regression/privacy gate

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Test: none new; reuse existing plus new tests from Tasks 2-6

**Interfaces:**
- Consumes: dry-run commands already implemented
- Produces: README text that documents hypothesis-four dry-run without claiming a paid run

- [ ] **Step 1: Write the README addition as a testable contract in this step**

Insert a new subsection whose heading is exactly:

```
### V2 hypothesis-four dry-run
```

Place it immediately after the existing `### V2 six-case dry-run` subsection and before the next heading that matches `^#{2,3} `. All hypothesis-four claims below must appear inside that subsection only.

The subsection body must contain these exact strings:

- `node scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.075`
- `memv3-ru-hypothesis-01`
- `memv3-ru-hypothesis-02`
- `memv3-ru-hypothesis-03`
- `memv3-ru-hypothesis-04`
- `memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2`
- `$0.067152`
- `$0.075`
- `0 provider HTTP calls`
- `does not read .env`
- `--execute-hypothesis-four-paid-requests`
- `later explicit authorization from Nastya`

The subsection must not contain:

- `paid run was executed`
- `full-24`

Keep the six-case dry-run command in the six-case subsection:

```
node scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.11
```

Do not mention artifact bytes or API keys.

- [ ] **Step 2: README scoped presence check**

Run:

```
node --input-type=module -e "import { readFileSync } from 'node:fs'; const t=readFileSync('scripts/memory-v3-pilot/README.md','utf8'); const heading='### V2 hypothesis-four dry-run'; const start=t.indexOf(heading); if (start<0) process.exit(1); const rest=t.slice(start+heading.length); const next=rest.search(/\n#{2,3} /); const section=rest.slice(0, next<0?rest.length:next); const need=['node scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.075','memv3-ru-hypothesis-01','memv3-ru-hypothesis-02','memv3-ru-hypothesis-03','memv3-ru-hypothesis-04','memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2','$0.067152','$0.075','0 provider HTTP calls','does not read .env','--execute-hypothesis-four-paid-requests','later explicit authorization from Nastya']; for (const s of need) { if (!section.includes(s)) process.exit(1);} if (section.includes('paid run was executed')) process.exit(1); if (section.includes('full-24')) process.exit(1); const sixHead=t.indexOf('### V2 six-case dry-run'); if (sixHead<0) process.exit(1); const sixRest=t.slice(sixHead+'### V2 six-case dry-run'.length); const sixNext=sixRest.search(/\n#{2,3} /); const sixSec=sixRest.slice(0, sixNext<0?sixRest.length:sixNext); if (sixSec.includes('live-benchmark-hypothesis-four-run-v2.mjs')) process.exit(1);"
```

Expected: exit 0. A match only in a V1 section or only in the six-case subsection is a failure.

- [ ] **Step 3: Full offline regression and privacy gate**

Run:

```
node --test scripts/memory-v3-pilot/*.test.mjs
```

Expected: fail 0. Totals must be at least Task 1 characterization plus the new test files.

Then:

```
node --check scripts/memory-v3-pilot/live-benchmark-profiles-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-engine-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-cli-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-run-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-six-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-six-cli-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.mjs
node --check scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs
git diff --check
```

Expected: no whitespace errors.

Import-cycle / wrapper leak grep:

```
node --input-type=module -e "import { readFileSync } from 'node:fs'; const files=['live-benchmark-profiles-v2.mjs','live-benchmark-engine-v2.mjs','live-benchmark-cli-v2.mjs','live-benchmark-run-v2.mjs']; for (const f of files) { const t=readFileSync('scripts/memory-v3-pilot/'+f,'utf8'); if (t.includes('live-benchmark-six-v2.mjs') && f!=='live-benchmark-six-v2.mjs') process.exit(1); if (t.includes('live-benchmark-hypothesis-four-cli-v2.mjs')) process.exit(1); if (t.includes('live-benchmark-hypothesis-four-run-v2.mjs')) process.exit(1); if (t.includes('createAtMostNOpenRouterFetch')) process.exit(1);} "
```

Expected: exit 0. Shared files must not import wrappers.

Rerun the Task 1 Frozen SHA256 command. Spec hash must remain `69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A`. Artifact hash must remain `4C853A7FF2DEDDB2AE544DCE767B039F9E7A5DBC16B437CBDD1AB9DE76DD93FB`.

- [ ] **Step 4: STOP for Codex review**

Do not stage, commit, or push.

---

### Task 8: Final STOP without paid benchmark

**Files:**
- Create: none
- Modify: none

**Interfaces:**
- Consumes: completed Tasks 1-7
- Produces: a written stop report

- [ ] **Step 1: Confirm no paid path was taken**

Do not run `live-benchmark-six-run-v2.mjs` or `live-benchmark-hypothesis-four-run-v2.mjs` with `--execute-six-paid-requests` or `--execute-hypothesis-four-paid-requests`. Do not pass `--env-file`. Do not read `.env`. Do not call OpenRouter.

- [ ] **Step 2: Confirm git hygiene**

Run:

```
git status --short
```

Artifact must remain:

```
?? scripts/memory-v3-pilot/_tmp-live-benchmark-six-v2-gemini-20260902.json
```

It must not be staged.

- [ ] **Step 3: Write the stop report**

The report must include:

- six-case characterization still GREEN
- new tests GREEN
- full glob fail 0
- Frozen SHA256 unchanged, including spec `69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A`
- artifact SHA256 unchanged
- no paid run
- no claim that hypothesis-four was executed live

- [ ] **Step 4: STOP for Codex review**

Do not stage, commit, or push unless Codex later authorizes that as a separate step. This task is not that authorization.

---

## Out of this plan: future human gate for hypothesis-four paid execute

This section is not Task 9 and must not be executed while implementing Tasks 1-8.

A later explicit authorization from Nastya is required before any hypothesis-four paid command. If and only if that later authorization exists, the command shape is:

```
node scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.075 --env-file ENV_ABSOLUTE_PATH --execute-hypothesis-four-paid-requests --safe-output-file OUTPUT_ABSOLUTE_JSON_PATH
```

`ENV_ABSOLUTE_PATH` is an absolute `.env` path supplied only under that later authorization. `OUTPUT_ABSOLUTE_JSON_PATH` is an absolute `.json` path. This plan does not name a real env path or a real output path.

Constraints of that future gate, recorded here so they are not invented later:

- at most 4 sequential POSTs
- `--safe-output-file` required for that paid run
- no retry
- no second command
- this plan is not that authorization
- this spec is not that authorization

Do not add a paid step to Tasks 1-8.

---

## Self-review

### Spec requirement to plan task

| Spec requirement | Plan task |
|------------------|-----------|
| Characterization of six-case V2 tests; do not weaken assertions | Task 1, then Tasks 4-7 |
| Frozen profile registry; exact own keys; no nested `budget` | Task 2 |
| Direct lookup primitive string; reject object/`String`/array/null/symbol/unknown | Task 2 |
| Object APIs: own enumerable `options.profileId`; no getter execution | Tasks 3, 5, 6 descriptor matrix |
| Reject profile clone as `options.profileId`; reject unknown field `profile` | Task 3 |
| HTTP cap: check `callCount >= N` before increment; inner throw counts | Task 3 |
| Engine preflight negatives (dataset, model, budget, bytes) with 0 HTTP | Task 3 |
| Hypothesis-four packet alignment and packet case-set rejects | Task 3 |
| Spec SHA256 lock `69CE05EFF0508DF7098F06C0AEA263AF3049992039B214CE39C0EEB1C907424A` | Task 1, rechecked Tasks 2-8 |
| README claims scoped to `### V2 hypothesis-four dry-run` | Task 7
| `createProfileBoundedOpenRouterFetch(fetchImpl, profileId)` reads N and error text from registry | Task 3 |
| Keep `createAtMostSixOpenRouterFetch(fetchImpl)` as six wrapper | Task 4 |
| Six-category engine exports, flags, prefixes, stdout schema | Tasks 4, 5, 6 |
| Hypothesis-four ids, extractorVersion, N=4, `$0.067152` / `$0.075` | Tasks 2, 3, 5, 6 |
| Sequential `maxActive=1`, continue after failure, no retry | Task 3 |
| Packet order equals canonical `caseIds`; review verdicts stay null | Task 3 |
| Shared CLI argv/env parser; execute-flag isolation | Task 5 |
| Safe-output preflight target+tmp before env/HTTP; wx; link; owned tmp | Task 6 |
| Six-run local aliases keep characterization greps GREEN | Task 6 |
| README dry-run only; no paid claim | Task 7 |
| Full offline regression, `node --check`, `git diff --check`, wrapper-import grep | Task 7 |
| Final STOP without paid benchmark | Task 8 |
| Future hypothesis-four paid execute is a human gate | Out of this plan |
| Full-24 not implemented | Global Constraints, Task 2 allowlist, Task 7 README |
| Frozen modules and artifact unchanged | Task 1 lock, rechecked Tasks 2-8 |
| `actualUsage` / `actualCostUsd` remain null | Task 3 |
| Shared modules never import wrappers | Tasks 2-6, grep in Task 7 |
| Engine/CLI/run branding from canonical profile | Tasks 2, 3, 5, 6 |

### Signature, field, flag, budget, branding check

- Shared signatures in Locked signatures match the spec.
- Profile own-key list has 29 keys and matches both exact tables.
- `options.budget` has seven keys. Six non-cap fields strictly equal canonical. `maxBudgetUsd` is a finite caller cap from the computed ceiling through `canonical.maxBudgetUsd`.
- Six flags remain `--model`, `--max-budget-usd`, `--env-file`, `--execute-six-paid-requests`, plus composition-root `--safe-output-file`.
- Hypothesis-four flags remain `--model`, `--max-budget-usd 0.075`, `--env-file`, `--execute-hypothesis-four-paid-requests`, plus composition-root `--safe-output-file`.
- Six ceiling `0.100728` / hard `0.11`; hypothesis ceiling `0.067152` / hard `0.075`.
- Branding strings are copied verbatim from the spec into Task 2 tests.

### Import cycles

- profiles-v2 imports nothing from engine/CLI/run/wrappers.
- engine imports profiles plus frozen V2 libraries.
- CLI imports profiles plus engine.
- run imports CLI plus engine plus `node:fs/promises` / `node:path`.
- wrappers import profiles plus one shared module.
- six-run does not import six-v2 or six-cli.
- No shared file imports a wrapper.

### Task 3 negative coverage

| Check | Expected failure | HTTP |
|-------|------------------|------|
| `profileId: { ...canonical }` inside valid options | invalid profileId, not missing dataset | 0 |
| `profileId: Object.freeze({ ...canonical })` | invalid profileId | 0 |
| `profileId: structuralCopy` | invalid profileId | 0 |
| unknown field `profile` | unknown option | 0 |
| getter/setter/non-enumerable/symbol/inherited `profileId` | descriptor reject, getterCalls 0 | 0 |
| wrong `datasetId` | dataset identity | 0 |
| wrong dataset `version` | dataset identity | 0 |
| missing selected case | case selection | 0 |
| duplicate selected case | case selection | 0 |
| reversed `dataset.cases` still canonical `caseIds` | GREEN dry-run order lock | 0 |
| wrong `model` | model mismatch vs canonical | 0 |
| wrong `extractorVersion` | extractor mismatch vs canonical | 0 |
| missing/extra/mismatched `options.budget` field | budget contract | 0 |
| `maxPromptRequestBytesPerCase` not equal to canonical | field mismatch | 0 |
| prompt bytes above 20000 with matching cap field | prompt preflight | 0 |
| sparse `cases` and getter `model` | JSON-data-only options | 0 |
| packet `profileId` clone | invalid profileId, no packet returned | n/a |
| packet descriptor matrix | no packet returned | n/a |
| hypothesis-four packet order | four hypothesis ids | n/a |
| packet duplicate/missing/extra/reordered cases | packet alignment | n/a |
| packet model/extractor mismatch | packet identity | n/a |
| HTTP cap inner throw | `callCount` incremented, later 7th blocked, inner not called on 7th | n/a |

### Placeholder scan

Removed from this plan: `TODO`, `TBD`, `implement later`, `similar to`, `spec-aligned`, and unspecified placeholders. JavaScript spread in tests is `{ ...canonicalProfile }` as required by the spec, not a missing section.

---

## Execution notes for later Codex review

This file is the implementation plan only. Writing it is not authorization to implement, commit, push, or pay.
