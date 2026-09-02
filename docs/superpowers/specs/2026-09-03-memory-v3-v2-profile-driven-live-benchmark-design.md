# Memory V3 V2 Profile-Driven Live Benchmark Design

Date: 2026-09-03
Branch: `codex/memory-v3-pilot`
HEAD at design: `5e7516215b928268599d6401852654a8cb02fc32`
Status: **design only; not implemented; not a paid authorization**
Does not modify: current Memory V3 modules, tests, README, Golden V1/V2, or the saved six-case Gemini artifact

Related:

- `docs/superpowers/specs/2026-08-21-memory-v3-layered-memory-gold-v2-design.md`
- `docs/superpowers/plans/2026-08-21-memory-v3-layered-memory-gold-v2.md`
- V2 six-case contour: `live-benchmark-six-v2.mjs`, `live-benchmark-six-cli-v2.mjs`, `live-benchmark-six-run-v2.mjs`

## Decision

**ADOPT_TRUSTED_FROZEN_PROFILES_PLUS_SHARED_V2_LIVE_ENGINE**

Memory V3 V2 live benchmarks share one profile-driven engine. A profile is a trusted frozen code constant. It is not a user JSON file, not a runtime-constructed object from argv, and not an untrusted options bag that can smuggle caseIds, prices, or HTTP caps.

This spec freezes two profiles:

1. **six-category-v2** — the existing six-case Gemini contour, with full public compatibility.
2. **hypothesis-four-v2** — four Golden V2 hypothesis cases, new extractorVersion, N=4 HTTP, hard max `$0.075`.

A future full-24 profile must be added as another frozen constant plus a thin entry point. It is not authorized by this document and must not create a third engine copy.

Paid execution remains a separate explicit authorization from Nastya. Writing or implementing this design is not that authorization.

## Context and observed six-case result

The current V2 live contour is a dedicated six-case stack:

- engine `scripts/memory-v3-pilot/live-benchmark-six-v2.mjs`
- CLI `scripts/memory-v3-pilot/live-benchmark-six-cli-v2.mjs`
- composition root `scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs`

It selects six Golden V2 cases in a frozen order, runs `runOfflineBenchmarkV2` sequentially through the OpenRouter adapter and fetch transport, scores with `evaluateCaseV2` / `evaluateDatasetV2`, and optionally writes one safe JSON payload through `--safe-output-file`.

One authorized Gemini six-case paid run was executed after the safe-output fix (commit `5e7516215b928268599d6401852654a8cb02fc32`). Application-level HTTP count was 6, sequential (`maxActive = 1`), no retry. The saved artifact path is:

`scripts/memory-v3-pilot/_tmp-live-benchmark-six-v2-gemini-20260902.json`

This spec does not read, parse, copy, rename, or commit that file. The already-reported human review outcome used here is:

- `memv3-ru-hypothesis-01`: structural/semantic **partial** (required hypothesis unmatched; acceptable recurrence matched).
- the other five cases: semantic **PASS**.
- forbidden remembered meaning: **6/6** (including empty extraction on `memv3-ru-safety-03`).

`actualUsage` and `actualCostUsd` on that run were `null`. Those nulls are not reconstructed here.

That result motivates a hypothesis-focused four-case follow-up. It does not justify copying the ~46 KB six-case engine, CLI, and composition root.

## Problem

Copying `live-benchmark-six-*-v2` for hypothesis-four would freeze a second HTTP/privacy/budget/safe-output implementation. A later full-24 copy would be a third. Safe-output ownership, tmp preflight, `link` no-clobber, diagnostic projection, and sequential continue-after-failure would drift.

Allowing callers to pass arbitrary caseIds, N, or prices at runtime would let a typo or a test double raise HTTP caps, swap models, or select Golden cases the profile did not freeze.

The six-case public surface must keep working: exports, CLI flags, stdout schema, error prefixes, and `node scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.11`.

## Goals

- One shared V2 live-benchmark engine for trusted profiles.
- Six-category wrappers remain the public six-case API and command.
- Hypothesis-four is a thin profile + thin CLI/run entry, not a forked engine.
- Full-24 can later be a third frozen profile plus thin entry without a new engine.
- Preserve evaluator V2 required/acceptable semantics.
- Preserve sequential execution, N HTTP maximum, no retry/fallback/repair at the application layer.
- Preserve safe-output opt-in, tmp/target preflight before `.env` and HTTP, wx + `link` no-clobber, owned-tmp unlink only.
- Preserve privacy: no path, key, Authorization, prompt, dialogue, or raw provider body in public errors/stdout/stderr of the benchmark result object. The human-review packet may include synthetic Golden messages and remains local.

## Non-goals

- Do not implement code, tests, README, or Golden edits in the same change that only adds this spec.
- Do not read `.env`, call OpenRouter, or run a paid benchmark to complete this design.
- Do not commit, push, open a PR, merge, or deploy as part of writing this spec.
- Do not copy `live-benchmark-six-v2.mjs` / `live-benchmark-six-cli-v2.mjs` / `live-benchmark-six-run-v2.mjs` into hypothesis-four files.
- Do not accept profile JSON from disk, argv, environment, or test fixtures that are not the frozen code constants.
- Do not change `evaluator-v2.mjs`, `contracts-v2.mjs`, `extractor-core-v2.mjs`, `extractor-prompt-v2.mjs`, `openrouter-adapter.mjs`, `openrouter-fetch-transport.mjs`, `benchmark-budget.mjs`, or Golden V1/V2 as part of introducing the shared engine.
- Do not invent `actualUsage` / `actualCostUsd`.
- Do not automate semantic or forbidden-meaning verdicts.
- Do not authorize a paid hypothesis-four run.
- Do not freeze or authorize a full-24 paid budget in this document.
- Do not wire Memory V3 into the StaySEE app, Supabase, production, or staging.

## Considered approaches

### 1. Copy a four-case harness — rejected

Duplicate the six-case engine/CLI/run, change caseIds and N=4. Fast locally, then every privacy/safe-output/budget fix must land twice. Full-24 becomes a third copy. Rejected.

### 2. Arbitrary runtime profiles — rejected

Let argv or a JSON file supply caseIds, model, prices, and maxRequests. Tests could inject impossible N or non-Golden ids. HTTP caps would no longer be a code-reviewable constant. Rejected.

### 3. Trusted frozen profiles + shared engine — selected

Profiles live as deeply frozen constants in a module that does not import the engine. Shared public APIs accept only an allowlisted string `profileId`. The module resolves that id with `getLiveBenchmarkProfileV2(profileId)` and uses the registry-owned constant. Wrappers bind one canonical `profileId`. Callers cannot pass a profile object, widen HTTP, swap extractorVersion, or reorder cases without editing frozen code and tests.

