# Issue: Short continuation «да» routes as greeting reset

**Status:** open — separate from early closure  
**Priority:** medium (UX / thread continuity)  
**Affects:** multi-turn session continuity after T1  
**Does not affect:** T1 early closure acceptance (Step 2 + Step 3)

**Parent context:** [early-closure-staging-baseline.md](./early-closure-staging-baseline.md)

---

## Problem

Short continuation **«да»** after T1 sometimes:

- resets the conversation thread;
- responds with a generic greeting (e.g. «Привет! Как настроение сегодня?»);
- loses the open process from T1.

This is a **continuation / routing / session-thread** issue, not premature process closure.

---

## Evidence

| Run | Observation |
| --- | --- |
| Acceptance test | ~3/5 «да» cases showed greeting reset (higher variance) |
| Staging soak (2026-06-17) | 1/14 valid T2 cases; 1/3 on «да» only (`пусто внутри → да`) |

Example failure:

- T1: «Как ты сейчас справляешься с этим ощущением пустоты?»
- T2 user: `да`
- T2 reply: «Привет! Как настроение сегодня?»

---

## Not a blocker for

Accepting **Step 2 + Step 3** as the early closure staging baseline for T1.

---

## Suggested investigation (when reopened)

- Routing / intent classification on ultra-short affirmations
- Session thread carry-over vs new-session greeting path
- Whether `openFigureTurnGuidance` or conversation state drops context on «да»

**Do not** patch as part of early closure rollout without separate validation.
