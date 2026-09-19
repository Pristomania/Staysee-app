# Memory V3 Synthetic Lifecycle Model Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, reproducible twelve-case benchmark that measures the production Memory V3 lifecycle reconciler on synthetic dialogue without reading or writing production user data.

**Architecture:** Add a frozen profile, a dataset preparation boundary, an injected-adapter benchmark engine, a strict CLI, and a no-clobber composition root. The engine replays authored predecessor steps locally to create an independent production-format prior state for each selected case, then exercises the existing production prompt, contract, reducer, and transport boundaries. All provider execution remains sequential, capped at twelve attempts, budget-gated before the first call, and unavailable without a separate explicit paid-run authorization.

**Tech Stack:** TypeScript, Node.js 24, `tsx`, `node:test`, existing Memory V3 lifecycle production modules, existing lifecycle evaluator, existing OpenRouter transport, SHA-256 via `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-09-19-memory-v3-synthetic-lifecycle-model-benchmark-design.md`

## Global Constraints

- Work only in `D:/Staisy-main Приложение/Staysee-memory-v3` on the current `codex/` branch.
- Do not read, hash, edit, stage, delete, or import any `scripts/memory-v3-pilot/_tmp-*.json` file.
- Do not stage `supabase/.temp/cli-latest`.
- Do not modify the production lifecycle prompt, contract, reducer, transport, stores, migrations, retention, allowlist, or model configuration.
- Do not modify `memory-v3-synthetic-lifecycle.v1.json`, Golden V1/V2 datasets, or the existing deterministic lifecycle evaluator/runner.
- Synthetic data only: no production user, conversation, message, state, or run identifiers.
- Library modules must not read files, environment variables, `process.env`, `Deno.env`, or `globalThis.fetch`.
- The composition root may use `globalThis.fetch` only during direct invocation; import must be side-effect free.
- Dry-run reads no env file and makes zero HTTP calls.
- Paid execution requires the exact `--execute-twelve-paid-requests` flag, exact profile/model/budget, an explicit env-file path, and a separate contemporaneous authorization from Nastya.
- Maximum provider attempts: 12; sequential only; maximum concurrency 1; retry 0; application fallback 0; repair 0.
- The thirteenth attempted call is rejected before the inner adapter/fetch; a rejected inner call still counts as one attempt.
- Validate all twelve datasets, prompt byte sizes, model, profile, and budget before the first provider call.
- Continue after an individual model-case failure because cases are independent; never retry the failed case.
- Public results and errors must not contain dialogue, claims, alternatives, prompts, raw model content, headers, keys, filesystem paths, proxy trap messages, or `cause`.
- The deterministic 20-scenario / 80-step / 240-message lifecycle suite remains authoritative and must stay green.
- No paid execution, Supabase write, deployment, PR, merge, or production/staging operation is part of this plan.
- End every task at a review checkpoint. Commit only after Nastya explicitly authorizes that task's commit.

---

## File map

### Create

- `scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.ts` — deeply frozen canonical profile and primitive-string lookup.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts` — exact values, freeze, lookup, and privacy tests.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.ts` — validate the existing JSON fixture, select exact steps, derive synthetic UUIDs, replay predecessor gold, and prepare independent cases.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts` — fingerprint, order, replay, aliasing, mutation, and source-lock tests.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark.ts` — preflight, adapter cap, sequential execution, production-boundary validation/reduction, safe evaluation, result projection, and local review packet.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts` — dry-run, fake execute, failure continuation, cap, spoofing, privacy, and hard-gate tests.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.ts` — exact argv contract, injected env text parsing, dry-run/execute orchestration.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts` — argv, env, zero-I/O preflight, fake execute, and privacy tests.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts` — local composition root, import safety, dataset/env reads, stdout/stderr, and optional no-clobber safe output.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts` — import, dry-run, fake execute, no-clobber, ownership, race, and output privacy tests.

### Modify

- `scripts/memory-v3-pilot/README.md` — document the synthetic lifecycle model benchmark, its dry-run command, limitations, and paid authorization gate.
- `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs` — add a documentation contract that locks the new README section without changing existing dataset assertions.

### Frozen inputs and production dependencies

- `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json`
- `scripts/memory-v3-pilot/lifecycle-evaluator.mjs`
- `scripts/memory-v3-pilot/lifecycle-runner.mjs`
- `scripts/memory-v3-pilot/benchmark-budget.mjs`
- `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`
- `supabase/functions/_shared/memoryV3/lifecycleContract.ts`
- `supabase/functions/_shared/memoryV3/lifecycleReducer.ts`
- `supabase/functions/_shared/memoryV3/lifecycleTransport.ts`

---

### Task 1: Lock the current baseline and frozen inputs

**Files:**
- Create: none
- Modify: none
- Test: existing lifecycle and Memory V3 test files

**Interfaces:**
- Consumes: current repository state and approved spec.
- Produces: recorded baseline totals and SHA-256 locks used at every later checkpoint.

- [ ] **Step 1: Verify repository isolation and status**

Run:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
git rev-parse --git-dir
git rev-parse --git-common-dir
```