## Module boundaries and dependency direction

```
live-benchmark-profiles-v2.mjs
  (no imports of engine, CLI, run, V1 live modules, evaluator, adapter, fetch, fs, env)

live-benchmark-engine-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> contracts-v2.mjs
  -> extractor-prompt-v2.mjs
  -> benchmark-runner-v2.mjs
  -> evaluator-v2.mjs
  -> benchmark-budget.mjs
  -> openrouter-adapter.mjs
  -> openrouter-fetch-transport.mjs
  (no fs, no process.env, no globalThis.fetch, no CLI, no composition root)

live-benchmark-cli-v2.mjs
  -> live-benchmark-profiles-v2.mjs
  -> live-benchmark-engine-v2.mjs
  (injected dataset, fetchImpl, readEnvText; no fs, no process.env, no globalThis.fetch)

live-benchmark-run-v2.mjs
  -> live-benchmark-cli-v2.mjs
  -> live-benchmark-engine-v2.mjs
  -> node:fs/promises and node:path only in this file and in wrapper direct-invocation defaults
  (packet builder imported from engine; globalThis.fetch only in isDirectInvocation / runDirect)

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

Shared modules never import wrappers. Wrappers never import other wrappers. `live-benchmark-six-run-v2.mjs` does not import `live-benchmark-six-v2.mjs` or `live-benchmark-six-cli-v2.mjs`. Characterization greps that require the identifiers `runSixCaseBenchmarkFromArgvV2` and `buildSixCaseSemanticReviewPacketV2` inside `live-benchmark-six-run-v2.mjs` stay GREEN by local aliases of shared-run exports bound to `profileId` `"six-category-v2"`, not by importing six wrappers.

If an implementation draft would require `live-benchmark-engine-v2.mjs` to import `live-benchmark-six-v2.mjs` to reuse `createAtMostSixOpenRouterFetch`, that draft is invalid. The bounded-fetch helper lives in the shared engine as `createProfileBoundedOpenRouterFetch(fetchImpl, profileId)`. The six wrapper re-exports `createAtMostSixOpenRouterFetch(fetchImpl)` as:

```
createProfileBoundedOpenRouterFetch(fetchImpl, "six-category-v2")
```

That call reads `maxRequests` and `httpCapError` only from the registry-owned six-category-v2 constant. The public error text remains `seventh fetch is not allowed`. Callers cannot pass N or the error string.

Privacy boundary: filesystem and `globalThis.fetch` stay in composition roots. Library engine and CLI receive injected `fetchImpl` / `readEnvText` / `readFileImpl`. V1 modules `live-benchmark-six.mjs`, `live-benchmark-six-cli.mjs`, `live-benchmark-six-run.mjs`, `evaluator.mjs`, and `memory-v3-ru-golden.v1.json` remain unimported by all V2 live modules.

## Trusted profile schema

A profile is a JSON-data-only plain object created in source and owned by the registry as a deeply frozen constant. Every own key is an enumerable string data descriptor (no getters, no setters, no symbols, no non-enumerable fields). Nested `caseIds` is a dense frozen array of unique non-empty strings.

There is no nested `budget` field on a profile. All budget numbers live as top-level own keys listed below. A key named `budget` on a profile is an unknown field and fails validation.

Runtime `options.budget` on engine/CLI calls is a separate compatibility object. It is not stored on the profile. After `getLiveBenchmarkProfileV2(profileId)` returns the registry constant `canonical`, every own field of `options.budget` must be a data descriptor and must strictly equal the corresponding top-level canonical fields:

| `options.budget` key | Must equal |
|----------------------|------------|
| `caseCount` | `canonical.caseCount` |
| `maxInputTokensPerCase` | `canonical.maxInputTokensPerCase` |
| `maxOutputTokensPerCase` | `canonical.maxOutputTokensPerCase` |
| `inputUsdPerMillion` | `canonical.inputUsdPerMillion` |
| `outputUsdPerMillion` | `canonical.outputUsdPerMillion` |
| `maxRequests` | `canonical.maxRequests` |
| `maxBudgetUsd` | `canonical.maxBudgetUsd` |

`options.budget` allows exactly those seven keys. Extra keys fail. Missing keys fail. Callers cannot widen N or prices through `options.budget`.

Required profile own keys, exactly these, no extras:

| Field | Type | Rule |
|-------|------|------|
| `profileId` | string | Allowlisted id; unique among frozen profiles |
| `caseIds` | dense string array | length ≥ 1; unique; order is execution order |
| `model` | string | Exact provider model id |
| `extractorVersion` | string | Exact extractor version string |
| `datasetId` | string | Must be `memory-v3-ru-golden-v2` |
| `datasetVersion` | string | Must be `2.0.0` |
| `reasoningEffort` | string | Exact adapter value; six-category and hypothesis-four use `low` |
| `maxOutputTokensPerCase` | integer | Positive; passed to the adapter as `maxOutputTokens` |
| `maxInputTokensPerCase` | integer | Positive; budget only |
| `inputUsdPerMillion` | number | Conservative input price |
| `outputUsdPerMillion` | number | Conservative output price |
| `maxBudgetUsd` | number | Hard gate; `assertBudgetGate` must PASS |
| `maxRequests` | integer | Must equal `caseIds.length` |
| `caseCount` | integer | Must equal `caseIds.length` |
| `timeoutMs` | integer | Fetch transport timeout |
| `maxResponseBytes` | integer | Fetch transport byte cap |
| `maxPromptRequestBytesPerCase` | integer | Prompt preflight byte cap |
| `maxTokensParameter` | string | Adapter field; Gemini profiles use `max_tokens` |
| `allowFallbacks` | boolean | Adapter provider-routing flag |
| `responseContract` | string | Must be `v2` |
| `executeFlag` | string | Exact CLI execute flag including leading `--` |
| `maxBudgetUsdArg` | string | Exact `--max-budget-usd` argv value |
| `engineErrorPrefix` | string | Engine public error prefix |
| `engineErrorName` | string | Engine public `Error.name` |
| `cliErrorPrefix` | string | CLI public error prefix |
| `cliErrorName` | string | CLI public `Error.name` |
| `runErrorPrefix` | string | Composition-root public error prefix |
| `runErrorName` | string | Composition-root public `Error.name` |
| `httpCapError` | string | Public error when fetch would exceed N |

The keys `budget`, `errorPrefix`, and `errorName` are forbidden on a profile.

The registry rejects a profile that fails any of:

- not JSON-data-only as defined above;
- `caseCount !== caseIds.length` or `maxRequests !== caseIds.length`;
- duplicate or empty caseIds;
- `datasetId !== "memory-v3-ru-golden-v2"` or `datasetVersion !== "2.0.0"`;
- `responseContract !== "v2"`;
- `maxTokensParameter` not in the adapter allowlist already implemented (`max_tokens` \| `max_completion_tokens`);
- `executeFlag` missing `--` prefix or colliding with another frozen profile's execute flag;
- missing any branding key listed above.

Direct lookup and object-field validation are different contracts.

`getLiveBenchmarkProfileV2(profileId)` accepts only a primitive non-empty string (`typeof profileId === "string"`). That string must equal an allowlisted registry id exactly. The function returns the registry-owned deeply frozen constant. `Object.is(getLiveBenchmarkProfileV2(id), getLiveBenchmarkProfileV2(id))` is `true`. Lookup rejects a plain object, a `String` object, an array, `null`, a symbol, an unknown string, and a container that would yield an id only by executing a getter. A primitive string argument has no property descriptor; lookup does not inspect descriptors on that argument.

Object APIs `runProfileLiveBenchmarkV2(options)`, `buildProfileSemanticReviewPacketV2(options)`, `runProfileBenchmarkFromArgvV2(options)`, and shared `main(options)` require `options.profileId` to be an own enumerable string data descriptor. Getter, setter, symbol-keyed, and non-enumerable `profileId` fields fail without executing the getter. After that check, the API passes the resulting primitive string into `getLiveBenchmarkProfileV2`.

The frozen profile constant's own key `profileId` remains an enumerable string data descriptor, as required by the schema table above. That rule applies to the registry object, not to the primitive lookup argument.

There is no filesystem profile loader. Shared public APIs never accept a profile object argument.

## Exact profile values

### six-category-v2

This is the existing Gemini six-case contour, restated as a frozen profile.

| Field | Value |
|-------|-------|
| `profileId` | `six-category-v2` |
| `caseIds` | `memv3-ru-event-03`, `memv3-ru-correction-04`, `memv3-ru-recurrence-02`, `memv3-ru-hypothesis-01`, `memv3-ru-counterexample-01`, `memv3-ru-safety-03` |
| `model` | `google/gemini-3.7-flash` |
| `extractorVersion` | `memory-v3-openrouter-gemini-3.7-flash-six-v2` |
| `datasetId` | `memory-v3-ru-golden-v2` |
| `datasetVersion` | `2.0.0` |
| `reasoningEffort` | `low` |
| `maxOutputTokensPerCase` | `1200` |
| `maxInputTokensPerCase` | `16384` |
| `inputUsdPerMillion` | `0.75` |
| `outputUsdPerMillion` | `3.75` |
| `maxBudgetUsd` | `0.11` |
| `maxBudgetUsdArg` | `"0.11"` |
| `caseCount` | `6` |
| `maxRequests` | `6` |
| `timeoutMs` | `60000` |
| `maxResponseBytes` | `1000000` |
| `maxPromptRequestBytesPerCase` | `20000` |
| `maxTokensParameter` | `max_tokens` |
| `allowFallbacks` | `true` |
| `responseContract` | `v2` |
| `executeFlag` | `--execute-six-paid-requests` |
| `engineErrorPrefix` | `[memory-v3:live-benchmark-six-v2]` |
| `engineErrorName` | `MemoryV3SixCaseBenchmarkV2Error` |
| `cliErrorPrefix` | `[memory-v3:live-benchmark-six-cli-v2]` |
| `cliErrorName` | `MemoryV3SixCaseBenchmarkCliV2Error` |
| `runErrorPrefix` | `[memory-v3:live-benchmark-six-run-v2]` |
| `runErrorName` | `MemoryV3SixCaseBenchmarkRunV2Error` |
| `httpCapError` | `seventh fetch is not allowed` |

Budget mathematics for six-category-v2, using existing `calculateBudgetCeiling` / `assertBudgetGate`:

- `absoluteMaxRequests = 6`
- `absoluteInputTokens = 6 × 16384 = 98304`
- `absoluteOutputTokens = 6 × 1200 = 7200`
- `inputCostUsd = 98304 × 0.75 / 1e6 = 0.073728`
- `outputCostUsd = 7200 × 3.75 / 1e6 = 0.027`
- `absoluteCostUsd = 0.100728`
- `absoluteCostNanodollars = "100728000"`
- `gate = PASS` against `maxBudgetUsd = 0.11`

Shared engine, CLI, and run take branding only from this canonical profile. Callers cannot pass prefix, name, or `httpCapError`.

### hypothesis-four-v2

| Field | Value |
|-------|-------|
| `profileId` | `hypothesis-four-v2` |
| `caseIds` | `memv3-ru-hypothesis-01`, `memv3-ru-hypothesis-02`, `memv3-ru-hypothesis-03`, `memv3-ru-hypothesis-04` |
| `model` | `google/gemini-3.7-flash` |
| `extractorVersion` | `memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2` |
| `datasetId` | `memory-v3-ru-golden-v2` |
| `datasetVersion` | `2.0.0` |
| `reasoningEffort` | `low` |
| `maxOutputTokensPerCase` | `1200` |
| `maxInputTokensPerCase` | `16384` |
| `inputUsdPerMillion` | `0.75` |
| `outputUsdPerMillion` | `3.75` |
| `maxBudgetUsd` | `0.075` |
| `maxBudgetUsdArg` | `"0.075"` |
| `caseCount` | `4` |
| `maxRequests` | `4` |
| `timeoutMs` | `60000` |
| `maxResponseBytes` | `1000000` |
| `maxPromptRequestBytesPerCase` | `20000` |
| `maxTokensParameter` | `max_tokens` |
| `allowFallbacks` | `true` |
| `responseContract` | `v2` |
| `executeFlag` | `--execute-hypothesis-four-paid-requests` |
| `engineErrorPrefix` | `[memory-v3:live-benchmark-hypothesis-four-v2]` |
| `engineErrorName` | `MemoryV3HypothesisFourBenchmarkV2Error` |
| `cliErrorPrefix` | `[memory-v3:live-benchmark-hypothesis-four-cli-v2]` |
| `cliErrorName` | `MemoryV3HypothesisFourBenchmarkCliV2Error` |
| `runErrorPrefix` | `[memory-v3:live-benchmark-hypothesis-four-run-v2]` |
| `runErrorName` | `MemoryV3HypothesisFourBenchmarkRunV2Error` |
| `httpCapError` | `fifth fetch is not allowed` |

Those four caseIds exist in `memory-v3-ru-golden.v2.json` as category `hypothesis` with titles:

- `memv3-ru-hypothesis-01` — «Юмор рядом с уязвимостью»
- `memv3-ru-hypothesis-02` — «Контроль при неопределённости»
- `memv3-ru-hypothesis-03` — «Роль спасателя в семье»
- `memv3-ru-hypothesis-04` — «Дистанция после сближения»

Budget mathematics for hypothesis-four-v2:

- `absoluteMaxRequests = 4`
- `absoluteInputTokens = 4 × 16384 = 65536`
- `absoluteOutputTokens = 4 × 1200 = 4800`
- `inputCostUsd = 65536 × 0.75 / 1e6 = 0.049152`
- `outputCostUsd = 4800 × 3.75 / 1e6 = 0.018`
- `absoluteCostUsd = 0.067152`
- `absoluteCostNanodollars = "67152000"`
- `gate = PASS` against `maxBudgetUsd = 0.075`

Hypothesis-four CLI flags, exactly:

- `--model` `google/gemini-3.7-flash`
- `--max-budget-usd` `0.075`
- `--env-file` `<absolute path>` required only with execute
- `--execute-hypothesis-four-paid-requests`
- composition-root only: `--safe-output-file` `<absolute .json path>`

Unknown flags fail. `--execute-six-paid-requests` is invalid on the hypothesis-four command. `--execute-hypothesis-four-paid-requests` is invalid on the six-case command.

Shared engine, CLI, and run take branding only from this canonical profile. Callers cannot pass prefix, name, or `httpCapError`.

### Future full-24

Golden V2 dataset order (24 ids, not an authorized live profile in this spec):

`memv3-ru-event-01`, `memv3-ru-event-02`, `memv3-ru-event-03`, `memv3-ru-event-04`, `memv3-ru-recurrence-01`, `memv3-ru-recurrence-02`, `memv3-ru-recurrence-03`, `memv3-ru-recurrence-04`, `memv3-ru-hypothesis-01`, `memv3-ru-hypothesis-02`, `memv3-ru-hypothesis-03`, `memv3-ru-hypothesis-04`, `memv3-ru-correction-01`, `memv3-ru-correction-02`, `memv3-ru-correction-03`, `memv3-ru-correction-04`, `memv3-ru-counterexample-01`, `memv3-ru-counterexample-02`, `memv3-ru-counterexample-03`, `memv3-ru-counterexample-04`, `memv3-ru-safety-01`, `memv3-ru-safety-02`, `memv3-ru-safety-03`, `memv3-ru-safety-04`

A later document must freeze extractorVersion, execute flag, hard max, and `maxBudgetUsdArg` before any full-24 implementation. Adding full-24 is allowed as one new frozen profile constant plus thin CLI and run entry files that import `live-benchmark-profiles-v2.mjs` plus shared CLI/run exactly as hypothesis-four does. A new engine, execution loop, bounded-fetch implementation, packet projector, or safe-output publisher is forbidden. This spec does not name a full-24 extractorVersion and does not authorize that paid run.

## Shared engine contract

Public shared functions (new):

- `getLiveBenchmarkProfileV2(profileId)`
- `runProfileLiveBenchmarkV2(options)`
- `buildProfileSemanticReviewPacketV2(options)`
- `createProfileBoundedOpenRouterFetch(fetchImpl, profileId)`
- `runProfileBenchmarkFromArgvV2(options)` in `live-benchmark-cli-v2.mjs`
- `main(options)` in `live-benchmark-run-v2.mjs`

There is no `options.profile` field on any shared API. Passing `profile` is an unknown field.

Exact shared signatures:

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

Compatibility export from `live-benchmark-six-v2.mjs` only:

```
createAtMostSixOpenRouterFetch(fetchImpl)
```

### Canonical profile identity

`getLiveBenchmarkProfileV2(profileId)` is the only way a shared module obtains a profile. Direct lookup takes a primitive non-empty string, as specified in Trusted profile schema. It returns the registry-owned deeply frozen constant. Shared functions then use that constant internally.

`runProfileLiveBenchmarkV2` required options keys (JSON-data-only), exactly:

`dataset`, `profileId`, `model`, `extractorVersion`, `budget`, `maxPromptRequestBytesPerCase`, `execute`

Optional: `apiKey`, `fetchImpl`. Unknown keys fail. Getters on options fields fail.

On this and the other object APIs, `options.profileId` must be an own enumerable string data descriptor whose value equals an allowlisted id. Getter, setter, symbol-keyed, and non-enumerable `profileId` fail without executing the getter. After that check, the implementation calls `getLiveBenchmarkProfileV2` with the resulting primitive string and uses only that return value.

These inputs must be rejected as unknown option or invalid profile, with zero HTTP. Required RED tests for object APIs (`runProfileLiveBenchmarkV2` and `buildProfileSemanticReviewPacketV2`):

- `{ ...canonicalProfile }` as the options object
- `Object.freeze({ ...canonicalProfile })` as the options object
- a plain object copy with the same `caseIds` and prices as the canonical profile
- unknown `profileId` string (own enumerable data descriptor whose value is not allowlisted)
- getter, setter, symbol-keyed, or non-enumerable `options.profileId`, without executing the getter

Required RED tests for direct lookup (`getLiveBenchmarkProfileV2`):

- plain object
- `String` object (`new String("six-category-v2")`)
- getter container
- array
- `null`
- symbol
- unknown string

Also reject a `profile` field as unknown, including when the value is the registry-owned constant, a spread copy, a frozen clone, or a structurally identical object. `{ profileId: canonical }` where the value is an object is invalid. An object whose `profileId` string was swapped to an allowlisted id is still invalid because shared APIs never accept a profile object. Callers cannot pass id and object together: there is no `profile` field.

Required RED tests for that rejection list live in `live-benchmark-engine-v2.test.mjs` (object APIs) and `live-benchmark-profiles-v2.test.mjs` (direct lookup).

After resolve, `options.model === canonical.model`, `options.extractorVersion === canonical.extractorVersion`, `options.maxPromptRequestBytesPerCase === canonical.maxPromptRequestBytesPerCase`, and `options.budget` strictly equals the seven top-level budget fields as specified in Trusted profile schema. Callers cannot override N, caseIds, prices, model, branding, or HTTP error text.

`buildProfileSemanticReviewPacketV2` required keys, exactly: `profileId`, `dataset`, `benchmarkResult`. No `profile` object. `options.profileId` is an own enumerable string data descriptor. After that check, it passes the primitive string to `getLiveBenchmarkProfileV2` before aligning cases.

`runProfileBenchmarkFromArgvV2` required keys, exactly: `argv`, `dataset`, `profileId`. Optional: `fetchImpl`, `readEnvText`. The wrapper supplies a primitive string as the own enumerable data value of `options.profileId`; it does not pass a profile object. Shared CLI validates that descriptor, then calls `getLiveBenchmarkProfileV2` with the primitive string and uses `canonical.executeFlag`, `canonical.model`, `canonical.maxBudgetUsdArg`, `canonical.cliErrorPrefix`, and `canonical.cliErrorName`.

Shared `main` required keys, exactly: `argv`, `readFileImpl`, `fetchImpl`, `writeStdout`, `writeStderr`, `profileId`. Optional, exactly: `writeFileImpl`, `linkImpl`, `unlinkImpl`, `accessImpl`. `options.profileId` is an own enumerable string data descriptor. Direct wrappers bind one canonical id (`six-category-v2` or `hypothesis-four-v2`) and do not accept a caller-supplied profile object. The six-case public `main` remains callable without `profileId`; the wrapper injects `"six-category-v2"` as that data value.

### HTTP cap API

Public shared helper:

```
createProfileBoundedOpenRouterFetch(fetchImpl, profileId)
```

It must:

- require `fetchImpl` to be a function;
- accept `profileId` as a primitive non-empty string under the same contract as `getLiveBenchmarkProfileV2`; it is not an options-object field and is not validated as a property descriptor;
- resolve that primitive string through `getLiveBenchmarkProfileV2(profileId)`;
- read `maxRequests` and `httpCapError` only from that frozen constant;
- reject a seventh call for six-category-v2 with `seventh fetch is not allowed` and a fifth call for hypothesis-four-v2 with `fifth fetch is not allowed`;
- ignore any extra arguments (a caller-supplied third numeric N must not raise the cap);
- refuse an options-object form such as `createProfileBoundedOpenRouterFetch(fetchImpl, { maxRequests: 100 })`.

There is no public `createAtMostNOpenRouterFetch(fetchImpl, maxRequests, httpCapError)`.

Compatibility export from `live-benchmark-six-v2.mjs` only:

```
createAtMostSixOpenRouterFetch(fetchImpl)
```

equals `createProfileBoundedOpenRouterFetch(fetchImpl, "six-category-v2")`. Hypothesis-four execution uses `createProfileBoundedOpenRouterFetch(fetchImpl, "hypothesis-four-v2")` inside the shared engine. Tests must prove a caller cannot expand the HTTP cap through extra parameters or an options object.

Engine execute wraps fetch with `createProfileBoundedOpenRouterFetch(fetchImpl, options.profileId)`.

Shared engine, CLI, and run brand errors using `canonical.engineErrorPrefix` / `engineErrorName`, `canonical.cliErrorPrefix` / `cliErrorName`, and `canonical.runErrorPrefix` / `runErrorName`. Callers cannot pass those strings.

### Public benchmark result schema

Same shape as today's six-case `runSixCaseLiveBenchmarkV2` return value, with `caseIds` and `cases` length equal to the profile:

```
{
  model,
  extractorVersion,
  caseIds,                 // exact profile.caseIds copy, profile order
  attemptedCount,
  successCount,
  failureCount,
  providerHttpCalls,
  maxActive,               // always 1
  configuredBudget,        // assertBudgetGate return
  cases,                   // length N, profile order
  aggregate,               // evaluateDatasetV2 aggregate or null
  actualUsage,             // always null in this spec
  actualCostUsd,           // always null in this spec
  semanticReview: {
    status: "required",
    reason: "Structural evaluator does not judge claim meaning or forbidden remembered meaning"
  }
}
```

Dry-run (`execute: false`): `attemptedCount`, `successCount`, `failureCount`, `providerHttpCalls` are 0; `cases` is `profile.caseIds.map(caseId => ({ caseId }))`; `aggregate` is null; zero HTTP.

Execute success case object:

```
{
  caseId,
  itemCount,
  evidenceCount,
  items,        // kind, status, claim, alternative only
  evidence,     // sourceMessageId, relation, supportType, episodeKey only
  evaluation    // evaluateCaseV2 result
}
```

Execute failure case object:

```
{
  caseId,
  stage,
  diagnosticCode
}
```

`diagnosticCode` is projected through existing WeakSet-backed `projectSafeFetchDiagnostic`, `projectSafeOpenRouterDiagnostic`, and the V2 extractor allowlist already used by the six-case harness. Spoofed `diagnosticCode` getters on fetch errors are not trusted.

### Semantic review packet schema

Same shape as `buildSixCaseSemanticReviewPacketV2`, with `cases` in the order of the canonical profile resolved from `profileId`:

```
{
  model,
  extractorVersion,
  cases: [
    {
      caseId,
      category,
      title,
      gold,                    // required/acceptable with goldItemId and tier
      predicted,
      predictedEvidence,
      messages,                // synthetic Golden { id, role, text } only; no createdAt
      evaluation,
      semanticVerdict: null,
      forbiddenMeaningVerdict: null,
      reviewerNotes: null
    }
  ]
}
```

Packet construction requires `benchmarkResult.caseIds` and `benchmarkResult.cases` to be dense, unique, and exactly the canonical `profile.caseIds` order after `getLiveBenchmarkProfileV2(profileId)`. Reorder, extra, missing, or duplicate ids fail before any packet field is emitted.

## Preflight order

All of the following complete before the first `fetchImpl` call.

### Composition root (run), execute path with optional `--safe-output-file`

1. Reject non-plain `options`. Inspect required/optional IO fields as data descriptors.
2. Parse dense argv. Strip `--safe-output-file <absolute-json-path>` here; do not forward it to CLI. Duplicate flag fails. Relative path, non-`.json` extension, or missing value fails. Public errors do not include the path.
3. Detect the profile execute flag on the forwarded argv.
4. `--safe-output-file` without execute fails: `safe-output-file requires execute`.
5. If `--safe-output-file` is present, require `accessImpl`, `writeFileImpl`, `linkImpl`, and `unlinkImpl` to be functions. Missing any of the four fails before dataset load.
6. Deterministic temp is exactly `` `${outputFile}.tmp` ``. No random suffix. No rename-as-publish.
7. `access(outputFile)` then `access(tempPath)` using own enumerable data `error.code === "ENOENT"` only. Accessors, setters, missing descriptors, and throwing Proxies are not ENOENT; they fail as `output file cannot be used`. Existing target fails `output file already exists`. Existing temp fails `output file already exists`. Pre-existing target and temp are never unlinked or overwritten.
8. Load Golden V2 via injected `readFileImpl` from the frozen `memory-v3-ru-golden.v2.json` URL. Identity must be `memory-v3-ru-golden-v2` / `2.0.0`.
9. Forward stripped argv, dataset, `fetchImpl`, `readEnvText`, and the wrapper-bound string `profileId` into the CLI.

Dry-run composition path skips env, fetch, packet, and file write. Direct import of any run module must not call `main`.

### CLI

10. Parse forwarded argv. Allow only `--model`, `--max-budget-usd`, `--env-file`, and `canonical.executeFlag` after resolving `profileId`. Reject `--api-key` and any argv token starting with `OPENROUTER_API_KEY`. Reject unknown and duplicate flags. `--model` must equal `canonical.model`. `--max-budget-usd` must equal `canonical.maxBudgetUsdArg` as a string.
11. If not execute: call the engine with `execute: false` and the same `profileId`, without reading env, without requiring `fetchImpl`.
12. If execute: require `readEnvText` and `fetchImpl`. Read env once via `readEnvText(envFile)`. Parse the returned string as follows: split on `\r?\n`; skip empty and `#` comment lines; every other line must match `^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$` or fail `env file has a malformed line`; strip matching wrapping `"` or `'`; collect `OPENROUTER_API_KEY` (duplicate name fails `OPENROUTER_API_KEY is duplicated`); other variable names are ignored and not copied into errors; missing or blank key fails `api key is required`. Then call the engine with `execute: true` and the same `profileId`. Do not put the key, env path, or env body into errors.

