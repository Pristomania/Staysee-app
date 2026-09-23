# Memory V3 Topic Classification — Design

**Status:** Approved by Настя, 2026-09-23. Ready for implementation planning.

## Problem

Настя shipped PR #56 today, which grouped the new "Умная память" viewer section
by `kind` (`event` vs `recurrence`). She looked at it and rejected the
grouping: it doesn't match how the two pre-existing memory screens group
records, and — more importantly — it doesn't tell her *what a record is
about*. She asked for the same kind of topical grouping the old screens
already use, and for new records to be correctly routed into the right topic
themselves, not just relabeled for display.

The two old screens group by topic today:
- **Память беседы** (`src/lib/memoryDisplay.ts`, `MEMORY_DISPLAY_SECTIONS`):
  Люди, Факты, Предпочтения общения, Темы беседы, Незавершённое.
- **Сквозная память** (`src/lib/memoryUi.ts`, `GLOBAL_MEMORY_TYPE_LABELS`):
  Факты профиля, Стиль общения, Что помогает в контакте.

Memory V3 has no topic concept at all today. Its only classification axis is
`kind` (event | recurrence | hypothesis), which describes *how certain or
repeated* a claim is — orthogonal to what subject area it's about.

## Goals

- Give every Memory V3 item (both account-wide/"lifecycle" and per-dialogue
  scopes) a `topic` field, classified by AI (not keyword/regex guessing,
  consistent with every other classification decision in this system).
- Group the viewer display by topic, using scope-appropriate topic sets that
  match the old screens' language and the old screens' spirit.
- Classify existing untagged items via a one-time backfill pass.
- Track the backfill's AI spend, and establish a general
  automatic-vs-technical spend split for future manual/test AI calls.

## Non-goals

- Topic is display-only. It is never injected into the live chat prompt or
  used anywhere Stacy's replies are shaped. Confirmed with Настя explicitly.
- No change to the extractor prompt (`prompt.ts` /
  `extractor-prompt-v2.mjs`) or its byte-parity test. Topic classification
  lives entirely in the reconciler step (see Architecture).
- No change to the old "Память беседы"/"Сквозная память" screens' own
  behavior for existing accounts — they are untouched.
- Does not build the new single-screen interface for new accounts (already
  planned separately per the viewer-screen design from PR #54) — this design
  only supplies the topic data and the per-scope label sets that interface
  will eventually consume.

## Topic taxonomies

Two independent, closed sets — mirroring the two old screens, minus the
categories that don't fit Memory V3's durable-only admission rule:

**Dialogue scope (this conversation):**
| value | label |
|---|---|
| `person` | Люди |
| `fact` | Факты |
| `preference` | Предпочтения общения |

(`Темы беседы` and `Незавершённое` are intentionally excluded — both are
about the *current* conversational moment, and Memory V3 never stores
anything non-durable. See "Темы беседы in the new single-screen interface"
below for how that gap is covered without touching Memory V3's own rules.)

**Lifecycle scope (account-wide):**
| value | label |
|---|---|
| `life_context` | Факты профиля |
| `communication` | Стиль общения |
| `preference` | Что помогает в контакте |

Each scope's set is enforced by a `CHECK` constraint on its own table —
lifecycle items can never carry a dialogue-only topic value or vice versa.

## Темы беседы in the new single-screen interface

New accounts (per the earlier viewer-screen design) will eventually see one
merged screen instead of two. Настя confirmed: that screen must still show
"Темы беседы", even though Memory V3 will never produce it. The old simple
per-conversation summarizer already runs quietly in the background for new
accounts today (as the documented emergency fallback, so the dialogue never
breaks if Memory V3 fails). This design reuses that already-running output's
`themes` field as a fourth, always-present display group next to the three
Memory V3 topics — no new extraction logic, no change to Memory V3's rules.
(Wiring this into the actual merged screen is scoped to a later, separate
plan; this design only records the decision so the topic model doesn't
accidentally try to reinvent it.)

## Architecture: where topic gets decided

Topic is decided by the **reconciler** step, not the extractor:

- The extractor (`prompt.ts`, shared by both scopes, frozen/parity-tested
  against the offline pilot script) is untouched. It has no concept of
  scope-specific topic sets and doesn't need one.
- The reconciler is already scope-specific — `lifecyclePrompt.ts` and
  `dialoguePrompt.ts` are separate files with separate system instructions,
  with no cross-file parity constraint. Each gets its own topic enum added
  to its own instructions.
- The reconciler already decides `create` / `confirm` / `revise` /
  `mark_stale` / `reject` / `ignore` per candidate. Topic classification
  attaches to that same decision:
  - `create`: topic is required (a fresh classification for a brand-new
    item).
  - `revise`: topic is required and re-decided from scratch — Настя was
    explicit that if a claim's meaning changes (e.g. "живёт в Москве" →
    "переехала в Казань"), the topic should be free to move with it, not
    stay pinned to whatever it was first classified as.
  - `confirm` / `mark_stale` / `reject` / `ignore`: topic is not part of
    these operations at all. The stored item's existing topic is left
    exactly as it is.
- Every operation's JSON shape keeps a fixed 4-key shape (`type`,
  `candidateRef`, `targetMemoryRef`, `topic`) so the schema stays uniform:
  `create`/`revise` require `topic` to be one of that scope's enum values;
  every other operation type requires `topic: null`. This mirrors the
  existing pattern in `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION` where
  `targetMemoryRef` is required or forbidden depending on operation type.

