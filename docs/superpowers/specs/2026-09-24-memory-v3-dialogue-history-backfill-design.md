# Memory V3 Dialogue-Scope Historical Backfill — Design

**Status:** Approved by Настя, 2026-09-24. Ready for implementation planning.

## Problem

Dialogue-scoped Memory V3 went live as a canary on Настя's own account
yesterday, but has accumulated almost no real data yet (the topic backfill
script found 0 untagged dialogue items — there simply isn't much there).
Before trusting dialogue-scoped memory (and its new topic classification)
more broadly, Настя wants to see how the system actually behaves on her
own real historical data: ~1100+ messages across all of her conversations,
processed through the extractor + reconciler pipeline, with facts and
topics distributed per-dialogue instead of into one account-wide pile.

An existing tool, `scripts/memory-v3-pilot/lifecycle-history-backfill-*.ts`,
already does exactly this kind of historical replay — but only for the
account-wide ("lifecycle") scope. It's what originally populated Настя's
own account's ~40 lifecycle memory items. It has no dialogue-scope
awareness at all (its own design predates dialogue isolation by two days).

## Goals

- Reprocess Настя's entire real message history (all conversations, no
  subset — her explicit choice) through the same extractor + reconciler
  pipeline already used live, but scoped per conversation instead of
  per account.
- Let her review the results in a genuinely readable, plain-Russian
  report — not just a technical JSON file — before anything touches the
  real dialogue memory tables.
- Reuse the existing lifecycle tool's architecture and safety mechanisms
  as closely as possible: same source-reading/pagination/chunking logic,
  same cost-ceiling and price-snapshot safety gates, same two-step
  separation between "spend money and produce a result" and "commit that
  result to production."

## Non-goals

- Not building a subset/selective-conversation mode for this first run —
  Настя explicitly chose to process everything at once.
- Not changing anything about the live, incremental dialogue-scope
  pipeline (`dialogueShadowRunner.ts` and everything it calls) — this is
  a separate, one-time historical tool, exactly like its lifecycle
  sibling is separate from the live `lifecycleShadowRunner.ts`.
- Not building a general-purpose "re-run history for any scope" abstraction
  — YAGNI. This mirrors the lifecycle tool's concrete shape for dialogue
  scope specifically, the same way every other lifecycle→dialogue port
  this project has done was a concrete mirror, not a generalized framework.

## Architecture

### What's already scoped per-conversation (fully reusable, unchanged)

Reading `lifecycle-history-backfill-source.ts` and
`lifecycle-history-backfill-engine.ts` confirms the source-reading and
chunking layers already operate per-conversation: `listConversationsPage`
enumerates a user's conversations, `listMessagesPage` reads one
conversation's messages, and the resulting `chunks` each carry their own
`conversationId`/`conversationOrdinal`. The extractor call
(`buildMemoryV3ExtractorRequest`) is already scope-agnostic. None of this
needs to change for dialogue scope — it's reused as-is.

### What changes: state threading and the final write

In the existing lifecycle engine's main loop (`runLifecycleHistoryBackfill`
in `lifecycle-history-backfill-engine.ts`), a single
`state = createEmptyMemoryV3LifecycleState({ userId })` is threaded
sequentially through *every* chunk of *every* conversation — the whole
account accumulates into one shared state object, which is what makes it
lifecycle-scoped.

The dialogue-scope version groups chunks by `conversationId` and resets to
a fresh `createEmptyMemoryV3DialogueState({ userId, conversationId })` at
the start of each conversation's own chunk sequence — chunks within one
conversation still thread state sequentially (a conversation can span
multiple chunks), but state never carries over between different
conversations. Each conversation ends with its own independent final
state, tracked separately in the result (per-conversation success/failure,
not one account-wide verdict).

Everything else in the per-chunk loop — extractor call, `normalizeMemoryV3LayeredResponse`,
building the reconcile request, the reconciler call, `validateMemoryV3DialogueProposal`,
`applyMemoryV3DialogueStep` — already exists in production
(`dialogueTransport.ts`, `dialogueReducer.ts`, `dialoguePrompt.ts`,
`dialogueContract.ts`, all shipped and live) and is reused directly, the
same way the lifecycle engine reuses the lifecycle equivalents.

**Correction after reading `lifecycle-history-backfill-contract.ts` in
full:** `prepareLifecycleHistoryBackfill`'s final step
(`chunks.sort(comparePreparedChunks)`) sorts ALL chunks from ALL
conversations into one GLOBAL timeline by `lastCreatedAt` — chunks
belonging to the same conversation are NOT necessarily adjacent in the
resulting array; they can be interleaved with other conversations' chunks.
The dialogue-scope engine must explicitly GROUP `prepared.chunks` by
`conversationId` into separate buckets (e.g. a `Map`) before processing —
it cannot assume "conversation changed" is detectable by just watching
adjacent array entries.