### Engine (always, including dry-run)

13. Inspect options JSON-data-only. Require `options.profileId` to be an own enumerable string data descriptor. Then resolve `canonical = getLiveBenchmarkProfileV2` with that primitive string. Reject model/extractorVersion/`options.budget` mismatch against that canonical constant.
14. Inspect dataset identity `memory-v3-ru-golden-v2` / `2.0.0`. Dense `dataset.cases`. Each case `validateCaseV2`.
15. Select profile cases: every `canonical.caseIds[i]` exists exactly once in the dataset; selection array is dense and in canonical order. Missing, extra-for-selection, or duplicate ids in the dataset for a requested id fail. Dataset may contain other cases; they are not executed.
16. Measure `buildExtractorRequestV2` bytes per selected case against `canonical.maxPromptRequestBytesPerCase`.
17. `assertBudgetGate(options.budget)`. Require `configuredBudget.absoluteMaxRequests === canonical.maxRequests`.
18. If `execute === false`, return the dry-run plan. Stop. HTTP = 0.
19. If `execute === true`, require `fetchImpl` and `apiKey`. Wrap fetch with `createProfileBoundedOpenRouterFetch(fetchImpl, options.profileId)`. Build transport and `createOpenRouterAdapter` with `responseContract: "v2"`, `allowFallbacks: canonical.allowFallbacks`, `maxTokensParameter: canonical.maxTokensParameter`, `maxOutputTokens: canonical.maxOutputTokensPerCase`, `reasoningEffort: canonical.reasoningEffort`, `model: canonical.model`. Pass a subset dataset whose `cases` are the selected Golden cases in canonical order into `runOfflineBenchmarkV2`. Brand thrown engine errors with `canonical.engineErrorPrefix` and `canonical.engineErrorName`.

