# Memory V3 Synthetic Lifecycle Model Benchmark Design

**Date:** 2026-09-19
**Status:** approved
**Decision:** validate lifecycle model quality with synthetic dialogues and production-equivalent modules, without relying on real users or writing test data to production.

## Context

StaySee AI has only two people and three accounts. Waiting for enough natural dialogue would make quality validation slow, incomplete, and impossible to reproduce.

The repository already contains two strong but separate test layers:

1. The Russian Golden V2 extraction benchmark measures whether the extractor identifies durable events, recurrences, hypotheses, corrections, counterexamples, and safety boundaries.
2. `memory-v3-synthetic-lifecycle-v1` contains 20 scenarios, 80 ordered lifecycle steps, and 240 synthetic messages. It exercises `create`, `confirm`, `revise`, `mark_stale`, `reject`, `ignore`, and trusted `forget`.

The deterministic lifecycle suite currently passes 113/113 tests. Its reconciliation adapter is scripted, so it proves contracts, reducer behavior, invariants, privacy, and evaluation. It does not prove that the real reconciler model chooses the correct lifecycle operation.

The production lifecycle-shadow path has now completed one allowlisted app run successfully. That proves wiring, transport, storage, and deployment, but one natural conversation cannot establish quality.

## Goal

Create a reproducible benchmark that asks the real production reconciler boundary to decide lifecycle operations for selected synthetic situations, then evaluates those decisions against the existing human-authored lifecycle gold.

The benchmark must:

- use only synthetic dialogue and synthetic identifiers;
- use the existing lifecycle dataset rather than copy or paraphrase it;
- use production prompt, contract, transport, and reducer modules;
- perform no Supabase, application-account, production, or staging writes;
- be fully testable offline with injected fake adapters;
- require a separate explicit authorization before any paid provider execution;
- run sequentially with a strict request cap and no retry, fallback, or repair at the application layer;
- produce a sanitized result with no API key, Authorization header, raw provider body, prompt, or hidden reasoning.

## Non-goals

- This benchmark does not replace the 24-case extractor benchmark.
- It does not test real users or collect production dialogue.
- It does not activate primary memory or read lifecycle state into replies.
- It does not write synthetic rows to production lifecycle tables.
- It does not change the production prompt, model, reducer, contracts, migrations, retention, or allowlist.
- It does not ask the model to perform `forget`. Forget remains a trusted application operation and is already covered by deterministic tests.
- Passing one paid sample is not production-readiness proof by itself.

## Chosen approach

Use three complementary layers.

### Layer 1: deterministic full lifecycle gate

Keep the existing 20-scenario / 80-step / 240-message suite unchanged. Every implementation change must continue to pass all deterministic lifecycle tests.

This layer remains free, offline, exhaustive for authored transitions, and the authority for reducer invariants including trusted forgetting and no resurrection.

### Layer 2: offline production-boundary characterization

Add a model-benchmark harness with an injected reconciler adapter. Fake-adapter tests exercise all selected cases through the production prompt builder, lifecycle proposal validator, reducer, and evaluator without network access.

This layer proves that the benchmark itself is safe, deterministic, sequential, budget-gated, and faithful to the production boundary.

### Layer 3: separately authorized paid synthetic sample

After Layers 1 and 2 pass and Nastya separately authorizes spending, execute exactly twelve sequential reconciler calls against the same model used by production. Each call uses one synthetic selected step and a gold-seeded prior state.

Gold-seeding makes cases independent: one wrong model decision cannot corrupt later cases or hide the original failure. The complete 80-step chained behavior remains covered deterministically by Layer 1.

## Why this approach

Testing through real app accounts is rejected because it is slow, non-reproducible, pollutes production data, and cannot cover rare correction, rejection, stale, injection, and safety transitions reliably.

Running all 80 steps through the provider immediately is rejected because it is unnecessarily expensive and makes early diagnosis noisy.

Replacing only the reconciler is intentional. Extraction quality already has a dedicated Golden V2 benchmark. Combining extractor and reconciler failures in the same first model-quality gate would make failures ambiguous and double the paid calls.

## Frozen twelve-case profile

The first paid-capable profile contains these exact step ids in this order:

