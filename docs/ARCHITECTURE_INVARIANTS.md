# StaySee Architecture Invariants

Architectural constraints for dialog routing, process state, and open figure behavior.
These invariants apply before and through PR3 (structured generation) and beyond.

---

## 1. Core principle

**StaySee stores process, not interpretation.**

The system may track how contact unfolds in a conversation — not what it means clinically,
not why the user feels a certain way, and not hidden hypotheses about their psychology.

Dialog behavior is driven by **process states**, not word triggers or expanding keyword lists.

---

## 2. Allowed process characteristics

### `processState` (session-scoped only)

| Field | Allowed values |
|-------|----------------|
| `contact` | `active` \| `reduced` \| `distant` \| `closing` |
| `movement` | `opening` \| `stuck` \| `deepening` \| `integrating` \| `settling` |
| `closure` | `none` \| `user_closing` \| `system_should_not_close` |
| `certainty` | `low` \| `medium` \| `high` |

These fields describe **dialog process only** — contact quality, momentum, closure pressure,
and epistemic certainty within the turn. They are not diagnoses and not content interpretations.

### `openFigure`

| Field | Allowed values |
|-------|----------------|
| `isOpen` | `boolean` |
| `kind` | `emotional` \| `relational` \| `body` \| `identity` \| `choice` \| `unknown` |
| `intensity` | `low` \| `medium` \| `high` |
| `confidence` | `low` \| `medium` \| `high` |

Open figure means: the topic is still alive, contact continues, and the turn should not
prematurely close with observation-only or brief closure — unless structural rules say otherwise.

---

## 3. Forbidden

The following must **never** be stored, persisted, or passed into long-term memory:

- Model **reasoning** / chain-of-thought
- **Diagnosis** or clinical labels
- **Trauma** labels or trauma narratives as system state
- **Attachment styles** (e.g. anxious, avoidant attachment as user trait)
- Labels such as `fear_of_abandonment`, `dependency`, `manipulation`
- Any **clinical or psychological interpretation** of the user
- **Raw user quotes** inside `processState` or `openFigure` audit fields
- Storing **model hypotheses** as user memory, summary facts, or cross-chat memory

Reasoning may be used transiently inside a single model call but must not be retained
across turns or written to any durable store.

---

## 4. Structural Router is permanent

A synchronous, deterministic **Structural Router** always runs before generative routing.
It is not replaced by semantic classifiers or structured generation.

Permanent structural checks include:

- **Crisis** — immediate safety path; overrides open figure
- **Explicit closure** — user ends contact; `openFigure` closed
- **Prompt attack** — immediate boundary response
- **Boundary pressure** — safety guidance; no open-figure expansion
- **Safety constraints** — medical, legal, off-topic, dependency boundaries

Structured output and `processState` **cannot override** structural safety or explicit closure.

---

## 5. Guidance timing

Turn guidance and depth planning follow a **one-turn lag** for generative process state:

- **Guidance and routing for turn N** use `processState_{N-1}` (and structural pre-checks on turn N).
- **`processState_N` and `openFigure_N`** from the same model call are written for:
  - audit / observability
  - session store
  - **turn N+1** planning only
- **Same-turn `processState_N` must not affect the current response** on turn N.
  The user-visible reply for turn N is generated under the plan established before that call
  (structural router + prior session state + existing turn guidance stack).

This prevents chicken-and-egg between state inference and response generation within one hop.

---

## 6. ProcessState scope

| Scope | Allowed |
|-------|---------|
| Current conversation / session | Yes — ephemeral or conversation metadata |
| Next turn within same conversation | Yes — read `processState_{N-1}` |

| Scope | Forbidden |
|-------|-----------|
| `user_memory` | No |
| Cross-chat memory | No |
| Embeddings / semantic archive as state carrier | No |
| `conversation_summary` / structured memory facts | No |

Process state is **session/conversation scoped**. It is not a substitute for memory and must not
leak into long-horizon user models.

---

## 7. Open Figure

- Open figure is a **process state**, not a message keyword match.
- Detection must not rely on **expanding regex lists, word triggers, or includes** as the
  long-term product strategy.
- Lexical detectors may exist temporarily during migration but are **not** the architectural end state.
- **No new regex/word lists** for open_figure after this decision.

Regression gaps (e.g. somatic phrases, relational paraphrase, choice dilemmas) are addressed by
process-aware structured generation — not by dictionary growth.

---

## 8. PR3 direction

| Step | Intent |
|------|--------|
| **PR3a** | Structured generation **shadow** — parse and log `processState` + `openFigure`; compare with legacy routing; **no** behavior change |
| **PR3b+** | Gradually use structured `response` and session state for turn planning |

Hard constraints for early PR3:

- **No separate classifier** LLM call for open figure
- **No big-bang removal** of the current lexical detector — shadow and compare first
- **No prompt / Constitution / Cognitive Signature changes** in PR3a
- **One primary model call** with structured output as the target end state

---

## Summary

| Invariant | Rule |
|-----------|------|
| Store | Process characteristics only |
| Never store | Interpretation, reasoning, clinical labels |
| Router | Structural checks permanent |
| Timing | Guidance uses N−1; same-turn state for N+1 only |
| Scope | Session/conversation only |
| Open figure | Process state, not keywords |
| PR3 | Shadow first; no classifier; no dictionary expansion |