Expected: correct worktree and branch; only previously known untracked protected artifacts may appear. Stop on any unexpected path.

- [ ] **Step 2: Run the deterministic lifecycle gate**

Run:

```powershell
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
```

Expected: 113 tests pass, 0 fail. If the total changed because reviewed tests were added later, record the fresh total and require 0 fail.

- [ ] **Step 3: Run the complete offline repository gate**

Run:

```powershell
node --test scripts/memory-v3-pilot/*.test.mjs
```

Expected: all tests pass. Record tests, suites, pass, and fail counts.

- [ ] **Step 4: Record frozen file hashes without touching protected output artifacts**

Run:

```powershell
Get-FileHash -Algorithm SHA256 @(
  'scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json',
  'scripts/memory-v3-pilot/lifecycle-evaluator.mjs',
  'scripts/memory-v3-pilot/lifecycle-runner.mjs',
  'scripts/memory-v3-pilot/benchmark-budget.mjs',
  'supabase/functions/_shared/memoryV3/lifecyclePrompt.ts',
  'supabase/functions/_shared/memoryV3/lifecycleContract.ts',
  'supabase/functions/_shared/memoryV3/lifecycleReducer.ts',
  'supabase/functions/_shared/memoryV3/lifecycleTransport.ts',
  'docs/superpowers/specs/2026-09-19-memory-v3-synthetic-lifecycle-model-benchmark-design.md'
)
```

Expected: nine hashes recorded. Do not include `_tmp-*.json` in this command.

- [ ] **Step 5: Confirm clean diff and stop for review**

Run:

```powershell
git diff --check
git diff --cached --name-status
git status --short
```

Expected: no staged changes and no new source changes. Do not commit Task 1.

---

### Task 2: Add the frozen twelve-case benchmark profile

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts`

**Interfaces:**
- Consumes: production lifecycle model/token constants from `lifecycleContract.ts` only for equality tests; the profile production file has no imports.
- Produces:

```ts
export const LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID =
  'lifecycle-reconciler-critical-twelve-v1' as const;

export interface LifecycleModelBenchmarkProfile {
  profileId: typeof LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID;
  datasetId: 'memory-v3-synthetic-lifecycle-v1';
  datasetVersion: '1.0.0';
  model: 'google/gemini-3.7-flash';
  reconcilerVersion: 'memory-v3-lifecycle-reconciler-v1';
  stepIds: readonly string[];
  caseCount: 12;
  maxRequests: 12;
  maxPromptRequestBytesPerCase: 80_000;
  maxInputTokensPerCase: 32_768;
  maxOutputTokensPerCase: 1_200;
  inputUsdPerMillion: 0.75;
  outputUsdPerMillion: 3.75;
  configuredCeilingUsd: '0.348912';
  maxBudgetUsd: 0.36;
  executeFlag: '--execute-twelve-paid-requests';
}

export function getLifecycleModelBenchmarkProfile(
  profileId: unknown,
): LifecycleModelBenchmarkProfile;
```

- [ ] **Step 1: Write profile tests before the production module exists**

Test these exact ordered step ids:

```ts
const EXPECTED_STEP_IDS = [
  'paraphrase-event-dedup-s02',
  'same-topic-distinct-events-s02',
  'event-date-correction-s03',
  'scope-narrowing-s03',
  'hypothesis-supported-s03',
  'hypothesis-rejected-s03',
  'recurrence-growth-s02',
  'pattern-confirmation-s03',
  'recurrence-stale-s03',
  'assistant-speculation-denied-s01',
  'prompt-injection-schema-s02',
  'layered-coexistence-s01',
] as const;
```

Assertions must cover all profile fields, exactly 16 own enumerable keys, `caseCount === stepIds.length`, deep freeze, stable object identity, and mutation failures.

- [ ] **Step 2: Add lookup rejection tests**

Use `assert.throws` for empty/unknown strings, arrays, plain objects, frozen profile clones, `new String(...)`, symbols, `null`, and getter containers. Assert getter count remains zero and rejected inputs remain unmodified.

- [ ] **Step 3: Run the targeted test and verify a real RED**

Run:

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for `lifecycle-model-benchmark-profile.ts`.

- [ ] **Step 4: Implement the minimal frozen registry**

Use a literal, recursive freeze, and exact primitive lookup:

```ts
const profile = deepFreeze({
  profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
  datasetId: 'memory-v3-synthetic-lifecycle-v1',
  datasetVersion: '1.0.0',
  model: 'google/gemini-3.7-flash',
  reconcilerVersion: 'memory-v3-lifecycle-reconciler-v1',
  stepIds: [...EXPECTED_STEP_IDS],
  caseCount: 12,
  maxRequests: 12,
  maxPromptRequestBytesPerCase: 80_000,
  maxInputTokensPerCase: 32_768,
  maxOutputTokensPerCase: 1_200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  configuredCeilingUsd: '0.348912',
  maxBudgetUsd: 0.36,
  executeFlag: '--execute-twelve-paid-requests',
});

