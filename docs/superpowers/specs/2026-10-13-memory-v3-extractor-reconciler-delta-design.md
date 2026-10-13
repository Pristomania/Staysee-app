# Memory V3 Extractor/Reconciler Delta Windowing — Design

## Why

While designing StaySee's first paid tariffs, Настя asked for a real,
non-guessed per-message cost. The investigation found that one user
message currently triggers three independent model calls, not one:

1. The main chat reply (`openai/gpt-4o`, ~4500 input / ~80 output tokens).
2. Memory extraction (`google/gemini-3.7-flash`, ~4200 input / ~617 output).
3. Memory reconciliation (`google/gemini-3.7-flash`, ~5400 input / ~134 output).

Combined, this is the largest share of real per-message cost (~2.2-2.25₽),
and it is driven almost entirely by three specific, avoidable patterns in
calls 2 and 3, not by the main reply:

- **No delta.** The extractor re-sends the conversation's last 60 messages
  in full on every run, regardless of how much of that window was already
  analyzed in a prior successful run. The infrastructure to avoid this
  already exists — every successful run already records
  `source_last_message_id` / `source_last_created_at` — but nothing reads
  it back to narrow the window.
- **The conversation is sent three times per exchange**, not two: the
  reconciler's request bundle independently re-includes the same raw
  messages the extractor already received, on top of its own separate
  system instruction and the full existing memory state.
- **The reconciler is shown the user's entire accumulated memory**, not
  the part relevant to what the extractor just found.

This matches published practice for memory systems, not just our own
reading of the code:

- **[Mem0](https://arxiv.org/abs/2504.19413)** uses the same two-call shape
  we do (extraction, then a separate update/reconcile call) — this is not
  something to collapse into one call; Mem0's own architecture keeps it
  split for the same reason our reducer does: a narrower, single-purpose
  step is more reliable than one call juggling extraction and comparison
  at once. But Mem0's extraction window is **10 message pairs**, not 60,
  and its update step retrieves only the **top-5 semantically similar**
  existing memories per candidate, never the whole memory store.
- **[Zep](https://help.getzep.com/retrieving-context)** passes 4-6 recent
  messages for context during retrieval.
- **[LangGraph](https://github.com/langchain-ai/docs/blob/main/src/oss/langchain/short-term-memory.mdx)**
  summarizes once a conversation passes ~4000 tokens and keeps the last 20
  messages afterward.

A second, independent AI agent Настя consulted separately reached the same
conclusion and proposed the concrete design below; this spec adopts it.

## Explicitly out of scope (decided, not deferred by oversight)

- **Merging the extractor and reconciler into one call.** Rejected twice —
  once on the general principle that a narrower step is more reliable, and
  again because Mem0 (a serious, widely-used reference implementation)
  deliberately keeps them separate too. Not revisited by this spec.
- **Vector/semantic search to narrow the reconciler's existing-memory
  input** (Mem0's top-5 retrieval). Настя was interested in this
  direction, but it is a separate, larger change (needs embeddings, a
  vector index, a new retrieval path) — not bundled into this delta-
  windowing spec. A candidate for a future spec once this one ships and
  its real savings are measured.
- **Changing ChatGPT-style tool-call-based memory** (writing memory inline
  during the main reply instead of as separate calls). Настя flagged this
  as an interesting long-term reference (Stacy was originally a GPTs
  persona) but explicitly did not choose it as the current direction — it
  would mean redesigning the main reply's own call, not just the memory
  pipeline, and carries real risk to the "было→стало" contradiction-
  tracking depth the current two-step design gives us. Not part of this
  spec.
- **Changing the daily/count gates themselves** (dialogue: unthrottled by
  product decision; lifecycle: 10 new per-conversation messages since the
  last succeeded run, restored in migration 077 / PR #121). This spec
  changes what a triggered run *reads*, never *whether* it triggers.

## Current architecture (both pipelines, same shape)

`dialogueShadowRunner.ts` and `lifecycleShadowRunner.ts` are structurally
parallel. Both, on every triggered run:

1. Call `loadMessages(userId, conversationId)` — always the last 60
   messages of that one conversation, newest-first, no cursor.
2. Build the extractor request: a fixed system instruction (shared rules +
   pipeline-specific scope policy, ~1600-1900 tokens) + every loaded
   message, full text, both `user` and `assistant` roles.
3. Call the extractor adapter; log usage; parse into candidate items +
   evidence rows (each evidence row cites an exact `sourceMessageId`).
4. Build the reconciler request: its own fixed system instruction
   (~1900 tokens) + **the same loaded messages again** + the full existing
   state (`state.items`, every stored fact for this scope) + the
   candidates/evidence from step 3.
5. Call the reconciler adapter; log usage; validate the proposal; apply it
   via `compareAndSwap`; persist the run as `succeeded` or `failed`.

## Design

### 1. Delta-aware message loading

`createMemoryV3MessageLoader` (in `messages.ts`) gains a second loading
mode. The shadow runners look up the watermark **before** calling it:

```
last succeeded run for (userId, conversationId)?
  none  -> full last-60-message window (today's existing behavior, unchanged)
  found -> messages with created_at > that run's source_last_created_at
           (the delta), plus the 5 messages immediately before that cursor
           for continuity
```

This lookup already has a home: it's the same `source_last_message_id` /
`source_last_created_at` columns `memory_v3_dialogue_runs` and
`memory_v3_lifecycle_shadow_runs` already carry on every run row. Dialogue
has no reservation-level watermark gate (left unthrottled, per Настя's
standing decision) but **can still look up its own last succeeded run's
cursor purely to decide what to load** — the delta-window optimization and
the "should this run happen at all" gate are independent; this spec only
touches the former.

**Hard cap:** regardless of how large the delta is, the extractor's
message payload is capped at **4000 estimated tokens** (via the project's
existing `estimateTokens`, chars/3.5). If the delta + 5-message context
would exceed that, truncate from the oldest end of the delta first (keep
the most recent messages, since those are what the user just said that
triggered this run) — never silently drop the 5-message context block,
since that's what keeps a short delta interpretable.

### 2. Reconciler input: evidence-only, not the delta again

The reconciler's request bundle stops including `dialogue.messages`
wholesale. Instead, it includes only:

- The messages whose `id` appears as a `sourceMessageId` in the new
  extraction's own evidence rows (candidates from step 3 above) — **not**
  evidence belonging to already-stored items. Existing items are compared
  by their already-finalized `claim`/`status`/`sensitivity`/dates, not by
  re-reading their original source text.
- The full existing `state.items` (unchanged — the reconciler's whole job
  is comparing against these; narrowing this is the separate, deferred
  semantic-search work).
- The new candidates + their evidence (unchanged).

This is a request-shape change in `buildMemoryV3DialogueReconcileRequest` /
`buildMemoryV3LifecycleReconcileRequest` (both in `*Prompt.ts`): instead of
passing `dialogue.messages` through verbatim, filter to the cited subset
before building the bundle.

### 3. Empty-extraction fast path (no-op), exact contract

When the extractor's parsed result has zero items (nothing worth
remembering found in the delta), the reconciler call is skipped entirely.
This must be assembled as a fully-formed **successful** result, not an
early return, so every downstream consumer (tests, the run-status read
path, the next run's watermark lookup) sees a normal `succeeded` row:

| Field | Value |
|---|---|
| `state` | unchanged (same object passed in) |
| `changed` | `false` |
| `stateRevision` | unchanged |
| `extraction.items` / `.evidence` | `[]` |
| `operations` | `[]` |
| `transitions` | `[]` |
| extractor usage | logged normally (it was a real, paid call) |
| reconciler usage | `null` (never called) |
| `compareAndSwap` | **called** with `changed: false` — this is how the run gets persisted as `succeeded` and how the watermark advances; it must not be skipped |
| run `status` | `succeeded`, with `completed_at` set |

**Watermark correctness (the part that must not regress):** a run's
`source_last_created_at` only becomes the next lookup's cursor once that
run's status is `succeeded`. A `reservation_failed`, `extractor_transport_failed`,
or `state_conflict` run must never advance what the next run's delta
query reads from — those messages were never actually analyzed, and must
be re-offered next time, not silently treated as "already checked" because
an unrelated later run happened to succeed and moved to the day's cap. This
mirrors exactly the bug just fixed in migration 077 for the lifecycle
*trigger* gate; this spec applies the same "only `succeeded` counts" rule
to the *delta read cursor*, which is the same column but a different
consumer (the message loader, not the reservation gate).

### 4. Scope: both pipelines, same shape, separately testable

Dialogue and lifecycle get the identical delta-windowing and evidence-only
treatment, applied independently (two call sites, two test suites) — they
already share this structural shape today, so there is no new asymmetry to
design around.

## Files touched

- `supabase/functions/_shared/memoryV3/messages.ts` — delta-aware loader mode.
- `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts` /
  `lifecycleShadowRunner.ts` — watermark lookup before loading, empty-
  extraction fast path, `compareAndSwap` no-op call.
- `supabase/functions/_shared/memoryV3/dialoguePrompt.ts` /
  `lifecyclePrompt.ts` — reconciler bundle: evidence-only message subset
  instead of the full delta.
- Existing contract/reducer files are **not** changed in shape — this spec
  changes what goes *into* a request, not the validated request/response
  schemas themselves.

## Testing

Per-pipeline (dialogue and lifecycle each need their own cases, mirroring
the existing `*ShadowRunner.cases.test.ts` convention):

- First-ever run for a conversation still gets the full last-60 window.
- A run with an existing succeeded prior run gets only the delta + 5
  messages of leading context, not the full 60.
- The 4000-token cap truncates from the oldest end of the delta, never
  drops the leading-context block.
- Reconciler's request includes only the new candidates' evidence
  messages — not the full delta, not existing items' original evidence.
- Empty extraction: reconciler adapter is never invoked; `compareAndSwap`
  is called exactly once with `changed: false`; run ends `succeeded`.
- A failed run (any diagnostic) does not move the next run's delta cursor
  — the following run's loaded window still starts from the last
  *succeeded* run, proven by constructing a fail-then-succeed-then-fail
  sequence and asserting the final run's loaded delta boundary.
- A concurrent run cannot have its watermark read clobber a newer
  succeeded run's cursor (same race-safety class already covered for
  `compareAndSwap` itself — mirror that pattern for the new lookup).

## Review Focus

- Does the 4000-token cap ever truncate away the *only* evidence message
  evidence a candidate claim depends on, leaving the reconciler a candidate
  whose cited `sourceMessageId` isn't in its own input? (Would fail the
  reconciler's existing evidence-must-cite-a-known-message validation —
  confirm this surfaces as a clean `reconciler_contract_invalid`, not a
  silent wrong answer.)
- A conversation whose first-ever run already has >60 messages by the time
  Memory V3 first becomes eligible for it (e.g. a long conversation from
  before rollout) — confirm the existing 60-message cap for "first run"
  still applies unchanged, not accidentally widened.
- Two conversations of the same user, for lifecycle specifically: confirm
  each conversation's delta cursor is independent (per-conversation, per
  migration 053/077), not accidentally shared.
