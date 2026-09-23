# Memory V3 Viewer Screen Design

**Date:** 2026-09-23
**Status:** Approved (product owner sign-off via conversational brainstorming)
**Requested by:** Настя (product owner)

## Decision

Make Memory V3 (the "smart" memory system with events/recurrences/hypotheses) visible and partially manageable from the account's existing memory screen, with different behavior for two account cohorts, split by account creation date:

- **Existing accounts** (created before this feature ships): today's two sections — "Память беседы" (`conversations.conversation_summary`) and "Сквозная память" (`user_memory`) — are untouched, exactly as they work today. A new third section is added alongside them, showing a curated, read-and-delete-only view of Memory V3: this account's frozen account-wide snapshot, plus (if dialogue-scoped memory is active for this account) the current dialogue's own notebook.
- **New accounts** (created after this feature ships): the same two section names and layout stay ("Память беседы", "Сквозная память") — no third section, no new UI shape — but their data source changes. "Память беседы" now reads and deletes from this dialogue's Memory V3 notebook; "Сквозная память" now reads and deletes from the account-wide Memory V3 snapshot. The old simple systems (`conversation_summary`, `user_memory`) keep running silently underneath for these accounts as a technical fallback only, invisible and not editable — insurance in case Memory V3 fails to load, not a user-facing feature.

The product has no real users yet (confirmed by Настя), so "existing accounts" in practice means her own account only; this is a forward-looking design decision, not a large migration.

## Why this is the next step

Confirmed today by reading the real frontend code: Memory V3 (both the account-wide version live since 22.09 and the dialogue-scoped version wired today in PR #53) has no user-facing screen at all — it silently builds hidden prompt context with no way for a person to see, correct, or delete what it decided to remember. This is a real product gap for a therapy-adjacent app handling sensitive personal claims.

## Scope decomposition

This design covers exactly: the read surface (a new endpoint exposing curated Memory V3 data to the frontend, which does not exist today), the delete surface (a new mutation path, which also does not exist today — Memory V3 has only ever been written by the automated extractor/reconciler pipeline), and the two account-cohort UI behaviors described above.

Out of scope, explicitly deferred:
- The "raw admin panel" Настя asked about earlier today — reprioritized to come after this ships.
- Widening the dialogue-scoped canary beyond Настя's own account (a separate, already-flagged decision).
- Any free-text "add a memory item yourself" affordance for the new Memory V3-backed sections (see Non-goals).
- A durable "never re-add this" guarantee after delete (see Data flow — deletion).

## Goals

1. A person (existing or new account) can see what Memory V3 currently believes are confirmed facts and recurring patterns about them, in a place they already know to look.
2. A person can delete an item they disagree with or find intrusive, immediately.
3. Never surface an unconfirmed hypothesis directly to the user — those stay internal to Stacy's own reasoning, unchanged from today.
4. Sensitive items are not sprung on the user while scanning a list — shown collapsed by default, matching the same caution already encoded in Memory V3's own AI-facing prompt rules.
5. New accounts get a coherent, non-confusing memory screen without needing new UI concepts invented for them — they simply never see the old simple systems at all.

## Non-goals

This design does not:
- let a user directly author a new Memory V3 item as free text (the existing "Память беседы"/"Сквозная память" screens allow this today for the old simple systems; Memory V3 items are AI-extracted structured facts, not freely authored text, so this affordance does not carry over for the new data source — confirmed acceptable with Настя);
- guarantee a deleted item never reappears (the extractor/reconciler pipeline could independently notice the same pattern again in a future conversation and recreate it — accepted as an honest first-version limitation, not solved here);
- touch or migrate a single row of the old `conversation_summary`/`user_memory` data for existing accounts;
- widen the dialogue-scoped canary rollout — today, an empty "Память беседы" Memory V3 view for any account other than Настя's own is expected, since dialogue-scoped writing is only active for her account (see `STAYSEE_MEMORY_V3_DIALOGUE_MODE`/`_ALLOWED_USER_ID`, set earlier today);
- change anything about how Memory V3 is written (extractor, reconciler, reducer) — this is a read + delete surface only.

## Data model / cohort rule

```text
isNewAccount = profile.created_at >= MEMORY_V3_VIEWER_LAUNCH_CUTOFF
```

`MEMORY_V3_VIEWER_LAUNCH_CUTOFF` is a constant set to this feature's deploy date, defined once in the frontend (and mirrored in the new edge function, since the edge function's delete/read behavior for "which table did this come from" does not actually depend on cohort — cohort only decides which UI section layout to render; the underlying data sources are identical for both cohorts, existing accounts just get an additional third section rather than a swapped one).

