# Memory V3 Synthetic Lifecycle Benchmark Design

**Date:** 2026-09-14  
**Status:** Proposed design; implementation, paid execution, and production activation are separate gates  
**Branch:** `codex/memory-v3-lifecycle-benchmark`

## Decision

Build an entirely offline synthetic lifecycle benchmark before Memory V3 is allowed to become the application's primary memory.

The existing V2 benchmark proves that one bounded dialogue can be converted into contract-valid events, recurrences, hypotheses, and evidence. The new benchmark must prove the missing longitudinal behavior: memory across multiple conversations and months, including creation, confirmation, revision, rejection, deduplication, explicit deletion, and stability over time.

Production Memory V3 remains `off`. This work does not select a real account, call OpenRouter, read production dialogue, write Supabase data, or feed Memory V3 into replies.

## Why this path

StaySEE currently has only two real users across three accounts and limited dialogue history. A real-world shadow sample would be too small and too biased to serve as the primary quality gate.

Synthetic lifecycle scenarios provide better control at this stage because every fact, correction, counterexample, forbidden inference, and expected memory state can be authored explicitly. They also make regressions repeatable.

Synthetic testing cannot prove that a model understands every natural formulation. It can prove that the state machine, privacy boundary, deletion behavior, evidence rules, and failure handling are correct. Model-quality tests remain a later, separately authorized benchmark using only synthetic data.

## Existing foundation

The design reuses but does not modify the approved Memory V3 V2 boundaries:

- `contracts-v2.mjs` validates layered items and typed evidence;
- `extractor-core-v2.mjs` normalizes one dialogue extraction;
- `evaluator-v2.mjs` evaluates one case structurally;
- `memory-v3-ru-golden.v2.json` covers single-snapshot extraction;
- the production shadow path remains write-only and disabled.

The existing `localItemKey` identifies an item inside one extraction. It is not a durable cross-session memory identity and must not be treated as one.

## Goals

1. Prove deterministic memory transitions over ordered synthetic sessions.
2. Prevent duplicate active memories when the same meaning is restated.
3. Preserve distinct memories that merely share a topic.
4. Apply corrections without leaving the superseded interpretation active.
5. Keep hypotheses epistemically weaker than established events.
6. Expand recurrences only from typed user evidence and distinct episodes.
7. Remove explicitly forgotten memory completely from the materialized state.
8. Prevent assistant speculation, prompt injection, and forbidden meaning from becoming memory.
9. Measure state stability, churn, deletion, and evidence lineage after every step.
10. Create a reusable offline gate for any future lifecycle reconciler.

## Non-goals

This phase does not:

- activate the deployed production shadow path;
- choose Nastya's account UUID;
- call a model or provider;
- use real user messages;
- replace `conversation_summary` or `user_memory`;
- design the final Supabase read path or UI;
- automatically decide semantic equivalence with string similarity;
- make age alone a reason to forget a valid memory;
- claim that structural scores replace human semantic review;
- authorize a paid synthetic benchmark.

## Architecture

The benchmark has five independent layers:

```text
synthetic timeline dataset
        ↓
lifecycle contract
        ↓
injected reconciliation adapter
        ↓
deterministic state reducer
        ↓
lifecycle evaluator and hard gates
```

The dataset supplies synthetic conversations, already validated V2 extractions, expected transition intent, and expected state after each step. The first implementation uses an injected scripted reconciliation adapter. This isolates lifecycle correctness from model quality.

A future model-backed reconciler must implement the same adapter contract. It cannot bypass the reducer, create durable identity, delete memory directly, or weaken the hard gates.

## Boundary between extraction and lifecycle

Extraction answers:

> What memory candidates and evidence are present in this bounded dialogue snapshot?

Lifecycle reconciliation answers:

> Which candidates create new durable memories, which update existing memories, and which add no new state?

The two decisions remain separate. The lifecycle layer receives only:

- validated current memory projections;
- the current validated V2 extraction;
- trusted session metadata;
- trusted explicit deletion controls, if any.

It never receives golden answers, evaluator scores, API keys, provider responses, or hidden model reasoning.

## Durable memory model

The reducer owns durable identity. Neither a model nor a dataset extraction may invent it.

Each materialized memory item contains:

```text
memoryKey
kind
claim
status
sensitivity
eventTimeStart
eventTimeEnd
alternative
firstSeenAt
updatedAt
revision
evidence
```

Rules:

- `memoryKey` is generated deterministically by trusted code when a candidate is first created;
- `kind` remains `event | recurrence | hypothesis`;
- kind changes create a distinct layer rather than silently converting the item;
- `revision` starts at 1 and increases only when material content or status changes;
- confirmations may add new evidence without rewriting the claim;
- evidence retains source conversation/message identity and typed recurrence fields;
- materialized state contains only the current revision;
- the offline result may contain a sanitized transition audit, but no raw prompts or arbitrary errors.

The benchmark does not finalize the production database schema. It defines the behavioral contract that a later storage design must preserve.

### Current and closed memory

The lifecycle state may contain both current and closed items. Closed items are retained so the system remembers that an earlier interpretation was corrected, became stale, or was rejected.

For benchmark purposes:

- current event: `active`;
- closed event: `corrected | rejected`;
- current recurrence: `candidate | active`;
- closed recurrence: `stale | rejected`;
- current hypothesis: `candidate | supported`;
- closed hypothesis: `stale | rejected`.

A later reply-context design may read only current items while using closed items to prevent resurrection of known mistakes. This benchmark does not connect either class to replies.

## Reconciliation proposal contract

The injected adapter returns only closed, JSON-data-only operations:

```text
create(candidate localItemKey)
confirm(target memoryKey, candidate localItemKey)
revise(target memoryKey, candidate localItemKey)
mark_stale(target memoryKey, candidate localItemKey)
reject(target memoryKey, candidate localItemKey)
ignore(candidate localItemKey)
```

Constraints:

- every extraction candidate is consumed exactly once;
- a target must already exist in the trusted current state;
- `create` cannot supply a `memoryKey`;
- one target cannot receive two conflicting operations in one step;
- an operation may reference only the current extraction and current state;
- assistant-authored evidence remains invalid for every relation;
- unknown fields, accessors, symbols, sparse arrays, cycles, and spoofed errors are rejected without data leakage;
- there is no retry, repair, or silent row dropping.

String similarity is not trusted to merge memories. Semantic matching belongs to the injected reconciler and is measured by the benchmark. The deterministic reducer only applies a validated proposal.

### Exact operation effects

- `create` copies one validated candidate into a new reducer-owned `memoryKey`, with `revision = 1`.
- `confirm` requires the same kind, leaves material fields and revision unchanged, and adds only previously unseen evidence. Repeating identical evidence is byte-for-byte idempotent.
- `revise` requires the same kind, replaces the material fields with the validated candidate, preserves the `memoryKey`, appends evidence, and increments the revision exactly once.
- `mark_stale` is valid only for recurrence or hypothesis targets and requires a candidate whose status is `stale` with user `contradicts` evidence.
- `reject` requires a candidate whose status is `rejected` with user `rejects` evidence.
- `ignore` changes no state.

`mark_stale` and `reject` preserve the closed item in lifecycle state and increment its revision. A correction with a replacement fact uses `revise` when the durable meaning remains one memory, or closes the old item and creates a distinct new item when the two meanings should remain separately auditable. The scripted gold locks that choice per scenario.

## Explicit forgetting

User-requested deletion is a trusted control-plane action, not a model inference.

The reducer accepts an optional allowlisted list of existing `memoryKey` values to forget before applying the session proposal. For each key it removes:

- the materialized item;
- its evidence;
- its revision history from the benchmark state.

The reconciler cannot emit a forget operation. A conversational phrase that appears to request forgetting must be routed through a separately designed user-control boundary before production integration.

The benchmark must also test that deleted material does not reappear merely because an old extraction is replayed. The scripted scenario supplies a trusted suppression decision for that replay. The production mechanism for suppression is deliberately deferred to the later storage/read-path design.

## Time semantics

Passing time alone never deletes a valid autobiographical event or changes a status.

Time may influence evaluation expectations only when new user-authored evidence changes meaning. Examples:

- an old event remains an old event;
- a recurrence becomes stale only after relevant contradictory evidence;
- a hypothesis becomes rejected only after user evidence rejects it;
- a new date correction revises the event instead of creating a second active copy.