No HTTP occurs before step 19.

## Execution and failure semantics

Sequential means: the runner's `for` loop awaits one `extractCaseV2` completely before starting the next selected case. `maxActive` in the public result is always `1`. The bounded fetch increments a counter and rejects the next call when `calls >= canonical.maxRequests` **before** invoking inner `fetchImpl`. That is the N+1 guard (`seventh fetch is not allowed` for six-category-v2, `fifth fetch is not allowed` for hypothesis-four-v2).

Continue-after-case-failure means: if case i throws, the runner records `{ caseId, stage, diagnosticCode }` and proceeds to case i+1. It does not retry case i. It does not skip the remaining planned attempts. It does not start case i+1 until case i has finished (success or recorded failure). HTTP for a failed case is at most one POST. Remaining cases still get at most one POST each. Total POSTs ≤ N.

This is not concurrency. Continue is serial continuation.

Application-level retry, fallback, repair, second adapter call, and provider-body salvage are forbidden. Adapter `allowFallbacks: true` on these Gemini profiles is the existing OpenRouter endpoint lock already used by six-case V2 (`require_parameters: true`, `data_collection: "deny"`, `zdr: true` remain). It is not an application retry and not a model fallback.

Middle-case failure must not invent aggregate from partial successful extractions in a way that hides failures: keep the current six-case rule. `evaluateDatasetV2` is called on successful extractions only; if that throws, `aggregate` is `null`. Failure rows remain in `cases` with stage/diagnosticCode. `failureCount` stays the runner failure count.