export function getLifecycleModelBenchmarkProfile(profileId: unknown) {
  if (typeof profileId !== 'string' || profileId !== profile.profileId) {
    throw new Error('[memory-v3:lifecycle-model-profile] invalid profile id');
  }
  return profile;
}
```

Do not inspect properties of non-string inputs.

- [ ] **Step 5: Run targeted and regression tests**

Run:

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.ts
git diff --check
```

Expected: all pass and no whitespace errors.

- [ ] **Step 6: Verify frozen hashes and stop for review**

Repeat Task 1's hash command and confirm all nine hashes match. Show `git status --short`; only the two Task 2 files plus pre-existing protected artifacts may be untracked.

- [ ] **Step 7: Commit only after explicit authorization**

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts
git diff --cached --check
git commit -m "[agent] feat: add Memory V3 lifecycle benchmark profile"
```

---

### Task 3: Prepare independent production-format cases from the existing dataset

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts`

**Interfaces:**
- Consumes:

```ts
getLifecycleModelBenchmarkProfile(profileId: unknown): LifecycleModelBenchmarkProfile
createEmptyMemoryV3LifecycleState({ userId }): MemoryV3LifecycleState
applyMemoryV3LifecycleStep(input): Promise<LifecycleStepResult>
assignLifecycleItems({ expectedItems, actualItems }): { pairs: Pair[] }
```

- Produces:

```ts
export interface PreparedLifecycleModelCase {
  stepId: string;
  scenarioId: string;
  at: string;
  userId: string;
  conversationId: string;
  messages: MemoryV3DialogueMessage[];
  state: MemoryV3LifecycleState;
  extraction: MemoryV3Extraction;
  expectedProposal: MemoryV3LifecycleProposal;
  expectedState: { items: unknown[] };
  expectedTransitions: unknown[];
  mustNotRemember: string[];
}

export async function prepareLifecycleModelBenchmarkCases(options: {
  profileId: string;
  dataset: unknown;
}): Promise<readonly PreparedLifecycleModelCase[]>;
```

- [ ] **Step 1: Write tests for exact dataset identity and selection**

Load the JSON fixture only in the test. Assert dataset id/version, exactly 20 scenarios, 80 unique step ids, the frozen manifest hash, and the exact selected step order. Assert each selected id exists exactly once.

- [ ] **Step 2: Write tests for deterministic synthetic identifiers**

Lock this user id:

```ts
const SYNTHETIC_USER_ID = '11111111-1111-4111-8111-111111111111';
```

Conversation UUID algorithm:

```ts
const digest = createHash('sha256')
  .update(`memory-v3-lifecycle-benchmark:${scenarioId}`, 'utf8')
  .digest();
digest[6] = (digest[6] & 0x0f) | 0x40;
digest[8] = (digest[8] & 0x3f) | 0x80;
```

Format the first 16 bytes as an RFC 4122 UUID. Test stable values for all selected scenarios, uniqueness, and that none equals a repository production project ref or known account id.

- [ ] **Step 3: Write replay and independence tests**

For each selected step, assert:

- prior state is built by replaying only earlier authored steps from the same scenario;
- the selected step is not applied to `state`;
- `expectedProposal` is the authored selected proposal translated to production keys;
- applying `expectedProposal` yields a state structurally matched to authored `expectedState`;
- two prepared cases do not share state/item/evidence/message arrays;
- mutating a projected test clone does not mutate the raw dataset or another case;
- predecessor model failures cannot affect later selected cases because every case starts its own replay.

- [ ] **Step 4: Run targeted tests and verify a real RED**

Run:

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for the dataset module.

- [ ] **Step 5: Implement strict JSON-data inspection**

Implement plain-object/dense-array cloning with `Reflect.ownKeys`, own enumerable data descriptors, cycle rejection via `WeakSet`, fixed public error text, and no attacker-controlled property names in errors. Validate exact dataset, scenario, step, message, expected-state, expected-proposal, extraction, and trusted-forget shapes needed by the replay.

