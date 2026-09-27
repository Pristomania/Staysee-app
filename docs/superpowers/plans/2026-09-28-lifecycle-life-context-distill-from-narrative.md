# Lifecycle `life_context` — Distill Stable Facts From Narrative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Second follow-up correction to lifecycle memory's `life_context` rule (after PR #70 and PR #71). Real backfill runs today showed the current rule was too strict in one specific way: it treats *any* sentence that references a past event or someone else's story as fully excluded, even when that same sentence also reveals a current, stable structural fact (e.g. "has not lived with anyone since the divorce" reveals current living/relationship status; a story about a son moving out still reveals "has a son"; how a person grammatically refers to themselves reveals gender/address without an explicit instruction). This plan teaches the rule to distill the stable fact out of such a sentence while still excluding the narrative itself (who did what, why, the conflict, the sequence of events).

**Architecture:** Same pattern as PR #70/#71 -- reword lifecycle's rule 10 again (rule 19 already says "only the underlying stable fact... may qualify," which is consistent with this refinement and does not need to change). Dialogue scope is not touched by this plan.

**Tech Stack:** TypeScript, run via `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-09-25-lifecycle-memory-life-context-scope-design.md` (original design). This plan's exact rule text below supersedes that doc's and PR #70/#71's rule 10 text with this further-refined version, agreed with Настя after reviewing real backfill output from three real accounts on 25-28.09.2026.

## Global Constraints

- Only two files change: `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts` and its own test file `lifecyclePrompt.cases.test.ts`. No other file, including `dialoguePrompt.ts` -- this refinement is lifecycle-scope only.
- Only rule 10 changes. Rule 19, rule 30 (added in PR #71), and every other rule stay exactly as they are today -- this plan does not add or remove a numbered rule, so the existing count assertion (currently 30) does NOT need to change.
- Use the exact replacement text given in Task 1 below, verbatim.

## Review Focus

- A stray character mismatch between the production string and the test file's mirrored `EXPECTED_SYSTEM` string breaks the exact-equality test immediately -- Task 1 pastes identical text into both files, and its own diff-check step confirms it.
- The existing regex assertion in the test file (matching against `life_context .*, communication .*, or preference`) must still pass against the new, longer rule 10 text -- verified by running the test, not assumed.
- The rule-count assertion must stay at 30 (unchanged) -- this plan only rewords an existing rule, it does not add one. Verify the count is still 30 after the edit, not that it changed.
- Nothing outside rule 10 changes -- the diff-check step confirms rule 19, rule 30, and every other line are untouched.

---

### Task 1: Rewrite rule 10 to distill stable facts from narrative-embedded mentions

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` (existing tests; no new test file)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new -- this plan has only one task.

- [ ] **Step 1: Confirm no drift since this plan was written**

Run:
```
grep -n "^10\. " "supabase/functions/_shared/memoryV3/lifecyclePrompt.ts"
```
Expected, exactly this one line (this is PR #71's shipped text, being refined further here):
```
10. Every create and revise operation requires a non-null topic, exactly one of life_context (only a stable, static fact about who the person is or their circumstances: name, age, occupation or field of activity, the current existence of a family relationship such as having a child, spouse, partner, or parent, a stable close friendship, a pet, where they currently live, or a long-term ongoing project or role -- never a life event, transition, decision, crisis, or story about what happened or changed, even one that remains true going forward, and never health, medical conditions, or religion or beliefs even as a stable fact), communication (how this person prefers to be communicated with, including how to address them and their preferred tone), or preference (what helps or doesn't help in contact with them). Every confirm, mark_stale, reject, and ignore operation requires topic null. A revise re-decides topic from the current claim; do not simply copy the memory's previous topic forward without reconsidering it.
```
If it reads differently, STOP and report before continuing.

- [ ] **Step 2: Replace rule 10 with the distillation-aware version, in both files**

In `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`, replace the line shown in Step 1 with this exact line:

```
10. Every create and revise operation requires a non-null topic, exactly one of life_context (the person's current, stable structural facts: name, even if only mentioned in passing; age; occupation or field of activity; the current existence and identifying details such as name or age of a family relationship such as a child, spouse, partner, or parent; a stable close friendship; a pet; their current living situation, including who they do or do not currently live with; where they currently live; or a long-term ongoing project or role. When such a fact is only revealed through a larger story about a past event, a conflict, or someone else's situation, extract just the resulting current status or detail -- never the narrative itself: not who did what to whom, not the reasons, not the conflict, not the sequence of events. Never health, medical conditions, or religion or beliefs even as a stable fact.), communication (how this person prefers to be communicated with, including how to address them and their preferred tone -- infer this from how they speak about themselves even when it was never stated as an explicit instruction), or preference (what helps or doesn't help in contact with them). Every confirm, mark_stale, reject, and ignore operation requires topic null. A revise re-decides topic from the current claim; do not simply copy the memory's previous topic forward without reconsidering it.
```

Make the identical replacement in `lifecyclePrompt.cases.test.ts`'s `EXPECTED_SYSTEM` constant (it holds the same line verbatim).

Do not touch any other line in either file.

- [ ] **Step 3: Run the test file**

Run:
```
npx tsx supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts
```
Expected: `tests 11`, `pass 11`, `fail 0`. If any assertion fails, read which one before changing anything further.

- [ ] **Step 4: Diff-check that only rule 10 changed**

Run:
```
git diff supabase/functions/_shared/memoryV3/lifecyclePrompt.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts
```
Expected: exactly one changed line in each file (rule 10), nothing else -- rule 19, rule 30, and the rule-count assertion (still 30) show zero diff.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecyclePrompt.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts
git commit -m "fix: distill stable life_context facts out of excluded narrative

Second follow-up to PR #70/#71. Real backfill output today showed the
rule was too strict in one way: a sentence that references a past
event or someone else's story was fully excluded, even when it also
reveals a current stable fact -- e.g. \"hasn't lived with anyone since
the divorce\" reveals current relationship/living status; a story
about a son moving out still reveals \"has a son\"; how someone
grammatically refers to themselves reveals gender/address without an
explicit instruction. Rule 10 now explicitly asks the model to extract
the resulting stable fact from such sentences while still excluding
the narrative itself (who did what, why, the conflict, the sequence of
events). Rule 19 already said 'only the underlying stable fact may
qualify' and needs no change -- this is a rule 10 clarification of
what counts as that stable fact and how to find it."
```

---

## After this plan ships

Open a PR against `main` with a plain-Russian description (matching every other PR today), and do not merge it -- the product owner confirms the merge separately. After it merges, this needs the same deploy step as PR #70/#71 (`npx supabase functions deploy staysee-chat`). After deploy, the three real accounts already re-processed under PR #70/#71's rule (pristomania1987, day_and_night33, pisnaapisa00) need their lifecycle memory re-run once more under this further-refined rule, same process as before (the tool already reprocesses and replaces by design) -- not part of this plan's own tasks, a separate step after deploy.