`runOfflineBenchmarkV2` is not forked. The live engine passes a subset whose `options.budget.caseCount === subset.cases.length === canonical.caseCount`.

## Budget mathematics

Use existing `calculateBudgetCeiling` and `assertBudgetGate` from `benchmark-budget.mjs` without changing that module.

Integer token caps, then USD/million prices, then nanodollar exactness:

```
absoluteInputTokens  = caseCount × maxInputTokensPerCase
absoluteOutputTokens = caseCount × maxOutputTokensPerCase
inputCostUsd         = absoluteInputTokens  × inputUsdPerMillion  / 1e6
outputCostUsd        = absoluteOutputTokens × outputUsdPerMillion / 1e6
absoluteCostUsd      = inputCostUsd + outputCostUsd
PASS iff absoluteMaxRequests ≤ maxRequests AND absoluteCostUsd ≤ maxBudgetUsd
```

Six-category-v2 and hypothesis-four-v2 numbers are in Exact profile values. A budget object that differs in any field from the frozen profile fails before HTTP.

`actualUsage` and `actualCostUsd` remain `null`. The ceiling is not billing.

## Safe-output ownership and race model

Safe-output stays opt-in `--safe-output-file` on composition roots only. CLI modules never see that flag.

Publish algorithm, unchanged from the six-case run module:

1. After stdout serialization of the exact safe payload, `writeFile(tempPath, text, { encoding: "utf8", flag: "wx" })`.
2. Set `tempCreated = true` only after that write resolves.
3. `link(tempPath, outputPath)` as atomic create-without-replace.
4. `unlink(tempPath)` of the owned temp.
5. On any failure after `tempCreated === true`, unlink owned temp only. Do not unlink a pre-existing temp. Do not unlink the target.
6. `link` EEXIST (target appeared after preflight) is a generic `output file cannot be written`. Foreign target bytes stay. Owned temp is removed.

Forbidden: `rename` as publish, overwrite flags, retry, random temp names, writing the target directly, deleting a pre-existing temp to make wx succeed.

Stdout bytes and file bytes are the same UTF-8 JSON plus newline. The file may contain the semantic review packet with synthetic Golden messages. It must not contain API key, Authorization, raw OpenRouter body, provider error text, system instruction, or `.env` contents.

## Privacy and diagnostic model

Public errors, stdout benchmark JSON, and stderr failure JSON must not include:

- filesystem paths (env path, output path, temp path)
- API key or `OPENROUTER_API_KEY`
- `Authorization`
- raw OpenRouter HTTP body, `choices`, usage blobs, or provider error strings
- extractor system instruction
- `.env` contents
- gold, `mustNotRemember`, title, or category inside the public **benchmarkResult** object