Use branded errors:

```ts
type DatasetDiagnostic =
  | 'lifecycle_model_dataset_invalid'
  | 'lifecycle_model_dataset_identity_mismatch'
  | 'lifecycle_model_dataset_selected_step_missing'
  | 'lifecycle_model_dataset_replay_failed';
```

Store trusted errors in a module-local `WeakSet`. Do not expose `cause`.

- [ ] **Step 6: Implement independent gold replay**

For a selected step:

1. Create empty production state for the fixed synthetic user.
2. Iterate preceding scenario steps in authored order.
3. Translate each authored proposal's gold target to its current `memoryKey`.
4. Translate trusted forget gold ids to current keys.
5. Call the production reducer.
6. Use `assignLifecycleItems` against that step's authored expected items to refresh `goldMemoryId -> memoryKey` mapping.
7. Stop before the selected step.
8. Translate the selected authored proposal with the resulting mapping.
9. Apply it once locally to derive the production-format expected state and transitions.

Never hand-calculate memory keys and never copy reducer logic.

- [ ] **Step 7: Add source locks**

Read the dataset module source in the test and assert the exact allowed import list is:

```text
node:crypto
./lifecycle-model-benchmark-profile.ts
./lifecycle-evaluator.mjs
./contracts.mjs
../../supabase/functions/_shared/memoryV3/contract.ts
../../supabase/functions/_shared/memoryV3/lifecycleContract.ts
../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts
../../supabase/functions/_shared/memoryV3/messages.ts
```

Reject imports of stores, Supabase clients, transport, env, CLI, filesystem, and global fetch.

- [ ] **Step 8: Run targeted, deterministic, and full tests**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.ts
git diff --check
```

Expected: all pass; deterministic lifecycle gate has no regressions.

- [ ] **Step 9: Verify frozen hashes and stop for review**

Repeat the Task 1 hash command. Confirm the source dataset and production modules are unchanged.

- [ ] **Step 10: Commit only after explicit authorization**

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts
git diff --cached --check
git commit -m "[agent] feat: prepare synthetic lifecycle benchmark cases"
```

---

### Task 4: Add the offline benchmark engine and safe evaluation

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts`

**Interfaces:**
- Consumes the Task 2 profile, Task 3 prepared cases, production prompt/contract/reducer/transport types, existing budget gate, and lifecycle evaluator.
- Produces:

```ts
export function createAtMostTwelveLifecycleAdapter(options: {
  adapter: MemoryV3LifecycleModelAdapter;
}): MemoryV3LifecycleModelAdapter & { readonly callCount: number };

export async function runLifecycleModelBenchmark(options: {
  profileId: string;
  dataset: unknown;
  model: string;
  budget: Record<string, unknown>;
  execute: boolean;
  adapter?: MemoryV3LifecycleModelAdapter;
}): Promise<LifecycleModelBenchmarkResult>;

export function buildLifecycleModelReviewPacket(options: {
  profileId: string;
  dataset: unknown;
  benchmarkResult: LifecycleModelBenchmarkResult;
}): LifecycleModelReviewPacket;
```

- [x] **Step 1: Write dry-run and preflight tests**

Test dry-run returns ordered twelve case ids, zero attempted/success/failure/provider calls, `aggregate: null`, `actualUsage: null`, `actualCostUsd: null`, and no adapter access.

Preflight rejects before calls:

- unknown/missing/clone profile id;
- wrong model;
- malformed/wrong dataset;
- duplicate/missing selected step;
- exact budget missing/extra/mismatch;
- prompt overflow in any one case;
- sparse arrays, symbols, accessors, non-enumerable fields, cycles, proxies, and revoked proxies;
- execute without adapter, or non-function adapter, only after all offline preflight checks pass.

- [x] **Step 2: Write bounded-adapter tests**

Assert calls 1–12 invoke the inner adapter, call 13 throws `[memory-v3:lifecycle-model-benchmark] thirteenth provider call is not allowed`, blocked call does not increment, and an inner rejection increments once. Inspect `callCount` through an own enumerable getter. Reject accessor/proxy options without invoking getters.

- [x] **Step 3: Write sequential success and middle-failure tests**

Fake success must perform exactly 12 adapter calls, `maxActive === 1`, and canonical start/end order. A case 6 adapter rejection must still attempt cases 7–12, result in 12 total attempts, 11 successes, 1 safe failure, and no retry.

- [x] **Step 4: Write production-boundary success fixtures**

The fake adapter receives each production request, selects the authored expected proposal from a test-only map, converts `candidateLocalItemKey`/`targetMemoryKey` back to the request's `candidateRef`/`memoryRef`, and returns JSON:

```ts
return {
  rawContent: JSON.stringify({ operations: modelOperations }),
  usage: null,
};
```

Assert the engine parses JSON, calls `validateMemoryV3LifecycleProposal`, applies `applyMemoryV3LifecycleStep`, and reports exact operations and exact state for all twelve cases.

- [x] **Step 5: Write hard quality-gate tests**

Lock PASS only when:

- attempted/success = 12 and failure = 0;
- every operation set and target is exact;
- every resulting state is exact;
- all four critical step ids are exact;
- forbidden, assistant-only, duplicate-active, superseded-active, deleted-remnant, deleted-resurrection, and no-op-churn counts are zero;
- retries, repairs, and extra provider calls are zero.

Mutate one operation, one target, one state material field, and each safety count separately; each mutation must yield FAIL.

- [x] **Step 6: Write privacy and diagnostic tests**

Use sentinels in API-like data, adapter rejection, raw response, claims, prompt, Proxy traps, and spoofed `diagnosticCode`. Public errors/results/`JSON.stringify` must not contain sentinels or `cause`. Only module-local branded projectors may preserve these allowlisted codes:

```ts
type PublicDiagnostic =
  | 'lifecycle_model_transport_failed'
  | 'lifecycle_model_parse_invalid'
  | 'lifecycle_model_contract_invalid'
  | 'lifecycle_model_reducer_invalid'
  | 'lifecycle_model_evaluation_invalid'
  | 'lifecycle_model_unknown_failure';