**Correction on when the "already has live data" skip happens:** doing
this check only at the import step (as an earlier draft of this design
said) means the paid run would spend real money extracting and
reconciling a conversation whose result then gets thrown away at import.
Instead: the inspect/paid-run stage queries each conversation's current
dialogue-state emptiness up front (reusing the same DB connection the
source reader already has) and excludes any non-empty conversation's
chunks from what gets paid for at all — this is a cost-avoidance filter,
not a correctness gate. The import step keeps a defensive re-check
immediately before writing (mirroring the existing lifecycle RPC's own
paranoia about re-verifying state right before a write) but now RAISES a
clear error for that one conversation if something changed between the
filter and the import (e.g. new organic messages arrived in between and
the conversation is no longer empty) rather than silently skipping at that
late stage — money was already spent on it by then, so Настя should be
told plainly rather than have the result quietly dropped.

### Two-step process, mirroring the lifecycle tool's own separation

Reading `lifecycle-history-backfill-import.ts`/`-import-run.ts` in full
(not just inferring from file names, corrected after an earlier
draft of this doc got this partly wrong) confirms the real shape:
`lifecycle-history-backfill-run.ts`/`-cli.ts` do the PAID
extraction+reconciliation and produce a `finalState` per (in this case)
conversation, an `artifact` JSON file, and a `semanticReviewPacket`;
`importReviewedLifecycleHistory` (in `-import.ts`) then requires TWO more
things before it will write anything to production:

1. A **review decision file** — not a verbal "looks fine," but a structured
   JSON file listing every single item from the artifact with an explicit
   `semanticVerdict: 'PASS'`, cryptographically tied to the exact reviewed
   artifact via a SHA-256 digest match (`payloadSha256`) — approving a
   different or changed result is rejected outright. Настя should never
   have to hand-write this: the dialogue-scope tool auto-generates it from
   the artifact once she has read the plain-Russian report (below) and
   said "выглядит нормально" — a thin wrapper, not a manual JSON-editing
   task for her.
2. A **fresh re-read of the live message source at import time**
   (`validateFreshSource`), which re-fetches her conversations/messages
   from the database and recomputes the same chunk digests the paid run
   used, failing the import if anything changed since — guards against
   importing a result that no longer matches her actual message history
   (e.g. she sent more messages in between the two steps).

Both mechanisms carry over into the dialogue-scope version unchanged in
spirit: an auto-generated (not hand-written) approval file gated on
reading the plain-Russian report first, and a fresh-source re-check at
import time, now re-verified per conversation instead of once for the
whole account.

The dialogue-scope version keeps this same two-command shape:
1. **Разбор (paid, produces a local result — no production write):** reads
   history, spends money classifying and reconciling, writes a JSON result
   file (mirroring the lifecycle tool's own output format, extended with
   `conversationId`/`topic` per item) AND a plain-Russian readable report
   (see below) to local files. Nothing in the production database changes.
2. **Перенос в память (separate command, no paid calls):** after Настя has
   read the plain-Russian report from step 1 and confirmed it looks right,
   a small approval-file helper stamps the matching auto-generated
   review-decision file, then the import command re-verifies the live
   source is unchanged and writes into the real
   `memory_v3_dialogue_items`/`_evidence` tables, one conversation's state
   at a time, via a new bulk-import RPC (see Storage below).

### Conversations that already have live dialogue data