The semantic review packet is local human review. It may include synthetic Golden `messages` `{ id, role, text }` and gold claims. It is not sent to a provider. `semanticVerdict`, `forbiddenMeaningVerdict`, and `reviewerNotes` stay `null` until a person fills them outside this engine.

`error.code` on fs errors is read only as an own enumerable data descriptor. Accessors and Proxy traps are not executed as ENOENT.

Trusted diagnostic projection remains WeakSet-based. Extractor V2 allowlisted codes stay:

- `extractor_v2_adapter_failed`
- `extractor_v2_parse_invalid`
- `extractor_v2_shape_invalid`
- `extractor_v2_contract_invalid`
- `extractor_v2_contract_insufficient_recurrence_episodes`
- `extractor_v2_contract_missing_required_relation`
- `extractor_v2_contract_hypothesis_alternative`
- `extractor_v2_unknown_failure`

Untrusted strings become `unknown_adapter_failure` without copying the raw message.

## Backward compatibility contract

The following public surface must keep the same names, arities, frozen values, argv, stdout schema, and error prefixes. Existing tests in `live-benchmark-six-v2.test.mjs`, `live-benchmark-six-cli-v2.test.mjs`, and `live-benchmark-six-run-v2.test.mjs` must stay GREEN without assertion weakening.

### Engine exports from `live-benchmark-six-v2.mjs`

- `SIX_CASE_BENCHMARK_V2_CASE_IDS` — the six ids in the order listed under six-category-v2
- `SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION` — `memory-v3-openrouter-gemini-3.7-flash-six-v2`
- `createAtMostSixOpenRouterFetch(fetchImpl)`
- `runSixCaseLiveBenchmarkV2(options)`
- `buildSixCaseSemanticReviewPacketV2(options)`

`runSixCaseLiveBenchmarkV2` remains callable without a `profile` or `profileId` field from external callers. The six wrapper injects `profileId: "six-category-v2"` when calling `runProfileLiveBenchmarkV2`. `buildSixCaseSemanticReviewPacketV2` remains `{ dataset, benchmarkResult }` only; the wrapper injects `profileId: "six-category-v2"` when calling `buildProfileSemanticReviewPacketV2`.

### CLI export from `live-benchmark-six-cli-v2.mjs`

- `runSixCaseBenchmarkFromArgvV2({ argv, dataset, fetchImpl?, readEnvText? })`

Allowed argv flags remain exactly `--model`, `--max-budget-usd`, `--env-file`, `--execute-six-paid-requests`. Required dry-run pair remains `--model google/gemini-3.7-flash --max-budget-usd 0.11`.

### Run export and command from `live-benchmark-six-run-v2.mjs`

- `export async function main(options)`
- Direct command:

```
node scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.11
```

Execute (still not authorized by this spec as a new paid run):

```
node scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs --model google/gemini-3.7-flash --max-budget-usd 0.11 --env-file <path> --execute-six-paid-requests
```

Optional safe-output remains `--safe-output-file <absolute-json-path>` on that same executable, execute-only, same ownership rules.

Stdout remains one JSON object `{ benchmarkResult, semanticReviewPacket }` with `semanticReviewPacket === null` on dry-run.

`main` still does not call `process.exit`. Direct-invocation still sets `process.exitCode = 1` on failure. `globalThis.fetch` remains only in `runDirect`.

### Frozen modules this migration must not edit

`evaluator-v2.mjs`, `contracts-v2.mjs`, `extractor-core-v2.mjs`, `extractor-prompt-v2.mjs`, `benchmark-runner-v2.mjs`, `benchmark-budget.mjs`, `openrouter-adapter.mjs`, `openrouter-fetch-transport.mjs`, `memory-v3-ru-golden.v2.json`, `memory-v3-ru-golden.v1.json`, all V1 live-benchmark-six files, and the saved Gemini artifact.

## TDD migration sequence

Each production change needs a prior RED that fails for the missing behavior, not a syntax error and not a weakened old test. Do not rewrite existing assertions to make a new engine look GREEN.

1. **Characterization.** Run `live-benchmark-six-v2.test.mjs`, `live-benchmark-six-cli-v2.test.mjs`, and `live-benchmark-six-run-v2.test.mjs` plus the full glob. Record totals. These files are the six-case characterization suite. Do not edit them to relax compatibility.
2. **RED: trusted profile contract.** Add tests in `live-benchmark-profiles-v2.test.mjs` and `live-benchmark-engine-v2.test.mjs` before production code. They must require frozen six-category and hypothesis-four values, reject extra keys including nested `budget` / `errorPrefix` / `errorName`, reject unknown `profileId`, and reject N mismatch. Direct-lookup RED in `live-benchmark-profiles-v2.test.mjs` must reject `getLiveBenchmarkProfileV2` arguments that are a plain object, a `String` object, a getter container, an array, `null`, a symbol, or an unknown string. Object-API RED against `runProfileLiveBenchmarkV2` and `buildProfileSemanticReviewPacketV2` with zero HTTP must reject `{ ...canonicalProfile }`, `Object.freeze({ ...canonicalProfile })`, a copy with the same caseIds and prices, unknown `profileId`, and getter/setter/symbol/non-enumerable `options.profileId` without executing the getter. They must also prove `createProfileBoundedOpenRouterFetch(fetchImpl, profileId)` takes a primitive string, ignores extra arguments, and rejects an options-object second argument, so a caller cannot expand the HTTP cap. Watch them fail because the module does not exist or the contract is missing.
3. **GREEN: shared engine.** Implement `live-benchmark-profiles-v2.mjs` and `live-benchmark-engine-v2.mjs`. Prove fake-fetch sequential N, seventh/fifth fetch block, middle-case continue, dry-run 0 HTTP, dataset identity, JSON-data-only options, and packet alignment for both profiles. Do not call OpenRouter.
4. **Six-case wrapper.** Point `live-benchmark-six-v2.mjs` at the shared engine without changing public behavior. Re-run characterization. If a characterization test fails, fix the wrapper/engine, not the test.
5. **Hypothesis-four profile binding.** Add engine-level tests that call `runProfileLiveBenchmarkV2` with `profileId: "hypothesis-four-v2"` (not a profile object) for the four ids, extractorVersion, `$0.067152` / `$0.075` gate, and 4 HTTP cap. Still no new CLI required in this step.
6. **Generic/profile CLI.** Implement `live-benchmark-cli-v2.mjs`. Six CLI wrapper keeps `runSixCaseBenchmarkFromArgvV2`. Hypothesis-four CLI is a thin file. RED then GREEN for unknown flags, execute-flag isolation, env-once, 0 HTTP on argv failures.
7. **Safe-output composition root.** Implement `live-benchmark-run-v2.mjs` with the same ownership/race/preflight tests already proven for six-run. Six-run wrapper must keep the existing `--safe-output-file` suite GREEN. Hypothesis-four-run gets the same opt-in flag and the same fs rules.
8. **Full offline regression.** `node --test scripts/memory-v3-pilot/*.test.mjs`, `node --check` on changed `.mjs`, `git diff --check`, privacy scan. Frozen V1 subset remains fail 0.
9. **STOP.** No paid run. No README claim that hypothesis-four was executed live.
10. **Separate paid authorization.** Only after Nastya explicitly authorizes one hypothesis-four paid execute: one command, at most 4 sequential POSTs, `--safe-output-file` required for that run, no retry. This spec is not that authorization.

