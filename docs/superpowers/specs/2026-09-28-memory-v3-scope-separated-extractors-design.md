# Memory V3 Scope-Separated Extractors Design

**Date:** 2026-09-28
**Status:** concept approved in chat; written spec awaiting review; implementation not started
**Owner:** StaySEE AI

## Problem

Memory V3 currently sends lifecycle (cross-conversation) and dialogue memory through the same extractor prompt and extractor version. The two independent runners later use different reconcilers, stores, schedules, and topics, but both start from the same semantic candidate list.

This shared first stage caused scope mixing in the 2026-09-28 lifecycle history acceptance run. A stable profile fact and its surrounding story were fused into one candidate, for example:

- `Есть сын, который съехал и скоро может уйти в армию`;
- `Состоит в отношениях с партнером ... на протяжении которых дважды расходились`;
- `Живет одна в доме площадью 100 кв.м`.

The lifecycle reconciler can only accept or ignore a candidate. It is contractually forbidden to rewrite the claim, so it cannot retain `Есть сын` while moving the son's plans into dialogue memory. A stricter reconciler prompt alone cannot reliably repair a mixed candidate.

Lifecycle and dialogue memory are separate product functions. They have separate user controls, storage, timing, retention, and semantic responsibilities. Their extraction must therefore be separate before reconciliation.

## Decision

Create two scope-owned extractor prompts, builders, and version constants:

- lifecycle extractor: produces only minimal cross-conversation profile and communication candidates;
- dialogue extractor: produces conversation-local people, facts, preferences, decisions, events, and useful narrative context.

The two extractors share only format validation, evidence rules, safety boundaries, transport, and low-level request construction. There is no public `scope` option and no runtime switch that can accidentally send a dialogue prompt to the lifecycle runner. Each runner imports its own fixed builder.

## Semantic Ownership

### Lifecycle / cross-conversation memory

Lifecycle memory may create only short, atomic, currently useful facts that should be available in unrelated future conversations:

- name, age, birthday, and explicit form of address;
- occupation or field of activity;
- existence of a current family relationship and a minimal stable identifying detail;
- stable close friendship;
- pet and a minimal useful identifying detail;
- current living arrangement, without property or story detail;
- current geography;
- long-term project or role;
- durable communication preference that should apply across conversations;
- a safe item explicitly requested for the overall profile or all conversations.

Lifecycle claims must contain one semantic fact. If a story reveals an allowed stable core, the lifecycle extractor emits the core as its own item, for example `Есть сын`, `Состоит в отношениях с Димой`, or `Живет одна`.

Lifecycle memory must not contain:

- event chronology, conflict history, relationship history, or reasons;
- plans, actions, biography, or circumstances of another person;
- health, medical information, personal therapy history, religion, or beliefs;
- incidental measurements, property details, or disposable context;
- temporary states or details useful only inside the source conversation;
- a composite claim that mixes an allowed profile fact with any excluded detail.

When a candidate is composite and the stable core was not emitted separately, lifecycle reconciliation ignores it. It never rewrites the candidate.

### Dialogue memory

Dialogue memory may retain context useful when the same conversation continues:

- people and relationships discussed in that conversation;
- events, decisions, conflict history, and bounded narrative context;
- temporary but conversation-relevant circumstances;
- preferences for how that conversation should proceed;
- user-originated sensitive context when it is relevant and allowed by the existing safety contract.

Dialogue-only details never become lifecycle candidates merely because they remain true. Dialogue memory remains isolated by `userId + conversationId` and follows the dialogue-memory toggle and retention rules.

It is acceptable for a minimal profile fact to exist in both scopes when both independent features are enabled. This is not scope mixing: the dialogue copy is isolated to its conversation, while the lifecycle copy is the deliberately minimal global fact. Turning lifecycle memory off must not disable dialogue memory, and turning dialogue memory off must not disable lifecycle memory.

### Explicit remember requests