```

- [x] **Step 7: Verify a real RED**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts
```

Expected: missing engine module, not a test syntax failure.

- [x] **Step 8: Implement preflight in exact order**

1. JSON-data-only options inspection.
2. Own enumerable primitive `profileId` descriptor.
3. Canonical profile lookup.
4. Model and exact 7-field budget validation.
5. Task 3 dataset preparation and exact selected order.
6. Build all twelve production request bundles.
7. Measure UTF-8 bytes of `JSON.stringify(bundle.request)` for all twelve.
8. Call `assertBudgetGate` with 12 * 32768 input and 12 * 1200 output at 0.75/3.75 per million.
9. Verify calculated ceiling string is `0.348912` and `maxBudgetUsd === 0.36`.
10. Only then validate execute adapter and begin calls.

Implement private `parseJsonDataOnly(rawContent)` in this module: require a string, call `JSON.parse` exactly once, then project only plain JSON data using the same no-accessor/no-symbol/no-cycle inspection policy. Any native parse message or attacker-controlled property name is replaced by the fixed `lifecycle_model_parse_invalid` diagnostic.

- [x] **Step 9: Implement sequential execution**

For each prepared case, independently:

```ts
const bundle = buildMemoryV3LifecycleReconcileRequest({
  userId: testCase.userId,
  conversationId: testCase.conversationId,
  messages: testCase.messages,
  state: testCase.state,
  extraction: testCase.extraction,
});
const transportResult = await boundedAdapter(bundle.request);
const parsed = parseJsonDataOnly(transportResult.rawContent);
const proposal = validateMemoryV3LifecycleProposal(parsed, {
  state: testCase.state,
  extraction: testCase.extraction,
  bindings: bundle.bindings,
});
const actual = await applyMemoryV3LifecycleStep({
  state: testCase.state,
  at: testCase.at,
  conversationId: testCase.conversationId,
  extraction: testCase.extraction,
  proposal,
  trustedForgetMemoryKeys: [],
});
```

Evaluate against authored expected proposal/state. Catch each case failure into `{ stepId, stage, diagnosticCode }` and continue. Do not add retry, fallback, repair, row dropping, or provider message projection.

Aggregate trusted telemetry only when every successful transport result supplies a valid projected `usage`. Sum `promptTokens`, `completionTokens`, and `costUsd`; otherwise return `actualUsage: null` and `actualCostUsd: null`. Never estimate missing actual usage from the configured ceiling.

- [x] **Step 10: Implement sanitized result and local review packet**

Public case result:

```ts
{
  stepId,
  expectedOperationTypes,
  actualOperationTypes,
  operationExact,
  stateExact,
}
```

Review packet may contain only synthetic fixture `{ id, role, text, createdAt }`, authored/predicted operations, safe structural evaluation, and null fields:

```ts
{
  semanticVerdict: null,
  forbiddenMeaningVerdict: null,
  reviewerNotes: null,
}
```

Validate benchmark-result profile/model/reconciler/case order before building the packet. Return fresh arrays with no aliases.

- [x] **Step 11: Add exact import source locks**

Engine production imports must be exactly:

```text
./lifecycle-model-benchmark-profile.ts
./lifecycle-model-benchmark-dataset.ts
./benchmark-budget.mjs
./lifecycle-evaluator.mjs
../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
../../supabase/functions/_shared/memoryV3/lifecycleContract.ts
../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts
../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts
```

Reject imports from stores, Supabase clients, auth, conversation loaders, fs, env, CLI/run modules, V1 live stacks, or global fetch.

- [x] **Step 12: Run targeted and full offline gates**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-model-benchmark.ts
git diff --check
```

Expected: all pass, no network, no env, no protected artifact access.

- [x] **Step 13: Verify frozen hashes and stop for review**

Repeat Task 1 hashes and show `git status --short`.

- [ ] **Step 14: Commit only after explicit authorization**

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-model-benchmark.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts
git diff --cached --check
git commit -m "[agent] feat: add synthetic lifecycle model benchmark engine"
```

---

### Task 5: Add the strict CLI boundary

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts`

**Interfaces:**
- Consumes Task 4 engine and production OpenRouter adapter factory.
- Produces:

```ts
export async function runLifecycleModelBenchmarkFromArgv(options: {
  argv: unknown;
  dataset: unknown;
  fetchImpl: typeof fetch;
  readEnvText: (path: string) => Promise<string>;
}): Promise<{
  benchmarkResult: LifecycleModelBenchmarkResult;
  semanticReviewPacket: LifecycleModelReviewPacket | null;
}>;
```

- [x] **Step 1: Write exact argv contract tests**

Accepted dry-run:

```text
--profile lifecycle-reconciler-critical-twelve-v1
--model google/gemini-3.7-flash
--max-budget-usd 0.36
```

Accepted execute adds both:

```text
--env-file <non-empty path>
--execute-twelve-paid-requests
```

Reject unknown, duplicate, shortened, alias, conflicting, missing-value, `--api-key`, generic `--execute`, wrong profile/model/budget, and env-file without execute. Getters/symbols/sparse argv must be rejected without executing getters.

- [x] **Step 2: Write dry-run zero-I/O tests**

Assert `readEnvText` calls 0, fetch calls 0, global fetch calls 0, provider calls 0, and review packet is null. The result must contain the exact ceiling and twelve ordered step ids, but no `keyPresent` field.

- [x] **Step 3: Write fake execute tests**

Assert env text read exactly once, injected fetch called exactly 12 times, `maxActive === 1`, canonical order, no retry, review packet has 12 synthetic cases, and key/raw response are absent from result JSON.

- [x] **Step 4: Write env/privacy failure tests**

Reject missing/malformed/duplicate `OPENROUTER_API_KEY`, sentinels, getters, and fetch failures without exposing env content, key, Authorization, raw body, path, or `cause`. Do not mutate `process.env`.

- [x] **Step 5: Verify RED**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts
```

Expected: missing CLI module.

- [x] **Step 6: Implement strict parser and orchestration**

Parse argv as a dense string array, require exact flags, and call the engine dry-run before env reading. For execute, parse env text locally, build `createMemoryV3LifecycleOpenRouterAdapter({ apiKey, fetchImpl })`, then call Task 4 execute exactly once. The adapter already locks the production model and completion-token cap; the CLI must not duplicate or override them.

Do not add fs, `process.env`, `globalThis.fetch`, auto-exec, or output writes.

- [x] **Step 7: Run targeted/full tests and syntax checks**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.ts
git diff --check
```

- [x] **Step 8: Verify frozen hashes and stop for review**

Repeat Task 1 hashes. Confirm zero provider/network calls.

- [ ] **Step 9: Commit only after explicit authorization**

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts
git diff --cached --check
git commit -m "[agent] feat: add lifecycle model benchmark CLI"
```

---

### Task 6: Add the import-safe composition root and no-clobber output

**Files:**
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts`

**Interfaces:**
- Consumes Task 5 CLI and local JSON fixture.
- Produces:

```ts
export async function main(options: {
  argv: unknown;
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>;
  accessImpl: (path: string) => Promise<void>;
  writeFileImpl: (path: string, data: string, options: { flag: 'wx' }) => Promise<void>;
  linkImpl: (existingPath: string, newPath: string) => Promise<void>;
  unlinkImpl: (path: string) => Promise<void>;
  fetchImpl: typeof fetch;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}): Promise<number>;