The 30-day production shadow retention is unrelated. It deletes experimental run payloads, not future primary memory.

## Synthetic dataset

Create a new dataset with identity:

```text
datasetId: memory-v3-synthetic-lifecycle-v1
version: 1.0.0
language: ru
```

All people, UUIDs, conversations, dates, and dialogue are synthetic. The dataset contains at least 20 scenarios, 80 ordered sessions, and 240 messages. Each scenario spans at least three sessions and at least two calendar dates.

Each step contains:

```text
stepId
at
conversationId
messages
validatedExtraction
scriptedProposal
forgetMemoryRefs
expectedState
mustNotRemember
```

Gold uses stable authoring-only `goldMemoryId` values. Runtime `memoryKey` values are produced by the reducer. The evaluator creates a deterministic one-to-one assignment between runtime items and gold items; golden identifiers never enter runtime requests.

The dataset is locked by a canonical manifest fingerprint after human review. Mechanical totals alone are insufficient because a structurally valid but semantically wrong correction would otherwise pass.

## Required scenario families

The first dataset includes at least these behaviors:

1. The same event restated with different wording remains one memory.
2. Two events about the same person or topic remain distinct.
3. A wrong event date is corrected without duplicate active state.
4. A broader claim is narrowed by a scope boundary.
5. A hypothesis moves from candidate to supported with new evidence.
6. A hypothesis is explicitly rejected and no longer appears active.
7. A recurrence accumulates distinct episode observations across months.
8. Pattern confirmation adds evidence without inventing another episode.
9. Counterevidence marks a recurrence stale when the claim as written no longer holds.
10. An isolated counterexample narrows a qualified recurrence instead of destroying it.
11. Assistant speculation is ignored when the user neither confirms nor supplies evidence.
12. Assistant speculation explicitly denied by the user remains forbidden.
13. Prompt-injection text cannot alter the operation schema or expected state.
14. An explicit trusted forget action removes item, evidence, and history.
15. Replaying an old snapshot after forgetting does not silently resurrect memory.
16. A sensitive but supported item remains marked sensitive through revisions.
17. Irrelevant sessions cause no state churn.
18. Equal timestamps and reordered input produce deterministic results.
19. Layered event, recurrence, and hypothesis memories coexist without forced duplication.
20. A month with no new evidence leaves the previous state byte-for-byte stable.

## Deterministic reducer

For each step the runner performs:

1. Validate the dataset, scenario, current state, extraction, and adapter proposal as JSON-data-only values.
2. Apply trusted explicit forget controls.
3. Verify that every proposal reference resolves exactly once.
4. Apply operations in canonical order independent of adapter output order.
5. Generate keys only for `create` operations.
6. Merge evidence by trusted source identity without duplicating rows.
7. Increment revisions only for material updates.
8. Revalidate every resulting item and evidence row.
9. Freeze a new state snapshot without mutating earlier snapshots or inputs.
10. Evaluate that snapshot against step gold.

Any invalid operation rejects the complete step. There is no partial state update.

## Evaluator

The evaluator reports both per-step and per-scenario metrics:

- required item precision, recall, and F1;
- acceptable matches without false-negative penalty;
- duplicate active item count;
- kind and status accuracy;
- transition accuracy by operation;
- evidence precision, recall, and F1;
- recurrence episode-partition accuracy;
- correction replacement accuracy;
- state churn on no-op steps;
- deletion completeness;
- forbidden-memory violations;
- deterministic replay equality.

Assignment is required-first and deterministic. It uses exact structural evidence overlap before the canonical `(goldMemoryId, memoryKey)` pair-tuple tie-break. Platform locale and model output order cannot change the result.

Semantic paraphrase and forbidden meaning remain explicit human-review fields when a future model-backed reconciler is evaluated. The scripted reference path must achieve exact expected state and does not use a semantic model.

## Hard offline gates

The reference implementation passes only when:

- every expected state matches exactly after every step;
- forbidden-memory violations are zero;
- assistant-only memories are zero;
- deleted-memory remnants are zero;
- deleted-memory resurrection is zero;
- duplicate active memories are zero;
- superseded active revisions are zero;
- no-op state churn is zero;
- recurrence episode partitions are exact;
- replay with reordered operation input is byte-for-byte deterministic;
- all inputs and prior snapshots remain unmodified;
- provider, network, environment, filesystem-write, and production calls are zero.

