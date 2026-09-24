# Dialogue-Scope Memory Full Rollout Implementation Plan

**Goal:** Graduate dialogue-scoped Memory V3 from a single-account canary (Настя's own dev account, `pristomania1987@gmail.com`) to the only memory system for all real accounts, backfill the two other real people's (her second account, her son's account) message history into it using today's already-built and already-validated tools, then retire the old AI-memory system for those two accounts and simplify the Privacy screen back to one button.

**Context this reuses, unchanged:** everything under `scripts/memory-v3-pilot/dialogue-history-backfill-*` and `lifecycle-history-backfill-*` was built and successfully run for real today (24-25.09.2026) against `pristomania1987@gmail.com`'s real history — 5 dialogues, 38 items, real money spent, real import completed. Follow `scripts/memory-v3-pilot/README-dialogue-history-backfill.md` exactly for both accounts in this plan; do not modify those tools unless you hit a real, reproducible bug (if you do, stop and report it precisely — do not patch blind).

**Accounts involved (confirmed by Настя from the real Supabase Auth dashboard, 25.09.2026):**
- `pristomania1987@gmail.com` — her development/test account. **Do not touch as part of this plan** — already has dialogue-scope memory, already backfilled today, leave it exactly as it is.
- `day_and_night33@mail.ru` — her second real account. In scope: full rollout target.
- `pisnaapisa00@gmail.com` — her son's real account. In scope: full rollout target.
- All other accounts in the Auth dashboard (`soft-exit-diag-*@staysee-smoke.*`, `staysee-cleanup-smoke-*`, `staysee-deploy-smoke-*`) are automated CI/deploy smoke-test accounts, not real people. **Out of scope entirely** — do not touch, backfill, or delete anything for them.

**Division of labor (non-negotiable, same as every other step today):** Cursor runs every real command, checks every real report before proceeding to the next step, and gets Настя's explicit go-ahead before the one truly irreversible action (real data deletion in Step 4). Nobody merges any PR from this plan without Настя's explicit real-time confirmation. Nobody deletes the old `user_memory` rows for an account until that account's new memory has been successfully imported AND the report has been read.

## Step 1 — Turn off the canary restriction

Read `supabase/functions/_shared/memoryV3/dialogueMode.ts` (already exists, do not modify it) to confirm the exact mode values: `"off"`, `"dialogue_canary"`, `"dialogue_all"`.

The live Edge Function currently reads its mode from the `STAYSEE_MEMORY_V3_DIALOGUE_MODE` environment variable/secret (check `supabase/functions/memory-v3-viewer/index.ts` and any other file reading this same variable, e.g. wherever `staysee-chat` or `dialogueShadowRunner.ts` resolves dialogue eligibility, to confirm every call site uses the same secret name). This is a Supabase project **secret**, not a repo file — change it via:

```
npx supabase secrets set STAYSEE_MEMORY_V3_DIALOGUE_MODE=dialogue_all
```

Given there are only 3 real people total on this app and the code path is already the same one exercised for real today, this is safe to roll out fully rather than expanding an allowlist one account at a time. After setting it, redeploy every Edge Function that reads this secret (check which ones do — at minimum `staysee-chat` and `memory-v3-viewer`) so the new value actually takes effect:

```
npx supabase functions deploy staysee-chat
npx supabase functions deploy memory-v3-viewer
```

(Add any other function you find reading this secret in your own search — do not assume the two above are the only ones without checking.)

Report back the exact secret value before/after (Supabase's `secrets list` only shows names, not values, by design — just confirm the `set` command succeeded) and which functions you redeployed.

## Step 2 — Backfill `day_and_night33@mail.ru`

Follow `scripts/memory-v3-pilot/README-dialogue-history-backfill.md` exactly, using `day_and_night33@mail.ru`'s own real `STAYSEE_MEMORY_V3_BACKFILL_USER_ID` (its UID from the Auth dashboard, not `pristomania1987`'s) in `.env`. Also run the equivalent **lifecycle-scope** historical backfill (`scripts/memory-v3-pilot/lifecycle-history-backfill-*`, the older sibling tool, same README pattern under a similarly-named README if one exists, or infer the exact command shape from `lifecycle-history-backfill-cli.ts`/`-run.ts` directly since this tool predates today's dialogue-scope work) for the same account, if this account hasn't already had lifecycle-scope memory populated (check the Умная память screen for this account first, or query `memory_v3_lifecycle_shadow_items` for this user_id — if it already has real lifecycle items, skip the lifecycle backfill for this account and only do the dialogue-scope one).

Do the free `--inspect-source` step first, then the real paid step, exactly as documented. **Stop after producing the `.txt` report and show it to Настя (or have her check it herself) before running Step 4 (approval + import) for this account.** Do not import automatically just because the paid step succeeded — this is real family data, the same human-in-the-loop checkpoint applies as it did for `pristomania1987`'s own data today.

## Step 3 — Backfill `pisnaapisa00@gmail.com` (Настя's son)

Repeat Step 2's exact process for this account's own UID. Since this is her son's account and his data, Настя should confirm with him (or review it herself if she has his consent to do so) before the import step, the same way she reviewed her own report today — flag this explicitly when you reach the report-reading checkpoint, don't assume it's fine to proceed without a real "read the report" pause for this one too.

## Step 4 — Retire old AI-memory for these two accounts only, after their new memory is confirmed good

**Only after both Step 2 and Step 3's imports have succeeded and been confirmed correct by Настя (and, for the son's account, by him or with his knowledge):**

For each of the two accounts (`day_and_night33@mail.ru`'s UID and `pisnaapisa00@gmail.com`'s UID) — not `pristomania1987`'s, not any smoke-test account — run, via the Supabase SQL editor or an equivalent one-off script using the already-existing service-role client pattern from today's tools (do not build new reusable code for this, it's a one-time cleanup for exactly two known accounts):

```sql
DELETE FROM user_memory WHERE user_id = '<day_and_night33's UID>';
DELETE FROM user_memory WHERE user_id = '<pisnaapisa00's UID>';
```

This is a real, irreversible deletion of real people's data (even though it's the old, soon-to-be-replaced system) — get Настя's explicit "да, удаляй" for each account (or one combined confirmation covering both, her call) immediately before running these two statements, the same way every real deletion this entire project has required a live, explicit confirmation. Do not run this as part of the same batch as Step 1-3 without a fresh confirmation specifically for this step.

## Step 5 — Simplify the Privacy screen back to one button

In `src/components/screens/PrivacyScreen.tsx`:
- Remove the "Удалить старую память" button and its `handleDeleteMemory`/`deleteMemoryState` code entirely (the old system is being retired for all real accounts as of Step 4 — there is no longer a second thing to separately delete).
- Rename the remaining button back to something simple like "Удалить память" (drop the "умной" qualifier — confirm exact wording with Настя before finalizing copy, don't guess Russian UX text) since it is now the only memory-deletion action.
- Keep `handleDeleteMemoryV3`/`deleteAllMemoryV3Data` exactly as built yesterday (PR #64) — only the OLD button and its handler are being removed, not the new one.
- Update or remove the now-obsolete test coverage that specifically asserted the old button's presence/behavior, if any (check `PrivacyScreen`-related tests if they exist — flag if none exist, don't invent a new testing convention for this screen).

This is a normal PR like every other one this project has made — commit, push, open a PR with a plain-Russian description, do not merge it yourself.

## Notes on sequencing

Steps 2 and 3 (the two backfills) are independent of each other and can happen in either order, but **both must be reviewed and imported (or explicitly deferred) before Step 4 touches anything** — do not delete old data for an account whose new memory import hasn't actually succeeded yet, even if the other account's has. Step 5 (the UI change) is independent of Steps 2-4 and could technically ship first or last, but shipping it only after Step 4 completes for both accounts keeps the UI truthfully describing what the backend actually does at every point in the rollout — do it last.

If anything about the actual current secret name, function list, or table name in this plan turns out to be wrong when you check the real code, trust the real code over this plan text and say so in your report — this plan was written from memory of today's work, not a fresh re-read of every file involved.