```

- [x] **Step 1: Write import-safety and dry-run tests**

Import calls must leave file/fetch/stdout/stderr counters at zero. Dry-run reads the dataset once, env zero times, fetch zero times, writes one safe JSON line to stdout, and writes nothing to disk.

- [x] **Step 2: Write safe-output preflight tests**

Optional flag:

```text
--safe-output-file <path>
```

Before dataset/env/HTTP, require injected `accessImpl`, `writeFileImpl`, `linkImpl`, `unlinkImpl`; preflight both target and `${target}.tmp` as absent using only own enumerable data `error.code === 'ENOENT'`. Getter/proxy/revoked errors remain generic and cause zero side effects.

- [x] **Step 3: Write no-clobber ownership and race tests**

- Pre-existing target: fail with 0 HTTP and no mutation.
- Pre-existing temp: fail with 0 HTTP and never unlink foreign temp.
- Success: write temp with `{ flag: 'wx' }`, set `tempCreated = true` only after success, atomically `link(temp, target)`, unlink only owned temp, bytes equal stdout JSON.
- Race: target appears after preflight; link returns `EEXIST`; preserve foreign target and unlink only owned temp.
- Write/link failure: generic safe error, no path/content leak, no second attempt.

- [x] **Step 4: Verify RED**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts
```

Expected: missing run module.

- [x] **Step 5: Implement composition root**

Resolve `memory-v3-synthetic-lifecycle.v1.json` relative to `import.meta.url`. Read env only when execute is requested. Delegate benchmark behavior to Task 5. Keep the local synthetic review packet in memory for an explicit local reviewer, but never serialize it to stdout or `--safe-output-file`. Serialize exactly:

```ts
JSON.stringify({ benchmarkResult, semanticReviewPacket: null }) + '\n'
```

No `process.exit` inside `main`. Direct invocation supplies `process.argv.slice(2)`, `readFile`, `access`, `writeFile`, `link`, `unlink`, `globalThis.fetch.bind(globalThis)`, and stdout/stderr. Import performs no work.

- [x] **Step 6: Add direct dry-run test**

Run without execute or env:

```powershell
npx tsx scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts --profile lifecycle-reconciler-critical-twelve-v1 --model google/gemini-3.7-flash --max-budget-usd 0.36
```

Expected: exit 0, one safe JSON object, 0 HTTP, no dialogue, no review packet, no disk output.

- [x] **Step 7: Run targeted/full tests and checks**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
node --check scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts
git diff --check
```

- [x] **Step 8: Verify frozen hashes and stop for review**

Repeat Task 1 hashes. Confirm no output file was created by tests outside their temporary directories.

- [ ] **Step 9: Commit only after explicit authorization**

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts
git diff --cached --check
git commit -m "[agent] feat: add lifecycle benchmark composition root"
```

---

### Task 7: Document the benchmark and lock the offline safety contract

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Modify: `scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs`

**Interfaces:**
- Consumes the final Task 2–6 commands and guarantees.
- Produces a human-readable offline operation guide and executable documentation assertions.

- [x] **Step 1: Add a failing documentation-contract test**

Extract a section headed exactly:

```markdown
## Memory V3 synthetic lifecycle model benchmark (offline by default)
```

Assert it contains:

- synthetic dialogue only;
- no production/staging/Supabase writes;
- 12 independent gold-seeded cases;
- production prompt/contract/reducer boundary;
- dry-run = 0 provider calls and no `.env` read;
- maximum 12 sequential calls and `maxActive = 1`;
- no retry, application fallback, or repair;
- configured ceiling `$0.348912`, hard max `$0.36`, not actual billing;
- `actualUsage`/`actualCostUsd` may be `null`;
- a paid run has not been authorized by the documentation;
- explicit separate Nastya authorization is required;
- passing the benchmark is not primary-memory activation or production-readiness proof.

- [x] **Step 2: Run the test and verify RED**

```powershell
node --test scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
```

Expected: README section missing.

- [x] **Step 3: Add the README section**

Include only the dry-run command:

```bash
npx tsx scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts --profile lifecycle-reconciler-critical-twelve-v1 --model google/gemini-3.7-flash --max-budget-usd 0.36
```

Describe the execute flag as forbidden until separate authorization; do not provide a real env path, key, or ready-to-copy paid command.

- [x] **Step 4: Run documentation, deterministic, and full gates**