1. `paraphrase-event-dedup-s02` — confirm an existing event rather than duplicate it.
2. `same-topic-distinct-events-s02` — create a distinct event despite topical similarity.
3. `event-date-correction-s03` — revise a materially corrected event date.
4. `scope-narrowing-s03` — revise a recurrence after a scope boundary.
5. `hypothesis-supported-s03` — revise a hypothesis when support materially changes it.
6. `hypothesis-rejected-s03` — reject an existing hypothesis.
7. `recurrence-growth-s02` — confirm a recurrence with a new episode.
8. `pattern-confirmation-s03` — ignore a redundant pattern confirmation without churn.
9. `recurrence-stale-s03` — mark a contradicted recurrence stale.
10. `assistant-speculation-denied-s01` — ignore assistant-only invented meaning.
11. `prompt-injection-schema-s02` — ignore an instruction embedded in dialogue.
12. `layered-coexistence-s01` — create three independently admissible memory layers.

The profile covers every model-authored operation: `create`, `confirm`, `revise`, `mark_stale`, `reject`, and `ignore`. Trusted `forget` is excluded from model calls by design.

## Data flow

For each selected step:

1. Load `memory-v3-synthetic-lifecycle.v1.json` locally.
2. Validate the exact dataset identity, canonical manifest, selected scenario, and selected step.
3. Build the prior lifecycle state from the previous step's authored expected state, or an empty state for the first step.
4. Use the step's already validated extraction delta. Do not call the extractor.
5. Build the reconciler request through `buildMemoryV3LifecycleReconcileRequest` from the production module.
6. Enforce UTF-8 request-byte and budget gates before any adapter call.
7. Call the injected reconciler adapter exactly once.
8. Validate the returned proposal through the production lifecycle contract.
9. Apply it with the production deterministic reducer.
10. Compare operation type, target identity, resulting state, forbidden meanings, and lifecycle invariants with the authored gold.
11. Continue to the next independent case after a failure. Never retry the failed case.

## Module boundaries

The benchmark is an additive script/test surface. Production runtime behavior remains unchanged.

Planned modules:

- `scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.ts`
  - frozen profile id, selected step ids, model identity, request cap, and budget ceiling;
  - no filesystem, environment, network, or CLI behavior.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark.ts`
  - dataset validation, gold-state seeding, sequential execution, production-boundary calls, evaluation, and sanitized result;
  - receives the adapter by dependency injection;
  - no filesystem, environment, global fetch, or automatic execution.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.ts`
  - exact argv contract, dry-run, env-file parsing through injected text, and explicit paid-execute flag;
  - no global fetch and no direct filesystem access.
- `scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts`
  - composition root for the local dataset, optional env file, injected/global fetch only in direct invocation, stdout, and safe optional output;
  - importing the module performs no work.
- matching `.test.ts` files for each boundary.

The harness imports the existing production lifecycle prompt, lifecycle contract, lifecycle reducer, and lifecycle transport. It must not copy their logic.

## CLI contract

Dry-run requires no `.env` and makes zero HTTP calls:

```bash
npx tsx scripts/memory-v3-pilot/lifecycle-model-benchmark-run.ts \
  --profile lifecycle-reconciler-critical-twelve-v1 \
  --model google/gemini-3.7-flash \
  --max-budget-usd 0.36
```

Paid execution remains unavailable without all of the following:

- exact profile id;
- exact model;
- exact hard budget;
- explicit `--execute-twelve-paid-requests` flag;
- explicit env-file path containing the key;
- fresh offline tests;
- separate contemporaneous authorization from Nastya.

The implementation of the command is not authorization to execute it.

Unknown, duplicate, conflicting, shortened, or alias flags are rejected before env reading or HTTP.

## Request and budget gates

- Maximum provider calls: 12.
- Execution: sequential; `maxActive` must remain 1.
- Retry: 0.
- Application fallback or repair: 0.
- The thirteenth attempted call is blocked before the inner fetch.
- An inner fetch rejection still counts as one attempt.
- Request-size validation runs for all twelve cases before the first call.
- A failed dataset, profile, byte, model, or budget check produces zero calls.

The reviewed historical planning ceiling is `$0.029076` per reconciler call. Twelve calls imply `$0.348912`; the hard command ceiling is `$0.36`. These are conservative preflight bounds, not actual billing. A future paid run must also verify a fresh allowlisted price snapshot. If the fresh ceiling is greater than `$0.36`, execution stops before HTTP and the profile must be reviewed again.

Actual provider usage and cost are aggregated only from trusted projected telemetry. Missing telemetry remains `null`; it is never estimated and reported as actual.

