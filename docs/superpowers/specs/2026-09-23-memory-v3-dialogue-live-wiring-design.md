# Memory V3 Dialogue Live Wiring Design

**Date:** 2026-09-23
**Status:** Approved (product owner sign-off via conversational brainstorming)
**Requested by:** Настя (product owner)

## Decision

Wire the already-shipped dialogue-scoped Memory V3 storage (`dialogueStore.ts` / `dialogueReadStore.ts` / `dialogueContract.ts`, merged 2026-09-22) into the live `staysee-chat/index.ts` pipeline, gated behind a new canary mode so it activates for exactly one account first. This is "domain 2" from `docs/superpowers/specs/2026-09-22-memory-v3-dialogue-isolation-design.md`.

Concretely:

1. **New orchestration file**, `dialogueShadowRunner.ts`, mirroring `lifecycleShadowRunner.ts` almost exactly (load messages → call extractor → call reconciler → reserve/apply against the dialogue store instead of the lifecycle store). Includes the same cost-usage-logging hook wired in `lifecycleShadowRunner.ts` today.
2. **Write path**: for a user in dialogue mode, `staysee-chat/index.ts` calls the new dialogue runner *instead of* the existing lifecycle runner (mutually exclusive per user — matches the approved architecture's "no new writes into the legacy tables going forward" once a user has moved over). Users not in dialogue mode are completely unaffected; they keep writing to the legacy account-wide store exactly as today.
3. **Read path**: additive, not exclusive. Every conversation keeps showing the frozen legacy account-wide snapshot unconditionally (today's behavior, unchanged). For a user in dialogue mode, the conversation's own per-dialogue state is loaded and injected *alongside* it — two blocks in the prompt, not a replacement.
4. **Gate**: new env vars `STAYSEE_MEMORY_V3_DIALOGUE_MODE` (`off | dialogue_canary | dialogue_all`) and `STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID`, mirroring the exact shape of the existing `STAYSEE_MEMORY_V3_MODE` / `STAYSEE_MEMORY_V3_SHADOW_USER_ID` pair. Shipped set to `dialogue_canary` with Настя's own account id — nobody else is affected until a later, separate decision to widen it.
5. **Catch-up fix, ported from today's earlier work**: `reserve_memory_v3_dialogue_run` (migration `039_memory_v3_dialogue_isolation.sql`) still gates on "already ran today" (calendar day), not on "10 new messages since the last check" — the trigger-condition change shipped today only touched the account-wide RPC (migration `039_memory_v3_lifecycle_message_count_trigger.sql`). This design ports the identical fix to the dialogue RPC via a new migration, so both systems run on the same rule. The shared-account-wide-budget behavior Настя asked for earlier is unaffected — that fix (one advisory-lock pair, `conversation_id` excluded from the count) is already in the dialogue RPC as shipped.
6. **Cost logging**: `dialogueShadowRunner.ts`'s extractor/reconciler calls log into `ai_usage_logs` the same way the lifecycle runner's do (reusing `logMemoryV3LifecycleUsage`, same `call_kind` values — the two systems' checks are never both active for the same account at the same time, so no new tag is needed to tell them apart).

## Why this is the next step

Per today's earlier conversation and per `2026-09-22-memory-v3-dialogue-isolation-design.md`: the storage foundation (PR #50) is deployed but inert — `staysee-chat/index.ts` has never called it. Without this wiring, dialogues are not actually isolated in the live product; the foundation is a warehouse with nothing moving through it.

## Scope decomposition

This design authorizes exactly the wiring above, gated to one account. It does not decide (and explicitly defers) widening beyond that account — that is a separate, later decision once the canary account's behavior has been observed for a few real days, matching every prior Memory V3 rollout step.

## Goals

1. Настя's own account starts writing new "smart" memory facts into a per-dialogue notebook instead of the shared account-wide one, and her prompt shows both the frozen legacy snapshot and her active dialogue's own notebook.
2. Every other account's behavior is provably unchanged (same code path, same tables, same trigger cadence they use today).
3. The dialogue RPC's paid-call trigger condition matches the account-wide one exactly (10 new messages, no daily ceiling), so there is one consistent rule across both systems.
4. Cost from dialogue-scoped checks is visible in the same `ai_usage_logs`-based counters already shipped today.

## Non-goals

This design does not:
- migrate, reclassify, or touch a single row of the legacy account-wide tables;
- build a screen to view/edit/delete what Memory V3 (either version) has learned — confirmed today as a separate future step, once this wiring is live and observed;
- build a per-dialogue on/off toggle (separate from the existing account-wide "Сквозная память" toggle, which continues to gate both the legacy and the dialogue-scoped read/write paths unchanged);
- build the "inherit / fresh / incognito" new-dialogue-creation UX;
- decide or implement widening beyond the one canary account.

## Data flow

```text
Write (after a reply, background):
  user in dialogue_canary/dialogue_all and matches allowlist?
    yes -> runMemoryV3DialogueShadow(...) -> dialogueStore.ts -> memory_v3_dialogue_* tables
    no  -> runMemoryV3LifecycleShadow(...) -> lifecycleStore.ts -> memory_v3_lifecycle_shadow_* tables (unchanged)

Read (building the prompt):
  always: load legacy snapshot (memory_v3_lifecycle_shadow_*) -> lifecycleCrossMemory block (unchanged)
  user in dialogue_canary/dialogue_all and matches allowlist?
    yes -> load this conversation's own state (memory_v3_dialogue_*) -> new dialogueMemory block, injected alongside
```

`context.ts`'s `buildContextPrompt` gets a new optional `dialogueMemory` field next to the existing `lifecycleCrossMemory`, with a new `formatMemoryV3DialoguePromptBlock` formatter mirroring `formatMemoryV3LifecycleReadPrompt`.

## Testing

Same rigor as every prior Memory V3 milestone:
- `dialogueShadowRunner.cases.test.ts`, mirroring `lifecycleShadowRunner.cases.test.ts` test-for-test (gating, ordered orchestration, adversarial input hardening, cost-usage-logger wiring) — fakes only, no live network/database.
- A new migration + structural test porting the message-count trigger fix to `reserve_memory_v3_dialogue_run`, mirroring `messageCountTriggerMigration.cases.test.ts`.
- Wiring-level assertions in `staysee-chat/index.ts`'s test suite for the new gate and the new read/write branches, matching how the existing lifecycle gate is covered.
- Full `deno check` / full `_shared` regression sweep before any PR, comparing against a clean `main` baseline, same as every change shipped today.

## Open questions

None outstanding for this slice. Widening beyond the canary account, the Memory V3 viewing/editing screen, and the per-dialogue toggle are explicitly deferred, not undecided — they're simply out of scope here.