These are correctness gates, not weighted averages. A perfect aggregate score cannot hide one forbidden or deleted-memory failure.

## Failure and privacy model

All public errors use module-local branding and a closed diagnostic set. External names, messages, `cause`, getters, proxies, and arbitrary property names are untrusted.

Errors and reports never contain:

- API keys or Authorization headers;
- raw provider responses;
- environment values;
- hidden prompts or reasoning;
- production identifiers;
- real user dialogue;
- attacker-controlled exception messages.

The benchmark is offline by construction. Production modules have no `fetch`, HTTP, Supabase, `.env`, or CLI auto-execution imports.

## Proposed file boundaries

Create in a later implementation phase:

```text
scripts/memory-v3-pilot/lifecycle-contract.mjs
scripts/memory-v3-pilot/lifecycle-contract.test.mjs
scripts/memory-v3-pilot/lifecycle-reducer.mjs
scripts/memory-v3-pilot/lifecycle-reducer.test.mjs
scripts/memory-v3-pilot/lifecycle-evaluator.mjs
scripts/memory-v3-pilot/lifecycle-evaluator.test.mjs
scripts/memory-v3-pilot/lifecycle-runner.mjs
scripts/memory-v3-pilot/lifecycle-runner.test.mjs
scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json
scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.test.mjs
```

Modify only after the implementation is green:

```text
scripts/memory-v3-pilot/README.md
```

Do not modify:

```text
scripts/memory-v3-pilot/contracts-v2.mjs
scripts/memory-v3-pilot/extractor-core-v2.mjs
scripts/memory-v3-pilot/evaluator-v2.mjs
scripts/memory-v3-pilot/memory-v3-ru-golden.v1.json
scripts/memory-v3-pilot/memory-v3-ru-golden.v2.json
supabase/functions/_shared/memoryV3/
supabase/functions/staysee-chat/
supabase/migrations/
```

## Implementation and review sequence

1. Lifecycle contract and strict data-only validation.
2. Deterministic reducer and identity generation.
3. Lifecycle evaluator and hard-gate mathematics.
4. Human-authored synthetic timeline manifest.
5. Full JSON dataset only after a separate authoring review.
6. Offline runner using an injected scripted adapter.
7. Adversarial privacy, proxy, cycle, ordering, and mutation tests.
8. README and full regression gate.

Each task ends with a review checkpoint. Dataset authoring is not delegated to a model without line-by-line review. No paid execution is part of these tasks.

## Promotion gates

Passing this benchmark is necessary but not sufficient for primary-memory integration.

The order after this phase is:

1. Reference lifecycle implementation passes every offline hard gate.
2. A candidate reconciliation prompt and adapter are designed separately.
3. Any paid model benchmark uses only this synthetic dataset and requires explicit budget approval.
4. Human review confirms semantic and forbidden-meaning results.
5. A separate production storage and read-path design is approved.
6. Only then may Memory V3 be considered for limited user-facing use behind an immediate off switch.

The deployed shadow mode remains off throughout.

## Success criteria

This phase succeeds when the repository contains a deterministic, reproducible test that demonstrates how future Memory V3 state should evolve over months of synthetic conversations, catches every required unsafe transition, and performs no external call or production mutation.

It does not succeed merely because the existing extractor passes more single-dialogue cases.

## Rejected alternatives

### Activate the real shadow pilot now

Rejected because the sample is too small to establish quality and uses sensitive real dialogue unnecessarily.

### Add only more independent golden cases

Rejected because independent cases cannot detect duplicate accumulation, incorrect correction, resurrection after deletion, or state churn across time.

### Let the model directly rewrite the entire memory document

Rejected because it weakens identity, auditability, deletion, and deterministic validation.

### Merge by claim text or embeddings inside the reducer

Rejected because semantic similarity is uncertain and must remain an explicit reconciler decision that the benchmark can score.

### Delete memories only because they are old

Rejected because old autobiographical events may remain useful. Forgetting requires explicit control or evidence-driven status change.

## Final boundary

Approval of this design authorizes only a detailed implementation plan. It does not authorize lifecycle implementation, dataset creation, provider calls, production activation, real-account selection, or use of Memory V3 in replies.