## Result schema

The public result contains:

- profile id, model, reconciler version, and ordered selected step ids;
- attempted, success, and failure counts;
- provider HTTP call count and maximum concurrency;
- configured budget and gate status;
- per-case `{ stepId, expectedOperationTypes, actualOperationTypes, operationExact, stateExact }`;
- safe failure `{ stepId, stage, diagnosticCode }` only;
- aggregate transition counts and exactness;
- critical safety gate results;
- trusted aggregate usage/cost or `null`;
- `semanticReview.status = "required"`.

The public result never contains dialogue text, claims, alternatives, evidence text, prompts, raw model content, headers, the API key, or production identifiers.

A separate local review packet may contain only the synthetic fixture messages and authored/predicted operations. It is built offline after a run and is never sent to another provider or stored in production.

## Quality gates

The benchmark reports PASS only when all of these are true:

- all 12 cases were attempted exactly once;
- all 12 responses passed transport, parse, shape, and contract validation;
- all 12 operation sets exactly match the authored operation types and targets;
- all 12 resulting states exactly match the authored expected state;
- all four critical cases are exact:
  - `hypothesis-rejected-s03`;
  - `recurrence-stale-s03`;
  - `assistant-speculation-denied-s01`;
  - `prompt-injection-schema-s02`;
- forbidden-memory violations = 0;
- assistant-only memory violations = 0;
- duplicate-active, superseded-active, deleted-remnant, deleted-resurrection, and no-op-churn counts = 0;
- retries, repairs, and extra provider calls = 0.

Any failed gate produces FAIL, not a softened score. The report still preserves safe per-case diagnostics so the prompt or model decision can be reviewed deliberately.

## Offline test matrix

Tests must prove:

- exact frozen profile values and deep freeze;
- exact dataset fingerprint and selected step order;
- every selected step exists exactly once;
- prior states are seeded without aliases or mutation;
- production prompt/contract/reducer imports are used;
- dry-run performs zero env reads and zero HTTP calls;
- fake successful execution performs exactly 12 sequential calls;
- middle failure still attempts the remaining independent cases and never retries;
- thirteenth call is blocked before fetch;
- request overflow, malformed dataset, wrong model, wrong budget, and bad options fail before HTTP;
- getters, symbols, non-enumerable fields, sparse arrays, cycles, proxies, and spoofed diagnostics are rejected without leaking sentinels;
- raw response, key, Authorization, dialogue, claims, and prompts do not appear in public result, errors, stdout, or safe output;
- all 113 existing deterministic lifecycle tests remain green;
- all existing Golden V2, production Memory V3, and benchmark tests remain green.

## Production isolation

The model benchmark must contain source locks rejecting imports of:

- Supabase clients;
- lifecycle stores;
- production/staging project references;
- application authentication;
- conversation loaders;
- `process.env` or `Deno.env` in library modules;
- global fetch outside the direct composition root;
- any automatic paid execution.

Synthetic UUIDs and local fixture message ids are used throughout. No production user id, conversation id, message id, state row, or lifecycle run row is read or written.

## Failure handling

All public errors use module-branded allowlisted diagnostics. Provider messages, proxy trap messages, raw bodies, dialogue, claims, keys, and filesystem paths are not copied into public errors. Errors have no `cause`.

A failed paid case does not retry and does not stop later independent cases. Configuration, dataset, privacy, and budget failures remain fail-fast before the first call.

## Implementation sequence

1. Lock current deterministic and production hashes/totals.
2. Add the frozen twelve-case profile and tests.
3. Add the offline benchmark engine with fake adapters and production-boundary imports.
4. Add evaluator/report projection and local synthetic review packet.
5. Add strict CLI dry-run and fake execute tests.
6. Add composition root and optional no-clobber safe output.
7. Update README and run the full offline gate.
8. Stop. Do not perform a paid run.

Paid execution, if later approved, is a separate operational step after code review, commit, push, and fresh budget verification.

## Success definition

Implementation is complete when the new benchmark can prove offline that exactly twelve synthetic reconciler decisions traverse the same production prompt/contract/reducer boundary safely, the complete existing test suite remains green, and dry-run confirms zero provider and production calls.

The feature is not considered quality-proven until a separately authorized paid synthetic run passes every hard gate. Real-user volume is not a prerequisite for that proof.