- `Запомни в этом диалоге` or `учти здесь` authorizes dialogue memory only.
- An unqualified `запомни` is evaluated independently by both enabled scopes. Dialogue memory may retain relevant local context. Lifecycle memory may retain only a minimal atomic fact from its allowlist; the request does not make narrative or excluded content globally admissible.
- `Запомни для всех разговоров`, `в общий профиль`, or equivalent explicit global wording authorizes lifecycle evaluation, subject to safety, allowlist, and atomic-claim rules. It does not force a prohibited or composite claim into lifecycle memory.
- A remember request never authorizes deletion, hidden-instruction disclosure, unsafe content, or a schema change.

## Module Boundaries

### New production modules

1. `supabase/functions/_shared/memoryV3/extractorRequest.ts`
   - owns low-level validated request construction;
   - receives only an internal trusted instruction constant and validated dialogue;
   - exports no user-controlled scope selector;
   - contains no lifecycle or dialogue admission policy.

2. `supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.ts`
   - owns `MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION`;
   - exports `buildMemoryV3LifecycleExtractorRequest`;
   - contains the lifecycle-only semantic rules above.

3. `supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts`
   - owns `MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION`;
   - exports `buildMemoryV3DialogueExtractorRequest`;
   - contains the dialogue-only semantic rules above.

### Existing modules

- `contract.ts` continues to own the shared JSON/evidence contract and normalization.
- `transport.ts` continues to own the shared provider boundary.
- `lifecyclePrompt.ts` remains the lifecycle reconciler and receives only lifecycle extraction.
- `dialoguePrompt.ts` remains the dialogue reconciler and receives only dialogue extraction.
- `prompt.ts` becomes legacy-only compatibility for the old generic shadow/offline benchmark path. Production lifecycle, production dialogue, and both history-backfill stacks must not import it.

No production runner imports both scope-owned extractor modules.

## Versions and Identity

Add independent immutable version constants:

- `memory-v3-openrouter-gemini-3.7-flash-lifecycle-extractor-v1`;
- `memory-v3-openrouter-gemini-3.7-flash-dialogue-extractor-v1`.

The version is selected by the importing runner, never by input data or environment variables.

Lifecycle reservations, diagnostics, historical manifests, request digests, review packets, and import approvals use the lifecycle version. Dialogue equivalents use the dialogue version. Existing completed artifacts retain their original version and remain readable for audit, but they are not eligible for import through a mismatched scope/version approval.

## Live Data Flow and Timing

### Dialogue path

1. The dialogue-memory eligibility check evaluates its own toggle and account rules.
2. `dialogueShadowRunner` loads only that conversation.
3. It builds a request with `buildMemoryV3DialogueExtractorRequest`.
4. The dialogue extractor and dialogue reconciler run.
5. State is written only under that `userId + conversationId`.

### Lifecycle path

1. The lifecycle eligibility/reservation check evaluates its own toggle and daily account reservation.
2. `lifecycleShadowRunner` loads the eligible source conversation.
3. It builds a request with `buildMemoryV3LifecycleExtractorRequest`.
4. The lifecycle extractor and lifecycle reconciler run.
5. Minimal state is written only to lifecycle storage for that user.

The two paths may be scheduled at different times and may independently run, skip, fail, or fall back. Neither path consumes the other path's candidate list or state.

## Historical Backfill

- lifecycle history backfill imports only `buildMemoryV3LifecycleExtractorRequest` and records the lifecycle extractor version;
- dialogue history backfill imports only `buildMemoryV3DialogueExtractorRequest` and records the dialogue extractor version;
- request-byte calculations and SHA-256 manifests are rebuilt from the scope-owned prompt;
- scope/version mismatches fail before provider calls and before filesystem writes;
- existing safe-output, budget, no-retry, sequential-call, and privacy guarantees remain unchanged.

The three artifacts produced on 2026-09-28 are audit evidence only. They are not imported. No historical artifact is rewritten or deleted.

## Compatibility