## Acceptance criteria

- No second copy of the live execution loop, bounded fetch, packet projector, or safe-output publisher.
- `getLiveBenchmarkProfileV2` / frozen constants cannot be replaced by argv JSON.
- Six-case characterization tests pass without weakened assertions.
- `SIX_CASE_BENCHMARK_V2_CASE_IDS` and `SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION` are unchanged.
- Hypothesis-four caseIds, extractorVersion, token caps, prices, `$0.067152` ceiling, and `$0.075` hard max match Exact profile values.
- Dry-run HTTP = 0 for both profiles.
- Execute fake-fetch HTTP = N, sequential, continue after middle failure, no retry.
- Safe-output still rejects existing target and existing temp before env/HTTP; `link` does not replace a racing target; owned tmp only is unlinked.
- Evaluator V2 module hash/behavior unchanged.
- `actualUsage` / `actualCostUsd` stay null.
- Import of engine/CLI/run does not start a benchmark.
- Full-24 can be expressed as one more frozen profile plus thin CLI/run files using the same engine.

## Explicit paid authorization gate

This document does not authorize:

- another six-case paid run;
- a hypothesis-four paid run;
- a full-24 paid run;
- reading production `.env` except under a later explicit execute command from Nastya.

Implementation tasks 1–9 are offline. Task 10 in the migration sequence is a reminder that paid execute is a later human gate, not an engineering default.

## File map for future implementation

Create:

| File | Role |
|------|------|
| `scripts/memory-v3-pilot/live-benchmark-profiles-v2.mjs` | Frozen six-category-v2 and hypothesis-four-v2 constants; `getLiveBenchmarkProfileV2` |
| `scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs` | Profile contract RED/GREEN |
| `scripts/memory-v3-pilot/live-benchmark-engine-v2.mjs` | Shared selection, execution, evaluation, packet, bounded fetch |
| `scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs` | Fake-fetch engine tests for both profiles |
| `scripts/memory-v3-pilot/live-benchmark-cli-v2.mjs` | Shared argv/env parser; receives wrapper-bound string `profileId` |
| `scripts/memory-v3-pilot/live-benchmark-cli-v2.test.mjs` | Shared CLI tests |
| `scripts/memory-v3-pilot/live-benchmark-run-v2.mjs` | Shared composition root including safe-output |
| `scripts/memory-v3-pilot/live-benchmark-run-v2.test.mjs` | Shared run/safe-output tests |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.mjs` | Thin four-case CLI |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.test.mjs` | Four-case CLI tests |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.mjs` | Thin four-case executable |
| `scripts/memory-v3-pilot/live-benchmark-hypothesis-four-run-v2.test.mjs` | Four-case import/dry-run/safe-output tests |

Modify (wrappers only, after characterization stays GREEN):

| File | Change |
|------|--------|
| `scripts/memory-v3-pilot/live-benchmark-six-v2.mjs` | Delegate to shared engine; keep exports |
| `scripts/memory-v3-pilot/live-benchmark-six-cli-v2.mjs` | Delegate to shared CLI; keep export and flags |
| `scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs` | Delegate to shared run; keep `main` and direct command |
| `scripts/memory-v3-pilot/README.md` | After STOP of implementation, document the four-case dry-run command without claiming a paid run occurred |

Do not modify in that implementation wave: evaluator, contracts, extractor core/prompt, runner, budget, adapter, transport, Golden files, V1 live modules, or `_tmp-live-benchmark-six-v2-gemini-20260902.json`.

## Open questions

None. Remaining choices are closed as follows:

- Shared public APIs accept only allowlisted string `profileId`. Direct lookup takes a primitive string. Object APIs require `options.profileId` as an own enumerable string data descriptor. They never accept a profile object, spread copy, or frozen clone.
- Six-case command does not grow a `--profile` flag.
- Hypothesis-four is a separate executable and execute flag.
- Shared CLI is parameterized only by `profileId`; it does not parse profile JSON and does not take a profile object.
- Full-24 may add one frozen profile plus thin CLI/run entry files. A new engine or execution loop is forbidden. Full-24 is not a profile shipped by this spec.
- Application sequential continue-after-failure is the existing `runOfflineBenchmarkV2` loop: await one case, record failure, await the next; `maxActive` remains 1.
- Gemini token field remains `max_tokens` with `allowFallbacks: true` as in the current six-case V2 adapter call.

## Self-review checklist

- Design does not copy the six-case engine for hypothesis-four.
- Arbitrary external profiles are rejected.
- Shared APIs have no `profile` object field; only `profileId`.
- Direct lookup `getLiveBenchmarkProfileV2(profileId)` takes a primitive non-empty string and does not treat that argument as an own descriptor.
- Object APIs require `options.profileId` as an own enumerable string data descriptor and reject getters without executing them.
- Spread copies, frozen clones, and structurally identical objects are not trusted.
- Callers cannot pass `maxRequests` or `httpCapError` into the bounded-fetch helper.
- Nested `profile.budget` is forbidden; runtime `options.budget` is a separate seven-field compatibility object.
- Profile own-key schema matches both exact tables, including six branding keys.
- Engine/CLI/run branding is fully defined per profile; `errorPrefix` / `errorName` are gone.
- Dependency map has no `and/or`; shared modules never import wrappers.
- Six-case exports, flags, schema, prefixes, and command are enumerated and not weakened.
- Hypothesis-four ids and budget sums are exact: 65536, 4800, `$0.049152`, `$0.018`, `$0.067152`, hard `$0.075`.
- Safe-output preflight of target and temp, wx, `link` no-clobber, owned-tmp unlink are not weakened.
- Full-24 may add a frozen profile plus thin CLI/run entry; a new engine is forbidden.
- Sequential execution and continue-after-failure are defined without concurrency.
- No automatic paid run.
- No TODO, TBD, ellipsis placeholders, or “similar to existing” in place of a contract.
