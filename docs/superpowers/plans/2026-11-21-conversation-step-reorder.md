# Conversation Step Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace row dragging with paid-only ↑/↓ controls that move exactly one position, persist server-side, and preserve archive access rules.

**Architecture:** Keep the list response contract unchanged. Store authoritative active-conversation order in a protected UUID array on the existing per-user usage row; use its row lock as the existing account mutation mutex. A new RPC swaps adjacent IDs only against an expected neighbor; lifecycle triggers keep the order aligned with insert/delete/activity and the free anchor. React waits for confirmed server order, retains selected row, and removes native/touch drag handlers.

**Tech Stack:** Existing React18/TypeScript, Supabase PostgreSQL/PLpgSQL, existing lucide icons and test tooling; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-21-conversation-step-reorder-design.md` (approved21.11.2026).

## Execution status 21.11.2026

Release-prep22.11: merged fresh origin/main0b140b3 (no force-push); migration now20261122010000_113, chronologically after112. Fixture applies104,105,107,108,110,111,113;112 is unrelated Memory V3 and excluded. Missing usage row retains own list metadata with no content/reorder rights. Raw chat versus legacy moveTop deadlocked in both lock orders before the fix; legacy now writes only authoritative order/anchor under usage lock, never a conversation row. Both sessions commit in both orders after the fix. Updated verification:3097 offline,48 DB,6 concurrent race scenarios; full linked-browser rerun and release report are tracked under the22.11 task. Historical counts below describe the earlier run, not the new acceptance.

Tasks1/2 implemented locally; Task3 separate real-stack browser acceptance completed on21.11, release acceptance remains open. Independent whole-branch review found three Important issues; all reproduced and fixed in one pass. Final review also reproduced a legacy moveTop expiry-boundary mismatch; a deterministic regression now covers both RPCs and the authorized legacy anchor is persisted in the same transaction without a second time check. Updated evidence after rebasing onto main PR218:3049 offline tests,47 isolated DB scenarios (actual107/108 before113), real two-session lock waits in four races,13 browser component scenarios and12 geometry measurements including repeated moves. Typecheck/build/smoke pass; lint0errors/11documented warnings. Exact revisions and final reruns are recorded in the external acceptance report.

Plan rulings: the planned tests/db file is replaced by an actually executed network-isolated PostgreSQL driver, since shared8100 must not receive113. Real controls are tested in the browser rather than a static controls snapshot. Paid-only ordering uses paid_features, not the broader multiroom reading exception. Order and chosen free anchor are committed atomically after authorization. Old list authority and previews are invalidated on uncertain/refused moves; failed refresh never claims success. Full separate Auth/PostgREST+113 acceptance covers reload/relogin, two-tab stale adjacency, HTTP503, expiry, direct locked routes, export removal, locked deletion and empty replacement. The owned disposable stack/users/cache were removed; shared8100 was preserved. Physical-phone acceptance and the reported iPhone blank space are NOT closed. No production migration or deployment; only a draft PR is authorized. The original task checklists below remain the planned contract; this status and the external report are the execution ledger.

## Global Constraints

- One click changes one position. Normal row tap opens chat. Only currently paid-feature callers may reorder; a free multiroom reading override does not grant ordering.
- Renaming/manual moves never alter message text or last-message timestamps. New activity still promotes its conversation.
- Preserve first-row access on expiry, frozen free anchor, locked-row deletion and empty replacement; do not reopen archives by deletion/reordering.
- No production DB writes, migrations, model calls, payments or new messages during implementation. Use isolated fixtures; do not reset/stop shared8100.
- Preserve other agent's work. Dedicated worktree from fresh origin/main; check migration numbering before publishing. Current intended migration113 must not collide with another agent.

## Review Focus

1. A second device or a new message changes adjacency during a click: reject stale neighbor, refresh, never swap an unexpected row (Task1/2).
2. Expiry during a move or forged other-user ID: server rejects, UI closes mode; retained archives stay closed (Task1/2).
3. Concurrent activity/delete and user-row locks: consistent lock acquisition, no lost order or deadlocks; local two-connection test (Task1).
4. Rapid repeated clicks and account switch during a request: one in-flight ticket per identity, old completion cannot clear new state (Task2).
5. Short/long mobile list and removed selected row: no synthetic scroll tail, stale selection or accidental chat opening; hardware iPhone remains a separate acceptance (Task3).

---

### Task 1: Authoritative adjacent ordering and compatibility

**Files:** Create `supabase/migrations/20261122010000_113_conversation_step_order.sql`, `scripts/conversation-step-order.dbtest.mjs`, `tests/db/conversationStepOrder.dbtest.ts`; reuse isolated fixture helpers without reading production env.

**Interfaces:** RPC `move_my_conversation_step(p_conversation_id uuid,p_direction text,p_expected_neighbor uuid) RETURNS boolean`. `p_direction` exactly `up`/`down`; success true; changed neighbor raises `conversation_order_changed`; unauthorized owner/access raises a non-disclosing refusal. List shape stays exactly7 keys per row. Private helpers revoked from PUBLIC/anon/authenticated.

- [ ] Write RED database tests: initial backfill preserves current list; `[C,B,A]` plus up(A,B) becomes `[C,A,B]`; down(A,B) restores `[C,B,A]`; list IDs/dates/content unchanged otherwise. Add boundary/free/foreign/malformed/expired refusal and expected-neighbor mismatch.
- [ ] Run these against isolated PostgreSQL and confirm failure from missing RPC/behavior, not connection/configuration error.
- [ ] Add protected `user_usage_tiers.conversation_order uuid[] NOT NULL DEFAULT '{}'`, backfilled from existing effective order. Private normalization retains only own active IDs, deduplicates and appends missing IDs by legacy order. Direct user UPDATE remains denied.
- [ ] Implement RPC under usage-row lock: validate ownership/full access, normalize, resolve adjacent ID, compare expected neighbor, swap exactly those two entries, update stored order and refresh anchor. No conversation timestamps are rewritten.
- [ ] Update `list_my_conversations` and `refresh_conversation_anchor` to use stored order with legacy fallback. An order-maintenance trigger runs before the existing anchor trigger (explicit alphabetical name), prepending newly active/activity/manual-top rows and removing deleted/inactive ones. Keep legacy moveTop behavior compatible. Audit all activity paths; use usage-first locking on callable mutations to avoid inverse lock acquisition.
- [ ] Add tests for new activity promotion, insert/delete, legacy moveTop, expiry selected first row, delete-accessible not unlocking archive, replacement empty row, repeat calls and two independent concurrent connections (stale neighbor/expiry/activity/delete). Confirm no direct grants allow editing order/anchor.
- [ ] Run focused new tests plus existing archive-access/creation/upgrade tests; commit only this tested unit.

### Task 2: Client and accessible arrow controls

**Files:** Modify `src/lib/conversationAccess.ts`, `src/components/screens/MainScreen.tsx`; create `src/components/ConversationOrderControls.tsx`; update `scripts/conversation-access-client.test.ts`; add `scripts/conversation-order-controls.test.ts` and `tests/browser/conversation-order.html`/`.tsx`.

**Interfaces:** `client.moveStep(id:string,direction:'up'|'down',expectedNeighbor:string):Promise<void>`. New controls consume selected ID, first/last position, saving flag, `onMove(direction)` and `onDone()`; arrows have accessible labels and44px hit areas.

- [ ] Write RED transport tests: only scoped RPC/three exact args; reject invalid IDs/direction before network; error/false never reported success; conflict has distinct safe refresh notice. Write real-component browser tests against controlled external list/move boundaries: selected row follows repeated one-step moves; no click propagation into chat; edge disabled; free/unknown plan no ordering; failures retain correct order; account switch/rapid clicks cannot publish stale state.
- [ ] Confirm RED, then implement client validation and adjacent-neighbor snapshot; retain server order instead of optimistic success. Preserve the existing7-key list parser.
- [ ] Replace menu action with «Изменить порядок». Render ↑/↓/«Готово» for selected row; keep row selection after confirmed moves, clear on owner/rights change or row deletion. One request ticket prevents overlapping moves and stale completion clearing newer state. Disable controls while saving; re-read on conflict/error with understandable text.
- [ ] Remove row draggable/drag/drop/pointer handlers, hold state/listeners and click suppression. Do not add long-press replacement. Preserve rename/delete and normal row-click behavior. Maintain focus on the moved control without scrolling the document to an unrelated position.
- [ ] Run focused client/control/browser tests, then typecheck/lint; commit scoped unit.

### Task 3: Browser/layout acceptance and complete handoff

**Files:** Update browser test README and this plan; report/screenshots outside Git under `D:/Project/GPT JARVIS/knowledge/`.

- [ ] Reproduce height/scroll measurements with1,3 and long lists at390×844,375×812 and landscape. Record document height, last-control bottom and scroll position before/after repeated arrows. Expected: document height no greater than max(viewport height,last-control bottom+64px); no accumulating empty tail. Fix only a demonstrated layout cause, not a guessed iOS CSS workaround; if not reproducible, retain explicit physical-device blocker.
- [ ] Run actual local-stack browser acceptance: paid arrows up/down/reload; server rejects free/foreign/stale calls; expiry freezes actual first row; delete/archive/replacement still work. No model requests. Clean disposable users and own servers, leave8100 intact.
- [ ] Close prior coverage gap on the new local build: locked conversation via history/direct route, memory/notes/dynamics and JSON/PDF export must not expose content; retain explicit limits where the browser cannot reproduce real focus/network events rather than calling them production passes.
- [ ] Run full offline suite (same groups with relative paths if Windows ENAMETOOLONG), typecheck, lint, production build and bundle smoke. Report warnings/failures by name. Keep actual browser/DB evidence separate from mocks.
- [ ] Independent read-only whole-branch review required before integration. Fix Critical/Important only after reproducing; no silent production migration. Preserve the worktree/branch and write handoff with remaining physical Android/iPhone acceptance.

## Self-review

Approved behavior maps to Tasks1/2; all five review risks have explicit tests. iPhone blank-space observation is not assumed fixed by arrow replacement and remains gated on reproduction. Existing message promotion, paid-only control and free-anchor safety are preserved explicitly. No plan step needs production credentials or changes to memory/models/payment services.
