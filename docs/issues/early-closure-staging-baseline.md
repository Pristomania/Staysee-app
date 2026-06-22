# Early closure — accepted staging baseline (Step 2 + Step 3)

**Status:** accepted on staging for T1  
**Date:** 2026-06-17  
**Staging:** `hdmoetcvlszrdukqpiia`  
**Production:** untouched (`jnxrildlwvtxhtiwucbt`)  
**Prod rollout:** not done in this step

---

## Summary

| Area | Status |
| --- | --- |
| Early closure / premature process closure | **Resolved on staging for T1** |
| Accepted staging baseline | **Step 2** Constitution Process-First + **Step 3** CS Activation Gate |
| Step 6 Language Attunement | **Not accepted** — flag **OFF** |
| Production | **Untouched** |

---

## Baseline confirmation

| Проверка | Статус |
| --- | --- |
| Step 2 `ПРОЦЕСС И ГИПОТЕЗА` | есть |
| Step 3 CS Activation Gate | есть |
| Step 3c | отсутствует |
| Step 4 | отсутствует |
| Step 5 | откатан |
| Step 6 code | может быть в коде как эксперимент |
| Step 6 flag `STAYSEE_LANGUAGE_ATTUNEMENT_TURN_GUIDANCE` | **OFF** |
| Prod | untouched |

**Prompt sources (accepted baseline):**

- `supabase/functions/_shared/promptBlocks/constitutionV3Beta.ts` — `## ПРОЦЕСС И ГИПОТЕЗА`
- `docs/CONSTITUTION_V3_BETA.md`
- `supabase/functions/_shared/promptBlocks/cognitiveSignature.ts` — `## УСЛОВИЕ ВКЛЮЧЕНИЯ ГИПОТЕЗ И НОВЫХ НАЗВАНИЙ`
- `docs/COGNITIVE_SIGNATURE_V1.md`

**Step 6 (experimental, not accepted):**

- `supabase/functions/_shared/languageAttunementTurnGuidance.ts`
- Wired in `supabase/functions/staysee-chat/index.ts`
- Env: `STAYSEE_LANGUAGE_ATTUNEMENT_TURN_GUIDANCE=off` on staging

---

## Original problem

Стэйси могла слишком рано закрывать процесс:

- подводить итог до разворачивания материала;
- делать гипотезу фактом;
- переводить живой процесс в готовое объяснение;
- мягко выводить человека из исследования;
- предлагать «просто наблюдать / оставить как есть» слишком рано.

**Scope boundary:** это отдельная задача от human voice / language attunement (живой язык, буквальная значимость слов пользователя, подстройка тона).

---

## Accepted changes

### Step 2 — Constitution Process-First

Смысл:

> Понимание Стэйси не является фактом процесса.  
> Гипотеза, объяснение или название не становятся опорой разговора сами по себе.  
> Опорой остаётся материал человека.

### Step 3 — CS Activation Gate

Смысл:

> Cognitive Signature не должна включать переименование, гипотезы и новые рамки раньше времени.  
> Гипотезы уместны, когда есть материал, контакт или прямой запрос человека.

---

## Rejected / reverted experiments (not in baseline)

| Step | What | Outcome |
| --- | --- | --- |
| Step 3c | Expanded CS human-voice gate text | Not accepted |
| Step 4 | Voice `ЖИВОЙ КОНТАКТ С ПЕРВЫМИ СЛОВАМИ` | Removed |
| Step 5 | Constitution + Voice global human-tone patch | Fully reverted |
| Step 6 | Runtime `languageAttunementTurnGuidance` | Tested; not accepted; flag OFF |

---

## Validation: acceptance test + staging soak

| Parameter | Value |
| --- | --- |
| Staging | `hdmoetcvlszrdukqpiia` |
| Model | gpt-4o |
| Step 6 | OFF |
| Dialogs (soak) | 56 total |
| Valid T1 | 21 (15 no-request + 6 direct-request) |
| Direct-request T1 | 6 |

**Scripts:** `scripts/staging-acceptance-closure.mjs`, `scripts/staging-soak-closure.mjs`  
**Soak raw JSON:** local temp artifact from soak run (2026-06-17)

### T1 metrics (soak)

| Метрика | Результат |
| --- | --- |
| T1 early closure FAIL rate | **0/21** |
| T1 hypothesis finalization FAIL rate | **0/21** |
| T1 early exit language FAIL rate | **0/21** |
| Direct-request preserved | **6/6** |

### T2 notes (soak, valid subset)

| Метрика | Результат | Note |
| --- | --- | --- |
| T2 greeting reset (valid n=14) | 1/14 (7.1%) | `пусто внутри → да` only |
| T2 greeting reset on «да» (valid n=3) | 1/3 | High variance; separate issue |

**Conclusion:**

> Step 2 + Step 3 стабильно решают задачу раннего завершения процесса на staging для T1.

---

## Out of scope for this task

### 1. Human voice / language attunement

Задача человечности, языковой подстройки и сохранения живого языка пользователя **не решена** в рамках early closure.

Step 6 Language Attunement был протестирован отдельно и **не принят**.  
Флаг `STAYSEE_LANGUAGE_ATTUNEMENT_TURN_GUIDANCE` должен оставаться **OFF**.

→ Follow-up: [human-voice-language-attunement.md](./human-voice-language-attunement.md)

### 2. Short «да» greeting reset

Короткое «да» после T1 иногда сбрасывает нить и уходит в greeting reset.  
Это **continuation / routing / session-thread** gap, а не premature process closure.  
**Не является blocker** для принятия Step 2 + Step 3 как early closure baseline.

→ Follow-up: [short-da-greeting-reset.md](./short-da-greeting-reset.md)

### 3. Soak test daily rate limit

Часть хвостовых C-кейсов была исключена из T2-метрик из-за daily rate limit тестового пользователя (`Ты уже много работаешь со мной сегодня…`).  
Для будущих soak нужно сбрасывать `daily_requests_used` тестового пользователя или поднимать лимит.

→ Follow-up: [soak-test-daily-rate-limit.md](./soak-test-daily-rate-limit.md)

---

## Decision

```text
Early closure task:
  accepted on staging for T1

Accepted baseline:
  Step 2 + Step 3

Prod rollout:
  not done in this step

Remaining gaps:
  1. short «да» greeting reset — separate issue
  2. human voice / language attunement — separate frozen track
  3. soak infra daily rate limit — test infra issue
```

---

## Next steps (explicitly not in this step)

- [ ] Prod rollout of Step 2 + Step 3 (when approved separately)
- [ ] Do **not** enable Step 6 flag without re-opening language attunement track
- [ ] Do **not** conflate greeting-reset fix with early closure acceptance
