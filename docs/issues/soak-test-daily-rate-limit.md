# Issue: Soak tests hit daily rate limit on test user

**Status:** open — test infrastructure  
**Priority:** low  
**Affects:** long automated soak / acceptance runs on staging  
**Does not affect:** early closure behavior or prod

**Parent context:** [early-closure-staging-baseline.md](./early-closure-staging-baseline.md)

---

## Problem

During staging soak (56 dialogs, 2026-06-17), the test user hit the daily usage limit mid-run:

```text
Ты уже много работаешь со мной сегодня. Дай себе немного пространства — завтра я снова здесь.
```

**~20 tail Group C cases** were contaminated and **excluded** from T2 metrics.

First affected case: `всё навалилось → и что?` (T2) and all subsequent C dialogs.

---

## Impact

- T2 aggregate metrics from auto-scorer were misleading (low continuity rate)
- Valid T2 subset had to be computed manually (n=14 before rate limit)
- Not a model regression — infrastructure noise

---

## Fix for future soaks

Before long runs:

1. Reset `user_usage_tiers.daily_requests_used` for the soak test user (`12c823c1-a82b-408c-8179-bc02e8d7e3b1` on staging), or
2. Raise daily limit for the test user / service role path, or
3. Batch runs with counter reset between batches

**Reference:** `scripts/staging-soak-closure.mjs`, `scripts/staging-acceptance-closure.mjs`

---

## Follow-up

- [ ] Add automatic usage reset at start of soak scripts
- [ ] Document test user ID and reset procedure in soak script header
