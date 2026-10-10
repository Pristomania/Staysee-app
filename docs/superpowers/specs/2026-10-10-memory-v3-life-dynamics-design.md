# Memory V3 Life Dynamics — Design

## Why

Настя asked how to design forgetting/archiving for Memory V3 (the live
memory system — lifecycle facts across all conversations, dialogue facts
per conversation). The engineering audit behind this spec found the
opposite problem from what she expected: Memory V3 already silently loses
facts today. Both `load_memory_v3_dialogue_read_context` and
`load_memory_v3_lifecycle_read_context` select only the 12
most-recently-updated CURRENT-status items for the live chat prompt —
anything older quietly stops reaching the model, with no regard for
importance or sensitivity, and no signal to the user that it happened.
Nothing is ever deleted automatically anywhere in Memory V3 today; the
only existing cron job purges 30-day-old audit-log rows (`*_runs`), never
actual memory content.

Given that finding, Настя reframed the goal: this is a psychological
product, and the point of memory isn't merely "don't lose data" — it's
that the AI should understand and reflect the **dynamics of a person's
life** over time (so it can say, months later, "half a year ago you were
afraid of X — now you've changed jobs"), not read back a flat list of
facts. Her own example: when a fact changes, the system should capture
*that it changed*, not just silently overwrite the old value with the
new one.

This matches published practice for exactly this kind of system, not
just our own instinct:

- **[Zep](https://help.getzep.com/v2/concepts)**, a production agent-memory
  system, never deletes a contradicted fact — it marks when the fact
  stopped being true and keeps it linked to what replaced it, preserving
  history while keeping current state unambiguous.
- **[Letta/MemGPT](https://docs.letta.com/concepts/memory-management)**
  splits memory into a small always-in-context tier (core memory blocks)
  and a larger on-demand archival tier — the same shape as "a protected
  slot in the live prompt" vs. "everything visible in the Память screen."
- **[Stanford's Generative Agents](https://themoonlight.io/review/zep-a-temporal-knowledge-graph-architecture-for-agent-memory)**
  (Park et al., 2023) runs a separate "reflection" pass that periodically
  synthesizes higher-level insight from raw memory — the same shape as
  folding this into the existing weekly check-in rather than the live
  chat alone.
- Competitor mental-health AI companions (Avocado, MindSync) market this
  exact feature under the word "milestones" and ship it as a
  weekly/monthly AI-generated summary of recurring patterns and
  breakthroughs.

## Scope

**In scope:**
- Every time the reconciler closes an existing current fact (`reject` or
  `mark_stale`) and creates its replacement in the same turn, the new
  fact is automatically linked back to the one it replaced — always, not
  as a judgment call the model has to make about whether the change is
  "significant enough." (Significance is decided later, at read time, not
  at write time — see below.)
- Linked pairs where either end is marked `sensitivity: sensitive` get a
  small number of reserved slots in the live chat prompt, alongside the
  existing 12-item window, so a meaningful before/after isn't silently
  crowded out by recency alone.
- The existing weekly check-in feature ("Неделя здесь" /
  `ConversationDynamicsScreen` + the `weekly-reflection` function) is
  fixed and repurposed to use this: its cross-conversation view currently
  reads the `user_memory` table, which is already retired at the database
  layer (migration 058's CHECK constraint) for every account except one
  internal test account — so this part of the screen is silently dead for
  every real user today. It's replaced with a real read from Memory V3.
  Its "what changed this week" view currently guesses by diffing the raw
  text of two weekly snapshots word-by-word; that's replaced with the
  real linked pairs.
- The model's own judgment, in the moment, on whether and how to mention
  a linked pair (including whether to connect it to work done in the
  app) — this was Настя's explicit ruling earlier in this conversation,
  not something this design hardcodes.

**Explicitly out of scope / deferred (Настя's own call):**
- Automatic age-based deletion or archiving of ordinary (non-linked)
  facts. She was clear she doesn't yet know how to do this correctly and
  wants to defer it until it's forced by real growth. Concretely, the
  lifecycle table already hard-rejects new writes once an account passes
  100 total stored items (migration 034's existing size guard) — that
  cap, not a vague sense of "the database is big," is the real future
  trigger for revisiting this.
- Any change to manual deletion (single item / delete-all) — unchanged.
- Raising or otherwise changing the base 12-item live-window cap itself —
  this design adds a separate, additional reserved allotment, not a
  change to the existing number.
- Any new screen. This reuses the existing weekly check-in button/screen
  Настя already has in mind, not a new one.
- Retroactively linking facts that were already corrected/rejected before
  this ships. There's no reliable way to infer, after the fact, which
  past creation corresponds to which past correction — unlike this
  session's earlier `importance` backfill, this is forward-only from the
  day it deploys.

## Architecture

### 1. Automatic "was → became" linking

Both `dialogueContract.ts`/`dialogueReducer.ts` and their lifecycle
equivalents gain one new optional field on `create` operations:
`supersedesMemoryKey`. When the reconciler issues a `create` in the same
response as a `reject`/`mark_stale` targeting an existing item, it always
fills this in with that item's memory key — a mechanical habit every
time it closes one fact and opens its replacement in the same turn, not a
decision about whether the change matters.

Validation (contract layer): if `supersedesMemoryKey` is present, it must
match a `targetMemoryKey` that this same operation batch is also closing
via `reject` or `mark_stale` in that same response — reusing the existing
"no other operation may target that memory" bookkeeping, extended to
recognize this cross-reference rather than reject it as a conflict. At
most one `create` in a batch may reference a given `targetMemoryKey` this
way — two different creates both claiming to supersede the same closed
item is rejected, the same way the existing rule already rejects two
operations both targeting the same memory for closing. Unlike `revise`,
which requires `candidate.kind === target.kind`, `supersedesMemoryKey`
carries no such constraint — a recurrence (e.g. a recurring worry)
resolving into an `event` (e.g. the thing it was about actually
happening) is exactly the kind of change this feature exists to capture,
and kind-matching would rule it out.

A linked item's new end can itself later become the old end of a further
link — chains are supported with no special-casing: a middle-of-chain
item simply carries both `replacesMemoryKey` (pointing to what it
replaced) and `replacedByMemoryKey` (pointing to what replaced it) at
once.

Reducer: when applying such a `create`, it stamps both ends —
`replacesMemoryKey` on the new item (pointing at the old one) and
`replacedByMemoryKey` on the old item (pointing at the new one). Nothing
else about either item changes — claim text, status, evidence, and
`revision` all behave exactly as today. A `create` without
`supersedesMemoryKey` behaves identically to today, unchanged: this is
purely additive.

### 2. Protected retention in the live chat window

Today, `load_memory_v3_dialogue_read_context` and
`load_memory_v3_lifecycle_read_context` each select only the 12
most-recently-updated CURRENT-status items. Each gains a second,
additional selection: up to 5 linked pairs where either end has
`sensitivity = 'sensitive'`, ordered by the new end's `updatedAt`
(newest first) — both ends of each such pair are included, even though
the old end's status is CLOSED (a narrow, explicit exception to the
"CURRENT only" rule, scoped only to the old end of a linked pair).

`projectMemoryV3DialogueReadContext` (and its lifecycle sibling), which
today throws if an item's status isn't `active`/`supported`, is extended
to also accept a CLOSED status specifically when the item carries a
`replacesMemoryKey`/`replacedByMemoryKey` pointer — every other
validation rule is unchanged, and a bare CLOSED item with no such pointer
still fails exactly as it does today.

5 is a starting number, not derived from a hard constraint elsewhere — it
keeps this change's worst-case cost/token growth roughly the same order
of magnitude as the existing 12, while giving a handful of real life
changes room not to crowd each other out. It's a `LIMIT` in a migration,
not a schema shape, so it's cheap to retune later.

Protection is evaluated per pair (an item and its direct
`replacesMemoryKey`/`replacedByMemoryKey` partner), not transitively
across a whole chain — a 3-link chain where only the oldest item is
sensitive protects that oldest item and its immediate partner, not every
item in the chain. This keeps the selection query a simple join, not a
recursive walk, and matches the 5-slot budget's intent (a handful of
specific sensitive moments, not entire histories).

### 3. Weekly dynamics screen + weekly-reflection prompt

- `fetchCrossMemoryForUser` in `src/lib/conversationDynamicsView.ts`
  currently reads `public.user_memory`. It's replaced with a call to the
  existing `exportMemoryV3Data()` helper (`src/lib/memoryV3Viewer.ts`,
  already shipped for the data-export feature) rather than the narrower
  `fetchMemoryV3Items()`/`"read"` action: the export path already returns
  every kind including `hypothesis` and doesn't apply the regular
  viewer's status filtering, which matters here since a hypothesis
  resolving into a confirmed fact is exactly the kind of change this
  feature exists to show. This screen's job is the full history on
  demand, not what the live chat currently holds, so it deliberately does
  not go through the 12+5-item live-context RPCs at all.
- `projectMemoryV3ExportItems` (`supabase/functions/_shared/memoryV3/viewerProjection.ts`)
  gains the two new fields, `replacesMemoryKey`/`replacedByMemoryKey`,
  passed through unchanged from the stored item. `projectMemoryV3ViewerItems`
  (the regular Память screen's projection) is untouched — this feature's
  linkage data is only ever surfaced through the export path.
- `buildChangingView`'s `compareWeeklies` word-diff between two weekly
  snapshots is replaced by the real linked pairs: "new" items are the new
  end of every pair created since the last weekly snapshot, "faded"
  items are the old end of those same pairs. The heuristic phrase
  matching is removed, not kept as a fallback — it was a guess standing
  in for data that now exists for real.
- `buildWeeklyReflectionPrompt` in
  `supabase/functions/_shared/weeklyReflection.ts` gains one new context
  block (alongside the existing `memoryBlock`/`marksBlock`/
  `transcriptBlock`) listing linked pairs relevant to this conversation
  (dialogue) or account (lifecycle) since the last reflection. The
  prompt instructs the model that it may reference a pair if it fits
  naturally — including, at its own judgment, whether to connect it to
  work done in the app — matching the live-chat behavior exactly, per
  Настя's explicit ruling that this should depend on the situation rather
  than follow a fixed rule.
- This is the existing weekly button/screen Настя already described
  ("раз в неделю нажимал кнопку") — no new screen, no new edge function.

## Error handling

- A `create` whose `supersedesMemoryKey` doesn't match a target actually
  being closed in the same batch fails contract validation for the whole
  batch — same existing failure path as any other invalid cross-reference
  in this contract, no partial state.
- A `create` with no `supersedesMemoryKey` at all behaves exactly as
  today — linking is additive, never required for an ordinary correction
  to succeed.
- More than 5 eligible sensitive linked pairs at once: the RPC's `LIMIT 5`
  keeps the oldest ones out of the protected slots (not deleted — still
  visible in the Память screen and the weekly dynamics screen, which have
  no such cap), the same bounded-growth reasoning as the existing 12-cap.
- An account with zero linked pairs (new account, or simply hasn't had a
  correction since this ships) sees the dynamics screen's existing empty
  states — no crash, no special-cased error path.
- Pre-existing corrected/rejected facts from before this ships carry no
  link and are not retroactively given one — the dynamics screen treats
  them exactly like "no change to show from before this existed," not an
  error.

## Testing

- `dialogueContract.cases.test.ts` / `lifecycleContract.cases.test.ts`:
  `supersedesMemoryKey` accepted only when it matches a same-batch
  `reject`/`mark_stale` target; rejected when it references anything
  else (wrong batch, not being closed, malformed memory-key format), when
  two creates reference the same target, and accepted even when the
  create's own `kind` differs from the target's `kind` (unlike `revise`)
  — same assertion style already used for `targetMemoryKey` in this file.
- `dialogueReducer.cases.test.ts` / `lifecycleReducer.cases.test.ts`:
  a `create` with `supersedesMemoryKey` stamps `replacesMemoryKey` on the
  new item and `replacedByMemoryKey` on the old one; a `create` without
  it is byte-for-byte identical to today's output (regression safety).
- New migration test (`*.cases.test.ts`, SQL-pattern-matching convention,
  mirroring `viewerFirstSeenAtMigration.cases.test.ts`) for the new
  columns and the updated read-context RPCs.
- `dialogueReadStore.cases.test.ts` / `lifecycleReadStore.cases.test.ts`:
  `projectMemoryV3DialogueReadContext` accepts a CLOSED item only when it
  carries a link pointer; a bare CLOSED item with no pointer still throws
  exactly as today (regression test for the existing invariant).
- `viewerProjection.cases.test.ts`: `projectMemoryV3ExportItems` passes
  through `replacesMemoryKey`/`replacedByMemoryKey` unchanged when
  present and defaults them to `null` when absent; `projectMemoryV3ViewerItems`'s
  own tests are unchanged (regression — confirms the regular viewer
  path never gains these fields).
- `conversationDynamicsView.cases.test.ts` (new or extended): the
  `fetchCrossMemoryForUser` replacement calls `exportMemoryV3Data()`, not
  `user_memory` — a wiring-contract test in the same style as
  `context.cases.test.ts`, since this file has runtime Supabase
  dependencies plain Node/tsx can't import directly.
- `weeklyReflection.cases.test.ts`: the new context block appears in
  `buildWeeklyReflectionPrompt`'s output when linked pairs are passed,
  is absent when none exist, and the existing three blocks' tests still
  pass unchanged.

## Review Focus

- A `create` whose `supersedesMemoryKey` points at something **not**
  being closed in the same batch must be rejected outright, not silently
  accepted as a dangling, unvalidated pointer.
- An account with more than 5 eligible sensitive linked pairs: the cap
  must drop the *oldest* pairs from the protected slots, never silently
  exceed 5 or error.
- The existing per-conversation dynamics view and the regular Память
  viewer screen must be completely unaffected for an account with zero
  linked pairs — the most likely place a shared-helper change leaks into
  behavior nobody asked to change.
- Lifecycle items carry no `conversation_id` at all (account-wide), unlike
  dialogue items — an implementation that copies the dialogue-side logic
  for the lifecycle side must not accidentally introduce a conversation
  scoping condition that doesn't apply there.
- An account with years of pre-existing corrected/rejected facts from
  before this ships must not error or behave oddly in the weekly
  dynamics screen just because none of them carry a link.