## Storage

`memory_v3_lifecycle_shadow_items` and `memory_v3_dialogue_items` each get a
new `topic text` column with their own `CHECK (topic IS NULL OR topic IN
(...))` constraint (scope-specific enum from the table above). Nullable,
not `NOT NULL` — a migration is instant, but classifying existing rows
needs one AI call per item (see Backfill below), so the two steps cannot
happen atomically. New migrations, following the same `CREATE OR REPLACE
FUNCTION` pattern used all session for touching these RPCs:
- The "apply proposal" RPC that writes reconciler operations into storage
  gains `topic` in its `INSERT ... SELECT` column list, sourced from the
  operation JSON for `create`/`revise`, and left untouched (existing value
  preserved) for every other operation type.
- The two viewer-read RPCs added yesterday (migration `043`) gain `topic` in
  their returned JSON.
- The TypeScript contracts (`lifecycleContract.ts`, `dialogueContract.ts`)
  and reducers (`lifecycleReducer.ts`, `dialogueReducer.ts`) gain matching
  validation and propagation logic.

Existing rows (Настя's ~40 migrated items, plus everything the canary
account has accumulated the last two days) have no topic yet and will show
`topic: null` until the backfill script (below) runs. The viewer groups any
`null`-topic item into a small "Разное" bucket rather than hiding it, so
nothing silently disappears while the backfill is pending. Once the
reconciler always requires a topic on `create`, and the backfill has run
once for the pre-existing rows, "Разное" should stay empty from then on —
if it isn't, that's a signal something upstream stopped setting topic
correctly.

## Backfill

A one-time script (mirroring the shape of the existing
`scripts/memory-v3-pilot/` tooling) reads every item lacking a topic, sends
each one to the AI with a small classification-only prompt (claim + kind +
scope → one topic value from that scope's enum), and writes the result back.
Настя explicitly wants this run for real (not skipped) — she wants to see
how accurate the model actually is at this before trusting it for new
records going forward.

This is a deliberately separate, manual step — not part of the live
extractor/reconciler pipeline, run once by whoever executes the plan
(me or Настя, same division of labor as every other manual step this
session: I cannot run anything against the live production database myself
per the standing `[Production Reads]`/`[Secret-Store Writes]` restriction,
so the actual invocation against the production project is a step Настя (or
a script she runs) performs, same as the two canary secrets she set
yesterday).

## Cost tracking: automatic vs technical

Настя asked for a general split in the existing spend table
(`ai_usage_logs`, built in PR #52 today): a `cost_category` column with two
values, `automatic` and `technical`.

- New column: `cost_category text NOT NULL DEFAULT 'technical' CHECK
  (cost_category IN ('automatic', 'technical'))`.
- The default is `technical` deliberately — Настя pointed out that
  everything spent so far is development-phase spend (there are no real
  outside users yet), so every existing row should land in `technical`
  automatically when the column is added, with no separate backfill UPDATE
  needed.
- From this point forward, every call site that fires automatically in
  response to real user activity (the main chat reply, conversation
  summarization, cross-memory synthesis, and both Memory V3
  extractor/reconciler stages for both scopes) explicitly logs
  `cost_category: 'automatic'`.
- Anything manual or one-off (this topic backfill script, and any future
  smoke test or similar non-automatic invocation) logs `cost_category:
  'technical'` — or simply omits the field and gets the default, though the
  plan should log it explicitly for clarity rather than relying on the
  default silently doing the right thing.
- This establishes the pattern for good going forward: any new one-off
  script that spends money on a model call must set `cost_category:
  'technical'` explicitly, matching what Настя asked for as a durable rule,
  not just a one-time fix for this backfill.

## Frontend

- `MemoryV3ViewerItem` (both `src/lib/memoryV3Viewer.ts` and the two viewer
  RPCs) gains `topic: string`.
- `MemoryV3ItemList.tsx` (just reworked in PR #56 to group by `kind`) is
  reworked again to group by `topic` instead, driven by a label map passed
  in per scope (dialogue list uses the 3-entry dialogue label map, lifecycle
  list uses the 3-entry lifecycle label map) — same "top 5 per group, rest
  behind Показать ещё" behavior PR #56 already established, just keyed on
  the new field.
- `MemoryScreen.tsx`'s existing "Умная память" section is updated to pass
  the correct label map to each of its two `MemoryV3ItemList` usages
  (dialogue-scoped vs account-wide).

## Testing

Same discipline as every other change this session:
- New reconciler operation-schema tests (topic required/forbidden per
  operation type, scope-specific enum enforcement) in
  `lifecyclePrompt.cases.test.ts` / `dialoguePrompt.cases.test.ts`.
- New reducer tests confirming `create`/`revise` write the topic and every
  other operation type leaves it untouched.
- New migration structural tests mirroring the existing
  `*MigrationMigration.cases.test.ts` pattern for the new columns and CHECK
  constraints.
- New viewer projection/RPC tests confirming `topic` round-trips end to end.
- New frontend tests are not applicable (this project has no React
  component test harness, confirmed multiple times already this session) —
  verification stays at `npm run typecheck` / `eslint` / `npm run build`,
  same as PR #54 and #56.
- Full `_shared/memoryV3` suite and `staysee-chat`/`memory-v3-viewer` type
  checks compared against pre-change baselines, as with every prior change
  today.
