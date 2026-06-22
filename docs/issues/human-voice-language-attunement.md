# Issue: Human voice / language attunement (frozen track)

**Status:** frozen — separate from early closure  
**Priority:** deferred  
**Affects:** literal salience, living user language, tone attunement  
**Does not affect:** early closure T1 acceptance (Step 2 + Step 3)

**Parent context:** [early-closure-staging-baseline.md](./early-closure-staging-baseline.md)

---

## Problem

Стэйси иногда не удерживает **живой язык пользователя** и буквальную значимость его слов — отдельно от задачи раннего закрытия процесса.

Examples of the gap (not exhaustive):

- generic psychoeducation instead of staying with the user's exact words;
- soft relabeling before material unfolds;
- tone that feels more like a chatbot than attuned contact.

---

## What was tried (not accepted)

| Step | Approach | Outcome |
| --- | --- | --- |
| Step 3c | Expanded CS activation gate for living words | Not accepted |
| Step 4 | Voice `ЖИВОЙ КОНТАКТ С ПЕРВЫМИ СЛОВАМИ` | Removed |
| Step 5 | Constitution + Voice global human-tone paragraphs | Reverted |
| Step 6 | Runtime `languageAttunementTurnGuidance` + flag | Tested; no improvement on literal salience; **flag OFF** |

---

## Required state

```text
STAYSEE_LANGUAGE_ATTUNEMENT_TURN_GUIDANCE=off
```

On staging and until this track is explicitly reopened.

**Code may remain** as experiment:

- `supabase/functions/_shared/languageAttunementTurnGuidance.ts`
- wiring in `supabase/functions/staysee-chat/index.ts`

---

## Reopen criteria

Only when product explicitly reopens human voice / language attunement — not bundled with early closure prod rollout.