```powershell
node --test scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Expected: all pass.

- [x] **Step 5: Run privacy/source scan**

```powershell
rg -n "sk-|eyJ|Authorization:|process\.env|Deno\.env|supabaseUrl|service_role|globalThis\.fetch" scripts/memory-v3-pilot/lifecycle-model-benchmark-*.ts
```

Expected: only intentional test sentinels and direct-invocation `globalThis.fetch` in the run module. Manually verify no secrets and no protected artifact path imports.

- [x] **Step 6: Verify frozen hashes and final status**

Repeat Task 1 hashes. Run:

```powershell
git diff --name-only
git diff --check
git status --short
```

Expected: only planned Task 7 files plus any uncommitted planned Task 2–6 files and pre-existing protected artifacts.

- [ ] **Step 7: Commit only after explicit authorization**

```powershell
git add -- scripts/memory-v3-pilot/README.md scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
git diff --cached --check
git commit -m "[agent] docs: document synthetic lifecycle model benchmark"
```

---

### Task 8: Final offline verification and mandatory stop

**Files:**
- Create: none
- Modify: none
- Test: all Task 2–7 and existing Memory V3 tests

**Interfaces:**
- Consumes the complete implementation.
- Produces an evidence-backed offline completion report; it does not perform a paid run.

- [x] **Step 1: Run every new targeted test**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts
```

Expected: all pass.

- [x] **Step 2: Run deterministic lifecycle and full offline gates**

```powershell
node --test scripts/memory-v3-pilot/lifecycle-contract.test.mjs scripts/memory-v3-pilot/lifecycle-reducer.test.mjs scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs scripts/memory-v3-pilot/lifecycle-runner.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
```

Expected: all pass, including the original deterministic suite.

- [x] **Step 3: Run syntax and diff checks**

```powershell
Get-ChildItem scripts/memory-v3-pilot/lifecycle-model-benchmark*.ts | ForEach-Object { node --check $_.FullName }
git diff --check
git diff --cached --check
```

Expected: all exit 0.

- [x] **Step 4: Run direct dry-run once**

```powershell
npx tsx scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts --profile lifecycle-reconciler-critical-twelve-v1 --model google/gemini-3.7-flash --max-budget-usd 0.36
```

Expected: zero provider calls, no env read, no output file, exact twelve ids, gate PASS, configured ceiling `0.348912`, hard max `0.36`, and no synthetic dialogue in stdout.

- [x] **Step 5: Recheck frozen hashes and repository status**

Repeat Task 1 hashes. Confirm no frozen file changed, no protected artifact was staged, and `supabase/.temp/cli-latest` is not staged.

- [x] **Step 6: Report completion and stop**

Report:

- new test totals and full-suite totals;
- exact dry-run result summary;
- zero network/provider/env/production calls;
- local/remote HEAD and working-tree paths;
- whether commits exist, without pushing unless separately authorized;
- paid benchmark not run.

Do not construct or execute the paid command. Do not read `.env`. Do not call OpenRouter. Do not deploy. Stop for a new explicit authorization and a fresh price review.

---

## Spec coverage self-review

| Spec requirement | Implemented by |
|---|---|
| Existing deterministic full lifecycle gate remains authoritative | Tasks 1, 3, 4, 7, 8 |
| Exact frozen twelve-step order | Tasks 2, 3 |
| Synthetic identifiers and no production records | Tasks 3, 4 source locks |
| Independent gold-seeded prior state | Task 3 |
| Production prompt/contract/reducer/transport boundaries | Tasks 4, 5 |
| No extractor call | Tasks 3–4 source locks |
| All request bytes and budget validated before HTTP | Task 4 |
| 12 sequential calls, no retry/repair, continue after case failure | Task 4 |
| Strict CLI and separate execute authorization | Task 5 |
| Import-safe composition root and no-clobber output | Task 6 |
| Sanitized public result and local synthetic review packet | Task 4 |
| Exact hard quality gates and four critical cases | Task 4 |
| Offline fake-adapter matrix and adversarial inputs | Tasks 3–6 |
| README limitations and no paid authorization | Task 7 |
| Final offline stop before provider execution | Task 8 |

## Type and name consistency self-review

- Profile id is always `lifecycle-reconciler-critical-twelve-v1`.
- Model is always `google/gemini-3.7-flash`.
- Reconciler version is always `memory-v3-lifecycle-reconciler-v1`.
- Execute flag is always `--execute-twelve-paid-requests`.
- Case count and request cap are always 12.
- Request cap is always 80,000 UTF-8 bytes per case.
- Token ceilings are always 32,768 input and 1,200 output per case.
- Historical prices are always 0.75 input and 3.75 output USD per million.
- Configured ceiling is always `0.348912`; hard max is always `0.36`.
- Dataset preparation function is always `prepareLifecycleModelBenchmarkCases`.
- Engine function is always `runLifecycleModelBenchmark`.
- Review packet function is always `buildLifecycleModelReviewPacket`.
- CLI function is always `runLifecycleModelBenchmarkFromArgv`.
- Composition-root function is always `main`.

## Execution handoff

The approved execution mode for this repository is inline execution in the current isolated worktree with `superpowers:executing-plans`, one task at a time and a review stop after every task. Do not use subagents unless Nastya explicitly asks for delegation. Start with Task 1 only.
