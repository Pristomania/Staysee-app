# Lifecycle Memory `life_context` Scope Tightening Design

**Goal:** Narrow what the lifecycle-scope ("сквозная память") Memory V3 reconciler admits into the `life_context` topic ("Факты профиля" in the UI) back to the same strict scope the pre-Memory-V3 system used — a compact, stable profile (who the person is) plus communication style — and explicitly exclude life events, transitions, decisions, and stories, even ones that remain true going forward.

## Context

The pre-Memory-V3 consolidation prompt (`supabase/functions/_shared/consolidateUserLifeMemory.ts`) used the same three category names lifecycle scope uses today (`life_context` / `communication` / `preference`) under an explicit rule: "Только стабильный профиль и стиль общения. Без theme/emotion/кризисов/историй/сомнений" — only a stable profile and communication style, without themes, emotions, crises, stories, or doubts.

The current Memory V3 lifecycle reconciler (`supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`, `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION`) inherited the three category names but not that constraint. Its rule 10 defines `life_context` only as "stable facts about the person's life situation," and rule 19's admission bar explicitly lists "relationship fact" among the things that pass the durability bar. Together these let the model treat a life event or a relationship's story — not just its stable existence — as admissible `life_context` content.

This surfaced for real on 25.09.2026: today's historical backfill of two real accounts' lifecycle memory produced `life_context` items such as "18-летний сын вступил в отношения с 30-летней троюродной сестрой... они съехались", "Разорвала отношения с племянницей", and "Впервые попросила своего мужчину остаться на ночь в отдельной комнате" — narrative/event content Настя does not want there. She wants it back to compact profile facts only, e.g. "обращаться в женском роде, есть сын 19 лет" plus a communication-style fact like "предпочитает прямо без воды".

**Explicitly out of scope:**
- The shared extractor (`supabase/functions/_shared/memoryV3/prompt.ts`) — frozen, parity-tested across both scopes, not touched by this change.
- Dialogue scope's own reconciler (`dialoguePrompt.ts`) and its `person` topic — Настя reviewed dialogue scope's own report today (relationship content tagged "Люди") and found it fine. Only lifecycle scope changes.
- The `communication` and `preference` topics' own admission rules — Настя's complaint is specifically about `life_context` absorbing event/story content, not about how `communication`/`preference` currently work.
- Cleaning up already-imported `life_context` data for the two accounts already backfilled today (Настя's own account, `day_and_night33@mail.ru`) — she confirmed this happens as a **separate, later step**: re-running the existing historical backfill tool for those accounts (already designed to always reprocess and replace) once this rule ships, not as part of this change itself.

## Design

**Where the rule lives:** entirely inside `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION` in `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts` — this is the only place lifecycle-scope topic admission is decided (confirmed by `docs/superpowers/specs/2026-09-23-memory-v3-topic-classification-design.md`'s "Architecture: where topic gets decided" section: topic is a reconciler decision, and lifecycle's reconciler instruction is its own file with no cross-file parity constraint against dialogue's).

**Rule 10 (topic definitions) changes from:**
> `life_context (stable facts about the person's life situation)`

**to:**
> `life_context (only a stable, static fact about who the person is: identity or role, a demographic fact such as age or gender, or the current existence of a family relationship such as having a child, spouse, partner, or pet -- never a life event, transition, decision, crisis, or story about what happened or changed, even one that remains true going forward)`

**Rule 19 (general durability bar, applies across all three topics) changes from:**
> `Ignore isolated ordinary actions and momentary difficulties, moods, or needs unless they have a durable consequence or reveal a stable preference, commitment, relationship fact, or recurring pattern.`

**to:**
> `Ignore isolated ordinary actions and momentary difficulties, moods, or needs unless they have a durable consequence or reveal a stable preference, commitment, or recurring pattern. A life event, transition, decision, crisis, or story about what happened is never durable lifecycle memory on its own, even when it remains true going forward -- only the underlying stable fact (see rule 10's life_context definition) may qualify, and only under that topic.`

Rule 19 keeps "stable preference, commitment... or recurring pattern" intact (still lets genuine `communication`/`preference` content through unchanged) and only removes "relationship fact" as its own admitting category, replacing it with an explicit cross-reference back to rule 10's now-narrow `life_context` definition. This means: a candidate that is really just a life event/story has nowhere left to land — it doesn't fit the narrowed `life_context`, and it was never a `communication`/`preference` fact to begin with — so the model's own rule 17 ("prefer ignore when... does not represent a meaningful lifecycle change") and rule 18 ("extractor admission is not lifecycle admission") naturally lead it to `ignore` that candidate, matching the old system's "Если нет устойчивого — верни []" behavior.

No schema change: `life_context`/`communication`/`preference` remain the exact same three enum values everywhere (`lifecycleContract.ts`'s `MEMORY_V3_LIFECYCLE_TOPICS`, the DB `CHECK` constraint, the viewer). Only the natural-language meaning of `life_context` narrows. This is a pure prompt-text change plus its own test file's mirrored expectation.

## Testing

`supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` holds a byte-for-byte copy of the whole system instruction in a local `EXPECTED_SYSTEM` string and asserts `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION === EXPECTED_SYSTEM` — this must be updated to match rules 10 and 19's new text exactly, or the test fails immediately (this is the test's job: catching exactly this kind of drift).

No other test in the codebase asserts on the natural-language meaning of `life_context` — every other reference (`lifecycleContract.cases.test.ts`, `lifecycleReducer.cases.test.ts`, `viewerProjection.cases.test.ts`, `lifecycleTransport.cases.test.ts`, migration tests, etc.) uses `"life_context"` purely as a valid enum string in schema/plumbing tests, unaffected by narrowing what content earns that label. Confirmed by search; the plan does not need to touch these files.

## Rollout after this ships

Not part of this plan's own scope, but the agreed next step once this PR merges and deploys: re-run the already-built lifecycle historical backfill tool (`scripts/memory-v3-pilot/lifecycle-history-backfill-*`) for the accounts already backfilled today under the old rule (Настя's own account, `day_and_night33@mail.ru`), so the new, narrower rule reprocesses and replaces their existing `life_context` items. The tool already reprocesses and replaces by design (Настя's own earlier decision, 24.09.2026) — no new capability needed for this. The son's account (`pisnaapisa00@gmail.com`) backfill, currently paused, resumes under the new rule directly rather than needing a second pass.