## Data flow

**Read**, new edge function `memory-v3-viewer` (mirrors `weekly-reflection`'s verified-caller pattern):
1. Verify caller JWT (`resolveVerifiedChatUser`, same helper already used by `weekly-reflection` and `staysee-chat`).
2. Load the account-wide snapshot: `createMemoryV3LifecycleReadStore(svc).load(userId)`.
3. If a `conversationId` is passed and dialogue-scoped eligibility resolves true for this user (`resolveMemoryV3DialogueEligibility`, same check used in `staysee-chat`): also load `createMemoryV3DialogueReadStore(svc).load(userId, conversationId)`.
4. Filter both lists to `kind !== "hypothesis"` — events and recurrences only.
5. Project to a minimal shape the client needs: `{ memoryKey, kind, claim, eventTimeStart, eventTimeEnd, sensitivity }` — no `updatedAt`, no evidence, no internal status/revision fields (matches the same "don't leak internals" discipline already used throughout Memory V3's other read paths today).
6. Return `{ accountWide: [...], dialogue: [...] }` (dialogue omitted/empty if not eligible or no `conversationId`).

**Delete**, same edge function, a second action:
1. Verify caller JWT, same as above.
2. Caller supplies `{ memoryKey, scope: "account_wide" | "dialogue", conversationId? }`.
3. New SECURITY DEFINER RPCs (one per scope, mirroring the ownership-check discipline already used everywhere else in Memory V3): `delete_memory_v3_lifecycle_item(p_user_id, p_memory_key)` and `delete_memory_v3_dialogue_item(p_user_id, p_conversation_id, p_memory_key)`. Each deletes the item row and its evidence rows for that exact `(user_id[, conversation_id], memory_key)` — ownership is enforced by the `WHERE` clause, never trusted from the caller beyond the verified JWT's `userId`.
4. No change to `nextMemoryOrdinal` or `stateRevision` bookkeeping — a deleted item just stops existing; the reducer already tolerates gaps (this is exactly what `trustedForgetMemoryKeys` already models internally, though that mechanism is not wired to this delete path today — direct row deletion is simpler and sufficient for the "does not guarantee non-recurrence" scope this design accepts).

**Frontend**, `MemoryScreen.tsx`:
- Compute `isNewAccount` from the already-loaded user profile.
- Existing account: render today's two sections unchanged, plus a new third section calling `memory-v3-viewer` for both scopes, listing events/recurrences with a delete button per row, sensitive items collapsed behind a "показать" toggle.
- New account: "Память беседы" section's existing load/save/delete calls are replaced with calls to `memory-v3-viewer` scoped to `dialogue`; "Сквозная память" section's calls are replaced with calls scoped to `account_wide`. Both lose their existing free-text add/edit controls (Non-goals) and keep only list + delete + the same sensitivity collapse behavior as the third section above.

## Testing

- New edge function: unit-testable pieces (the JWT verification reuse, the hypothesis-filtering projection, the ownership-scoped delete RPC calls) get `*.cases.test.ts` coverage mirroring `weekly-reflection`'s existing test style — fakes for the Supabase client, no live network.
- New migration (the two delete RPCs): a structural test mirroring today's migration tests (`CREATE OR REPLACE FUNCTION`, ownership `WHERE` clause present, `REVOKE`/`GRANT` to `service_role` only).
- Frontend: manual verification only (this codebase's established limit — there is no test harness for the React screens themselves, confirmed by inspecting `MemoryScreen.tsx`'s neighborhood earlier today).

## Open questions

None outstanding. The two points flagged conversationally (reduced editing power for new accounts; canary-account-only backend data until the rollout widens) were raised with Настя directly and accepted, not left ambiguous.