Dialogue-scoped Memory V3 has been running as a canary on Настя's account
since yesterday, so a conversation that has already crossed the 10-new-
message threshold organically may already have a non-empty, non-zero-
revision dialogue state before this historical tool ever touches it — the
lifecycle import RPC's own equivalent check (`p_expected_state_revision:
0`, `validateHead` requiring `itemCount: 0`) confirms the *lifecycle*
tool only ever targets a completely empty starting state.

**Correction after Настя's explicit choice (2026-09-24):** an earlier
version of this design skipped any conversation that already had live
data, reasoning from the lifecycle tool's own account-wide "empty only"
rule. Настя explicitly rejected that for dialogue scope: her most active
conversation is exactly the one most likely to have already accumulated
some organic dialogue memory (and keeps growing daily), and skipping it
would mean the one conversation she most wants a full, careful historical
read of never gets reprocessed at all. She confirmed, when asked directly
("skip it" vs. "reprocess and replace it anyway"): **always reprocess and
replace**, even when a conversation already has live data.

**Decision:** the dialogue-scope import step no longer treats "already
non-empty" as a reason to skip. It reprocesses and overwrites every
conversation's dialogue state, whether it started empty or not. What it
still guards against — narrower than before, but not removed — is a
*race*: at the paid-run/inspect stage, the tool records each conversation's
current state revision at that moment (`expectedStateRevision`, per
conversation, part of the manifest). At import time it re-checks that the
conversation's *actual* current revision still matches that recorded
value. If it does, the import proceeds and overwrites. If it doesn't (the
live incremental pipeline wrote something new to that exact conversation
in the days between the paid run and the import — plausible for her most
active chat), the import for that one conversation is rejected with a
clear, named error instead of silently overwriting newer real data it
never saw — the same "tell her plainly, don't destroy silently" principle
as everywhere else in this project, just no longer gated on emptiness.
Every other conversation in the same import batch is unaffected by one
conversation failing this check.

The plain-Russian report must say, per conversation, whether it replaced
existing live records or wrote into an empty one — this is now a
genuinely destructive operation for a conversation that already had data,
and Настя should never be surprised by that after the fact.

### Readable report (new, doesn't exist in the lifecycle tool)

The existing lifecycle tool's own review artifact
(`buildLifecycleHistoryReviewPacket`) is a JSON file meant for a technical
reviewer. Настя is not a technical reader, so this design adds a second,
plain-Russian text report generated from the same result data: grouped by
conversation, each surviving item's claim and its assigned topic label (Люди/
Факты/Предпочтения общения), skipping internal fields (memory keys,
evidence rows, hashes) entirely. This is purely a formatting layer over
data the JSON result already contains — no new extraction logic, no new
model calls.

### Storage: one new migration

There is no dialogue-scope equivalent of the lifecycle historical bulk-
import RPC (`import_memory_v3_lifecycle_backfill_state`, migration `037`,
patched for topic in `049`) — the live dialogue-scope write path
(`apply_memory_v3_dialogue_state`) is designed for one incremental
reconcile at a time, not a bulk historical replacement of an entire
conversation's item set. A new migration adds
`import_memory_v3_dialogue_backfill_state(p_import_id, p_user_id,
p_conversation_id, p_expected_state_revision, p_artifact_digest,
p_source_snapshot_digest, p_source_cutoff, p_profile_id,
p_pipeline_version, p_extractor_version, p_reconciler_version, p_state
jsonb)`, mirroring `037`'s parameter list and shape exactly but scoped by
`(user_id, conversation_id)` instead of just `user_id`, matching how every
other lifecycle→dialogue table/RPC port this project has done added the
conversation-scoping key. Unlike the lifecycle original (which hardcodes
`p_expected_state_revision = 0`, since it only ever imports into a
genuinely empty account-wide state), this RPC accepts whatever revision
the conversation actually had when the paid run inspected it — 0 for a
conversation that was empty, or higher for one that already had organic
live data — and simply requires the conversation's *current* revision to
still match that value at import time, RAISING if it doesn't (see the
"Conversations that already have live dialogue data" section above). It
always overwrites (deletes then re-inserts) whatever items already exist
for that conversation once the revision check passes.

### Cost and safety controls: reused unchanged

The exact same mechanism from `lifecycle-history-backfill-profile.ts`
(price-snapshot validation, `calculateLifecycleHistoryBudget`, a hard
ceiling, the `--inspect-source` dry-run mode that estimates cost with zero
paid calls, the `--expected-source-sha256` safety gate against silently
reprocessing a changed message set) is reused for the dialogue-scope tool
without modification to its logic — only re-pointed at dialogue-scope
message grouping and cost accounting. Настя explicitly already accepted
this will be real "technical" spend (the `cost_category: 'technical'`
split she requested yesterday exists partly for exactly this).

### Division of labor (unchanged project-wide rule)

I cannot run anything that spends real money or touches the production
database — same restriction as every other production-facing action this
entire project. The safe, free `--inspect-source`-equivalent dry run (cost
estimation only, zero paid calls) is something I can run and verify
myself. The actual paid разбор run and the separate перенос-в-память
import step are manual steps Настя runs herself from her own terminal,
same division of labor as the topic-classification backfill script
yesterday.

## Testing

Same discipline as every other change in this project: structural/unit
tests for the new per-conversation state-grouping logic (mirroring the
existing `lifecycle-history-backfill-engine.test.ts`'s style), a new
migration structural test for the new import RPC (mirroring
`backfillImportTopicMigration.cases.test.ts`'s pattern), and the plain-
Russian report generator gets its own tests asserting on real formatted
output for a small synthetic result, not just "doesn't crash."