- The shared model response schema remains unchanged.
- The shared transport and provider model route remain unchanged.
- Lifecycle and dialogue database schemas remain unchanged.
- Read paths and user-facing toggles remain unchanged.
- The legacy generic shadow runner may retain `prompt.ts`; it cannot feed lifecycle or dialogue production stores.
- Existing production fallback and Telegram alert behavior remains unchanged.

## Tests

### Module isolation

- lifecycle live runner and lifecycle backfill import only the lifecycle extractor builder;
- dialogue live runner and dialogue backfill import only the dialogue extractor builder;
- neither scope runner imports `prompt.ts` or the other scope's extractor module;
- source-lock tests count import specifiers and reject dynamic or side-effect imports that bypass the boundary.

### Prompt and identity tests

- each builder returns its exact fixed instruction and does not mutate input;
- each runner records the correct scope-owned extractor version;
- a mismatched version, prompt digest, or backfill manifest is rejected before network access;
- getters, proxies, symbols, sparse arrays, and unknown fields remain rejected without executing accessors.

### Semantic fixture matrix

The same synthetic conversation is evaluated against both scope policies:

| Source meaning | Lifecycle result | Dialogue result |
|---|---|---|
| son moved out and may join the army | `Есть сын` | may keep the move/army context |
| current partner plus two breakups | current relationship only | may keep breakup history |
| sister conflict and no contact | minimal current relationship state only if globally useful | may keep conflict history |
| lives alone in a 100 m² house | `Живет одна` | may keep the property detail if relevant |
| long sobriety motivated by health fear | omit | may keep locally if relevant and safe |
| personal/group therapy plus professional training | omit personal therapy; emit professional role/training only if separately evidenced | may keep therapy context if relevant and safe |
| prefers direct communication | global communication preference | local preference may also exist |
| explicit `запомни здесь` | omit unless independently globally admissible | admit |
| unqualified `запомни: у меня есть сын` | `Есть сын` | may also retain the fact locally |
| unqualified `запомни` followed by a long conflict story | omit the story; emit only a separately evidenced allowlisted core, if any | may retain relevant local narrative |
| explicit `для всех разговоров` | admit only minimal safe fact | dialogue path is unaffected |

Tests also prove that one scope failing or being disabled does not suppress the other.

## Rollout and Acceptance

1. Implement with RED-to-GREEN tests and run all Memory V3, backfill, type, lint-on-changed-files, and build checks.
2. Commit, push, and open a review PR. Do not merge until the review is clean and the product owner explicitly approves.
3. Deploy `staysee-chat` only after merge and verify the active function version.
4. Run provider-free source inspection and calculate a fresh price ceiling.
5. Request a new explicit approval before any paid model call or sensitive-history egress.
6. Run one main-account lifecycle acceptance backfill with a new safe-output filename, no retry, and a hard budget.
7. Human-review the resulting lifecycle facts. Acceptance requires no dialogue narrative, health/therapy history, third-party plans, conflict chronology, or incidental measurements in lifecycle memory.
8. Only after acceptance decide whether the two smaller accounts need another paid run.
9. Import nothing until the product owner explicitly approves the exact fact list in real time.

## Non-Goals

- No database migration.
- No change to retention periods or purge jobs.
- No automatic import of any existing artifact.
- No change to model provider, fallback provider, or paid-call limits.
- No keyword-based semantic filter pretending to understand arbitrary stories.
- No automatic rewrite of model claims inside a reconciler.
- No merge, deploy, paid call, or production-memory write authorized by this design document alone.

## Success Criteria

- Production lifecycle and dialogue runners cannot construct requests from the same semantic prompt module.
- Historical lifecycle and dialogue backfills cannot construct requests from the same semantic prompt module.
- Each scope has an independent extractor identity recorded through reservation, result, review, and import validation.
- Synthetic fixtures demonstrate intentionally different scope outcomes for the same source dialogue.
- A paid main-account lifecycle acceptance run contains only minimal cross-conversation facts.
- No reviewed artifact is imported without explicit product-owner approval.
