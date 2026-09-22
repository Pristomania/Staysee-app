# Memory V3 Dialogue Isolation Design

**Date:** 2026-09-22
**Status:** Approved architecture (professional self-review done, two findings fixed/flagged below); implementation planning is the next gate
**Requested by:** Настя (product owner), via conversational brainstorming session

## Decision

Give each conversation its own independent Memory V3 lifecycle state — a separate durable "notebook" per `(user_id, conversation_id)` — instead of the current single shared state per `user_id`. The existing per-user tables (`memory_v3_lifecycle_shadow_heads/items/evidence`) are frozen as-is: no schema change, no data migration, no new writes into them going forward. They remain readable and continue to be injected into every conversation as a legacy cross-conversation snapshot, exactly as today.

New, separate tables and RPCs (mirroring the existing ones exactly in shape, differing only in primary key) hold the new dialogue-scoped state going forward. The extraction/reconciliation logic (contract.ts, the reducer, the model prompts) is reused unchanged — only the storage container gets a `conversation_id` dimension.

## Why this is the next step

Product intent, restated plainly: Memory V3's deep reasoning (noticing contradictions, recurring patterns, evidence-backed claims) was meant to apply *within one conversation's topic* (e.g. a "work" dialogue, a "money" dialogue, a "personal" dialogue kept separate on purpose), not smeared across every conversation a user has. The already-shipped `lifecycle_all` rollout (2026-09-22, PR #46) built this as a single cross-conversation pool instead — a real product/implementation mismatch discovered during this session, not a bug in the shipped code relative to its own (different) design intent.

Verified directly against the schema (`supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql`): `memory_v3_lifecycle_shadow_heads` has `user_id` as its sole primary key, and `reserve_memory_v3_lifecycle_shadow_run` takes an advisory/row lock scoped to `user_id` alone. Two concurrent conversations for the same user today serialize against each other at the database level — a real concurrency cost of the current single-state-per-user design, not just a conceptual mismatch. Partitioning by `(user_id, conversation_id)` removes this serialization as a side effect.

This mirrors the original Memory V3 buildout's own proven playbook (offline foundation → shadow → canary → full rollout, `docs/superpowers/specs/2026-09-05-memory-v3-production-shadow-pilot-design.md` and its successors), which repeatedly caught real reasoning-quality bugs (duplicate evidence, uncertain-vs-certain fact hardening, recurrence needing 2+ distinct episodes) before they reached production. This design intentionally reuses that same staged approach rather than a faster, riskier path.

## Scope decomposition

This design authorizes only risk domain 1.

1. **Dialogue-scoped storage foundation** (this design's implementation scope): new tables, new RPCs mirroring the existing reserve/apply/load contract exactly, reusing the existing `contract.ts`/reducer/extraction logic unchanged, verified only with fakes/unit tests — no live wiring into `staysee-chat/index.ts`, no migration deployed to production, no environment variable read anywhere yet.
2. **Live wiring** (separate future design): switch `staysee-chat/index.ts`'s write/read paths to call the new dialogue-scoped store *in addition to* the existing frozen legacy store; combine both into the prompt; gated behind its own explicit mode/canary, same pattern as `STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE`.
3. **Migration deploy + activation** (separate future gate): applying the new migration to production, then a later explicit decision to enable it for one account, then all accounts — same multi-step gate every prior Memory V3 milestone used.
4. **New-dialogue creation UX** (explicitly out of scope, a later design): the "inherit memory from another dialogue / start fresh on сквозная only / full incognito" screen described earlier in this session. This needs dialogue-scoped memory to exist first; it is not part of this design.

No implementation plan may combine domains 1–3 into one step, matching this codebase's existing convention for every prior Memory V3 milestone.

## Goals

1. Each `(user_id, conversation_id)` pair gets its own lifecycle state, revision counter, and advisory lock — fully independent of every other conversation of the same user.
2. Reconciliation (confirm/revise/contradict) for a given conversation only ever compares against that same conversation's own prior items — never another conversation's.
3. The existing per-user legacy tables are never written to again and never migrated; they keep serving their current read role unchanged (a separate, later design decides exactly how the two are combined at read time).
4. The extraction contract, reducer, and model prompts are reused as-is — no change to `contract.ts`'s validation logic beyond removing the hardcoded `scope: "cross_conversation"` / `conversationId: null` requirement so a real conversation-scoped value is accepted.
5. New tables carry the same privacy, RLS, and bounding properties as the existing ones (row caps, RLS enabled, cascade delete with the owning conversation and account).

## Non-goals

This design does not:

- migrate, reclassify, or touch a single row of `memory_v3_lifecycle_shadow_heads/items/evidence`;
- change what `staysee-chat/index.ts` actually calls at runtime — zero behavior change for any live user from this design alone;
- deploy any migration to production;
- decide how the frozen legacy snapshot and the new dialogue-scoped state get combined in the prompt (domain 2);
- build the "inherit / fresh / incognito" new-dialogue UX (domain 4);
- touch `сквозная память` (`profiles.cross_memory_enabled`, `user_memory` table) at all — that system is explicitly out of scope and stays as-is per today's earlier fix (PR #48).

## Data model

New tables, mirroring `memory_v3_lifecycle_shadow_*` exactly except for the added `conversation_id` in every key:

```text
memory_v3_dialogue_heads
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
  schema_version, state_revision, next_memory_ordinal, created_at, updated_at
  PRIMARY KEY (user_id, conversation_id)

memory_v3_dialogue_items
  user_id, conversation_id, memory_key, kind, claim, status, sensitivity, ...
  PRIMARY KEY (user_id, conversation_id, memory_key)
  FOREIGN KEY (user_id, conversation_id) REFERENCES memory_v3_dialogue_heads

memory_v3_dialogue_evidence
  user_id, conversation_id, memory_key, source_message_id, relation, ...
  PRIMARY KEY (user_id, conversation_id, memory_key, source_message_id, relation)
  FOREIGN KEY (user_id, conversation_id, memory_key) REFERENCES memory_v3_dialogue_items

memory_v3_dialogue_identities   -- run dedup, same shape as today's *_identities
memory_v3_dialogue_runs         -- run audit trail, same shape as today's *_runs
```

RPCs mirror the existing three exactly (`reserve_memory_v3_dialogue_run`, `fail_memory_v3_dialogue_run`, `apply_memory_v3_dialogue_state`, `load_memory_v3_dialogue_read_context`), with the advisory lock and row caps scoped to `(user_id, conversation_id)` instead of `user_id`.

**Advisory lock key (professional review finding, fixed in this revision):** the existing function locks on `hashtextextended(p_user_id::text || ':' || today's date, 0)`. The dialogue-scoped `reserve_memory_v3_dialogue_run` must lock on `hashtextextended(p_user_id::text || ':' || p_conversation_id::text || ':' || today's date, 0)` — folding `conversation_id` into the hash input, not just widening the row lock. Getting this wrong (e.g. keeping the lock user-scoped while only the table rows are conversation-scoped) would silently keep the exact serialization bug this design sets out to fix.

TypeScript layer: new `dialogueStore.ts` / `dialogueReadStore.ts` files, near-identical to `lifecycleStore.ts` / `lifecycleReadStore.ts`, with `conversationId` threaded through the same validation (`projectExtraction` stops rejecting a non-null `conversationId`/non-`"cross_conversation"` `scope`; everything else — the adversarial Proxy-hardening, exact-field-set checks — is preserved unchanged).

## Testing

Same rigor as the existing lifecycle store: extend `contract.ts`'s test suite for the now-accepted `conversationId`/scope values, and write a new `dialogueStore.cases.test.ts` mirroring `lifecycleStore.cases.test.ts` test-for-test (reservation, duplicate detection, daily cap, compare-and-swap conflict, adversarial input hardening). No live Supabase/network/provider calls — fakes only, matching this design's scope (domain 1).

## Open questions for the next design (domain 2, not this one)

1. How the frozen legacy cross-conversation snapshot and the new dialogue-scoped state get combined when injecting into a live prompt — e.g. does a dialogue see its own state plus the full legacy snapshot unconditionally, or does the legacy snapshot get a smaller, explicitly-сквозная-flavored role once `сквозная` itself is revisited. Not decided here; flagged so it isn't forgotten.

2. ~~Cost caps, per-user vs per-conversation~~ — **resolved (Настя, 22.09.2026): the daily reservation cap stays one per person, shared across every dialogue, matching today's live behavior.** Implemented directly in this migration (domain 1), not deferred to domain 2: the daily-count query in `reserve_memory_v3_dialogue_run` spans all of a user's conversations (no `conversation_id` filter), guarded by its own advisory lock separate from the per-conversation state-write lock (two concurrent dialogues could otherwise both read `count=0` before either inserts its run row). Item/evidence size caps (100/500) stay per-conversation, since those bound one dialogue's own storage, not a shared budget — only the paid-call cap needed to be shared.
