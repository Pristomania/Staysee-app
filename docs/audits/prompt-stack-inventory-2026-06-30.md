# Prompt stack inventory — `staysee-chat`

**Date:** 2026-06-30  
**Scope:** read-only audit of all runtime-active prompt/guidance layers for `supabase/functions/staysee-chat/index.ts` and transitive imports.  
**Production base:** `buildSurgery1BasePrompt()` → cold-start `BASE_PROMPT` (staysee-chat v106 at time of audit).  
**Out of scope:** `docs/PROMPT_CANDIDATE_V1.md` — not imported, not in stack.

**Goal:** Understand all layers that form Stacey's system prompt / dynamic guidance before rebuilding a new prompt core. Do not stack `PROMPT_CANDIDATE_V1` as another layer on top of legacy blocks.

---

## 1. Actual system prompt assembly order

```
BASE_PROMPT (always)
  → buildContextPrompt (+ recall / continuity if hasContext)
  → safety.systemGuidance (conditional)
  → userGenderTurnGuidance (conditional)
  → buildTimeGapPrompt (conditional)
  → sessionProcessGuidance (conditional, env off by default)
  → openFigureTurnGuidance (conditional)
  → uncertaintyTurnGuidance (conditional)
  → explicitClosureTurnGuidance (conditional)
  → OUTPUT_TOKEN_CEILING_GUIDANCE (always)
```

**Routing (not prompt text, but selects guidance):** `computeResponseBudget` ← `responseDepthTrajectory.ts`.

**Post-generation (not system prompt):** `polishAssistantOutput` → `ensurePublishableReply` → `runReplyRecoveryRoutes` (`AUTO_CONTINUE_USER_PROMPT` / `FINALIZE_USER_PROMPT` as **user** messages, not system).

**Bypass paths (no model call):**

- `safety.immediateResponse` → e.g. `PROMPT_ATTACK_RESPONSE`
- `semanticCrisisCheck` → `CRISIS_LEVEL2_RESPONSE`
- Regex crisis category flags category but does **not** short-circuit; semantic check is primary.

---

## 2. Layer inventory tables

### A. Cold-start BASE (`surgery1Prompt.ts`)

| # | File | Export | Imported by | Runtime active? | What it adds | Type | Risk | Recommendation |
|---|------|--------|-------------|-----------------|--------------|------|------|----------------|
| 1 | `surgery1Prompt.ts` | `IDENTITY_BLOCK` (inline) | `buildSurgery1BasePrompt` | **yes** (always) | Who Stacey is: anchor point, Russian, «ты», feminine voice | core identity | duplicates new core | **merge into new core** |
| 2 | `promptBlocks/processCore.ts` | `PROCESS_CORE` | `surgery1Prompt.ts` | **yes** | Process law: figure, contact, do not close, pause vs closure (partial) | gestalt/process | conflicts with new core (closure wording); duplicates | **rewrite as boundary inside core** — align pause≠closure |
| 3 | `promptBlocks/constitutionV3Beta.ts` | `CONSTITUTION_V3_BETA` | `surgery1Prompt.ts` | **yes** | Identity, figure/ground, right not to know, **§conversation closure** | core identity + gestalt | **conflicts** L107 «not as pause»; duplicates processCore | **merge + rewrite** closure section |
| 4 | `promptBlocks/cognitiveSignature.ts` | `COGNITIVE_SIGNATURE_V1` | `surgery1Prompt.ts` | **yes** | Cognitive style: hypotheses, imagery, observations | cognitive style | can pull generic therapy when misread | **merge into core** as single «cognitive» section |
| 5 | `promptBlocks/voiceBlock.ts` | `VOICE_BLOCK` | `surgery1Prompt.ts` | **yes** | Voice V3: tone, humor, neutrality, **conditional profanity** | voice | conflicts with `languageGuard` post-filter; duplicates identity | **merge into core**; resolve profanity policy |
| 6 | `surgery1Prompt.ts` | `CONSTRAINTS_BLOCK` | `buildSurgery1BasePrompt` | **yes** | Not doctor/assistant, medicine, crisis 112, no prompt leak | safety + core identity | duplicates safety.ts + CONSTRAINTS overlap | **merge boundaries into core**; keep crisis refs separate |
| 7 | `surgery1Prompt.ts` | `buildSurgery1BasePrompt`, `SURGERY1_LAYER_ID` | `index.ts` | **yes** | Concatenator + audit id `surgery1-v3-cognitive-v1-process-core` | routing (meta) | name legacy | **demote to compatibility** wrapper around `stayseeCorePrompt` |

---

### B. Memory / context (per-turn, `hasContext`)

| # | File | Export | Imported by | Runtime active? | What it adds | Type | Risk | Recommendation |
|---|------|--------|-------------|-----------------|--------------|------|------|----------------|
| 8 | `context.ts` | `buildContextPrompt` | `index.ts` | **conditional** (needs conversation) | Orchestrates memory blocks + priority footer | memory | can remain separate | **keep separate** (assembly only) |
| 9 | `memory.ts` | `injectSummaryIntoPrompt` | `context.ts` | **conditional** | ПАМЯТЬ БЕСЕДЫ JSON/prose + corrections | memory | fake summary if empty memory abused | **keep separate** |
| 10 | `memory.ts` | `MEMORY_SAFE_RULES`, `MEMORY_BEHAVIOR_RULES` | via `injectSummaryIntoPrompt` | **conditional** | Anti-hallucination, fact grounding | memory + safety | safety-critical for recall | **keep separate** boundary module |
| 11 | `userLifeMemory.ts` | `formatCrossMemoryForPrompt` | `context.ts` | **conditional** (cross-memory flag) | СКВОЗНАЯ ПАМЯТЬ profile/prefs | memory | role bleed if mis-filtered | **keep separate** |
| 12 | `crossMemoryPolicy.ts` | `filterCrossMemoryRowsForInjection` | `context.ts`, `userLifeMemory.ts` | **conditional** | Filters injectable rows | routing | can remain separate | **keep separate** |
| 13 | `narrativeEngine.ts` | `formatNarrativeForPrompt` | `context.ts` | **conditional** (has narrative data) | ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ + response rules | memory + cognitive | premature interpretation / «похоже» summaries | **keep separate**; tighten anti-fake-summary |
| 14 | `conversationRetrieval.ts` | `formatUserEvidenceForPrompt` | `context.ts` | **conditional** (recall/search) | ПОДТВЕРЖДЁННЫЕ СЛОВА | memory | safety-critical | **keep separate** |
| 15 | `conversationRetrieval.ts` | `formatArchiveExcerptsForPrompt` | `context.ts` | **conditional** | АРХИВ excerpts | memory | same | **keep separate** |
| 16 | `memory.ts` | `buildRecallGroundingPrompt` | `index.ts` | **conditional** (`hasRecallIntent`) | Strict recall mode | memory + dynamic turn | can remain separate | **keep separate** |
| 17 | `memory.ts` | `buildMemoryContinuityPrompt` | `index.ts` | **conditional** (stale summary ∨ gap `recheck`) | Post-pause continuity | memory + dynamic | mild check-in pull | **keep separate** |

**Background (not in turn prompt):** `memory.ts` `buildConversationSummary` → `summaryRefresh.ts` — separate model call for rolling summary.

---

### C. Safety / role (pre-generation)

| # | File | Export | Imported by | Runtime active? | What it adds | Type | Risk | Recommendation |
|---|------|--------|-------------|-----------------|--------------|------|------|----------------|
| 18 | `roleEnforcement.ts` | `evaluateTurnSafety` | `index.ts` | **yes** | Merges category + thread + role guidance | safety + routing | overlaps CONSTRAINTS | **keep separate** boundary |
| 19 | `safety.ts` | `evaluateSafety`, `guidanceForCategory`, `GUIDANCE.*` | `roleEnforcement.ts` | **conditional** by category | Per-category system injections | safety | duplicates CONSTRAINTS | **keep separate**; dedupe with core |
| 20 | `safety.ts` | `PROMPT_ATTACK_RESPONSE` | via `immediateResponse` | **conditional** | Hardcoded reply, skip model | safety | safety-critical | **keep separate** |
| 21 | `safety.ts` | `CRISIS_LEVEL2_RESPONSE` | `index.ts` | **conditional** (semantic crisis) | Hardcoded specialist referral | safety | «я буду рядом» in card | **keep separate**; rewrite card copy later |
| 22 | `semanticCrisisCheck.ts` | `semanticCrisisCheck` | `index.ts` | **conditional** | Crisis gate (no prompt) | routing + safety | safety-critical | **keep separate** |
| 23 | `languageGuard.ts` | `LANGUAGE_BOUNDARY_GUIDANCE` | `roleEnforcement.ts` | **conditional** (user faith/profanity boundary) | Extra lexicon rules | safety + voice | can remain separate | **keep separate** |
| 24 | `languageGuard.ts` | `LANGUAGE_GUARD_PROMPT`, `sanitizeProfanityInReply` | **only** `identity.ts` (dead) + `mergeContinuation.ts` (post) | prompt: **no**; post: **yes** | Profanity strip on output | output validation | conflicts VOICE_BLOCK profanity allowance | **rewrite** unified lexicon policy |
| 25 | `roleGuard.ts` | `buildRoleResetGuidance`, `sanitizeHistoryForModel` | `roleEnforcement.ts`, `index.ts` | guidance: **conditional**; history: **yes** | Role reset injection; invalidates bad assistant turns in history | safety + routing | can remain separate | **keep separate** |
| 26 | `roleEnforcement.ts` | `THREAD_ESCALATION_GUIDANCE`, `INSISTENCE_GUIDANCE` | internal | **conditional** | Anti-assistant escalation | safety | can remain separate | **keep separate** |
| 27 | `boundaryFallback.ts` | `userFrustrationAtBot` | `roleEnforcement.ts` | **conditional** (detection only) | Triggers frustration guidance | routing | — | **keep separate** |
| 28 | `safety.ts` | `buildSafetyPrompt` | **nothing** | **no** (dead export) | Static safety block | legacy/dead | duplicates | **remove later** |

---

### D. Dynamic turn guidance

| # | File | Export | Imported by | Runtime active? | What it adds | Type | Risk | Recommendation |
|---|------|--------|-------------|-----------------|--------------|------|------|----------------|
| 29 | `responseDepthTrajectory.ts` | `analyzeResponseDepth`, `analyzeOpenFigure`, … | `responseBudget.ts` | **yes** (logic) | Chooses depthReason → which guidance fires | routing | marker/heuristic architecture | **keep as routing**; not prompt text |
| 30 | `responseBudget.ts` | `OUTPUT_TOKEN_CEILING_GUIDANCE` | `index.ts` | **yes** (always appended) | Token ceiling note (English) | output validation | can remain separate | **keep separate** |
| 31 | `responseBudget.ts` | `computeResponseBudget` | `index.ts` | **yes** | maxTokens + depth meta | routing | — | **keep separate** |
| 32 | `openFigureTurnGuidance.ts` | `buildOpenFigureTurnGuidance` | `index.ts` | **conditional** (`openFigure && !explicit_closure && !safety_brief`) | Hold open figure, no soft close | dynamic turn guidance | **gap:** pause-in-arc not covered | **keep separate**; add pause guidance sibling |
| 33 | `uncertaintyTurnGuidance.ts` | `buildUncertaintyTurnGuidance` | `index.ts` | **conditional** (`depthReason === uncertainty_in_process`) | Anti-normalization, anti-availability | dynamic turn guidance | can remain separate | **keep separate** |
| 34 | `explicitClosureTurnGuidance.ts` | `buildExplicitClosureTurnGuidance` | `index.ts` | **conditional** (`depthReason === explicit_closure`) | Forbids availability tails | dynamic turn guidance | **not injected** in emotional arc after v106 → smoke failures | **keep separate**; extend pause path |
| 35 | `sessionProcessGuidance.ts` | `buildSessionProcessGuidance` | `index.ts` | **conditional** (`STAYSEE_SESSION_PROCESS_GUIDANCE=on`) | Descriptive prior-turn process state | dynamic turn guidance | default **off**; may bias «closing» | **keep separate** (flag-gated) |
| 36 | `userGenderTurnGuidance.ts` | `buildUserGenderTurnGuidance` | `index.ts` | **conditional** (high-confidence gender) | Grammatical gender addressing | dynamic turn guidance | can remain separate | **keep separate** |
| 37 | `timeGap.ts` | `buildTimeGapPrompt` | `index.ts` | **conditional** (gap ≥2h) | Pause awareness, check-in examples | dynamic turn guidance | generic support check-ins | **keep separate**; soften examples |

---

### E. Output pipeline (not system prompt)

| # | File | Export | Imported by | Runtime active? | What it adds | Type | Risk | Recommendation |
|---|------|--------|-------------|-----------------|--------------|------|------|----------------|
| 38 | `mergeContinuation.ts` | `polishAssistantOutput`, `polishMergedReply` | `index.ts` | **yes** | Profanity filter, paragraph normalize | output validation | no semantic contact audit | **keep separate** |
| 39 | `replyEnding.ts` | `endsAtSentenceBoundary`, `hasBrokenEnding` | `completeReply.ts` | **yes** | Form completeness | output validation | form only | **keep separate** |
| 40 | `completeReply.ts` | `ensurePublishableReply`, `AUTO_CONTINUE_*`, `FINALIZE_*` | `replyRecovery.ts` | **yes** | Truncation repair via extra user prompts | output validation | can add fake continuations | **keep separate** |
| 41 | `replyRecovery.ts` | `runReplyRecoveryRoutes`, duplicate-closure repair | `index.ts` | **yes** | Post-hoc paragraph drop | output validation | regex closure detection (exception: form repair) | **keep separate** |
| 42 | `roleEnforcement.ts` | `enforceRoleBoundedReply` | `index.ts` | **yes** (no-op pass-through) | Was post-gen truncate | legacy/dead | — | **remove later** or wire semantic audit |
| 43 | `replyPipelineTrace.ts` | `isContactSuspicious` | `index.ts` | **conditional** (trace env) | Diagnostics only | legacy/dead for gating | not a gate | **keep separate** (observability) |

---

### F. Unwired / legacy (NOT in production prompt path)

| # | File | Export | Imported by staysee-chat? | Runtime active? | Type | Recommendation |
|---|------|--------|---------------------------|-----------------|------|----------------|
| 44 | `gestalt.ts` | `buildGestaltPrompt` | **no** | **no** | gestalt/process | **demote legacy** or delete after core absorbs |
| 45 | `presence.ts` | `buildPresencePrompt` | **no** | **no** | gestalt/process | **remove later** |
| 46 | `stance.ts` | `resolveConversationStance`, `STANCE_GUIDANCE.*` | **no** | **no** | routing + dynamic | **remove later** (marker micro-modes) |
| 47 | `methodology.ts` | `buildMethodologyPrompt` | **no** | **no** | legacy | **remove later** |
| 48 | `identity.ts` | `buildIdentityPrompt` (+ `LANGUAGE_GUARD`) | **no** | **no** | core identity (superseded) | **demote legacy** — useful forbidden-phrase list for core migration |
| 49 | `constitution.ts` | `buildConstitutionPrompt`, `STAYSY_CONSTITUTION_PRINCIPLES` | **no** | **no** | legacy | **remove later** |
| 50 | `structuredTurnRuntime.ts` | shadow structured turn | `index.ts` | **conditional** (shadow mode, separate call) | routing | not main prompt | **keep separate** (experiment) |

---

## 3. Voice and Cognitive Signature — location and production status

| Layer | Location | In production BASE? | Every turn? |
|-------|----------|---------------------|-------------|
| **Voice** | `promptBlocks/voiceBlock.ts` → `VOICE_BLOCK` | **yes** via `surgery1Prompt.ts` | **yes** |
| **Cognitive Signature** | `promptBlocks/cognitiveSignature.ts` → `COGNITIVE_SIGNATURE_V1` | **yes** via `surgery1Prompt.ts` | **yes** |

**Duplication:** identity appears 3× — `IDENTITY_BLOCK`, `CONSTITUTION §IDENTITY`, partial overlap in `CONSTRAINTS`. Voice mentions «краткость» without process authority; processCore says the opposite for live figures.

**Recommendation for new core:**

- **Voice** → **inside** `stayseeCorePrompt` (single voice section).
- **Cognitive signature** → **inside** core as one «how Stacey thinks» section (subordinate to process law).
- Do **not** keep as separate always-on layers after migration.

---

## 4. Problematic formulations in active stack

### Generic assistant / role confusion

| Source | Phrase / pattern | Pull direction |
|--------|------------------|----------------|
| `CONSTRAINTS_BLOCK`, `safety.ts` GUIDANCE | «не ChatGPT / универсальный ассистент» | Good guard — but model still drifts |
| `cognitiveSignature.ts` L23 | «психологические объяснения» when invited | Generic therapy voice |
| `timeGap.ts` L64 | «не скрипт терапии, не клиентская эмпатия бота» | Meta — still suggests therapy frame |
| `CRISIS_LEVEL2_RESPONSE` | «Психолог, психотерапевт…» | Correct referral; role boundary |
| `narrativeEngine.ts` | «не ставь диагнозов» | Clinical frame by negation |

### «Если захочешь, я здесь» / availability

| Source | Status |
|--------|--------|
| `explicitClosureTurnGuidance.ts` | **Explicitly forbids** — but only when `explicit_closure` injected |
| `uncertaintyTurnGuidance.ts` | **Forbids** templates |
| `processCore.ts` L36 | Forbids availability tail on **true** closure |
| **Gap** | Pause-in-arc (`пока` inside emotional arc): **no** anti-availability guidance after v106 |
| `CRISIS_LEVEL2` | «я буду рядом — но не как терапевт» (hardcoded card) |
| `identity.ts` (dead) | Forbidden list includes «Я всегда здесь» — **not in live BASE** |

### «Береги себя» / support-planning

| Source | Status |
|--------|--------|
| Active BASE/guidance | **No explicit «береги себя»** in production imports |
| `safety.ts` dependency/off_topic | «структурировать мысли», «живые связи» — mild support-planning |
| `constitutionV3Beta.ts` L98 | «предложить обратиться за дополнительной поддержкой» — referral, not plan |

### Premature summary / fake recap

| Source | Risk |
|--------|------|
| `narrativeEngine.ts` | Interpretive «ИСТОРИЯ И ДВИЖЕНИЕ» without quotes |
| `memory.ts` ПАМЯТЬ БЕСЕДЫ | Model may invent from sparse/empty summary |
| **No turn guidance** | User asks «подведи итог» on empty chat → no block |
| `replyRecovery.ts` | Drops recap **after** closure paragraph (post-hoc only) |

### Closing / «оставить как есть» / normalization

| Source | Pull |
|--------|------|
| `constitutionV3Beta.ts` L104–107 | **«ответ как на завершение, а не как на паузу»** — **conflicts** with pause≠closure product principle |
| `processCore.ts` L35–37 | True closure OK; «положил нить» — no pause distinction |
| `sessionProcessGuidance.ts` | Descriptive «user_closing» / «settling» — weak bias when flag on |
| `openFigureTurnGuidance.ts` | Anti soft-final — **good**, active in arc |
| `voiceBlock.ts` L6–7 | «Тепло и краткость» — sound, not process — model may over-apply |

---

## 5. Proposed new architecture

### A. New core prompt module (`stayseeCorePrompt.ts`)

**Single concatenated module replaces SURGERY1 stack:**

1. **Identity** (from current `IDENTITY_BLOCK` — one copy)
2. **Process law** (merge `PROCESS_CORE` + constitution process sections; **rewrite pause vs closure**)
3. **Contact principles** (figure/ground, right-not-to-know — deduped)
4. **Cognitive signature** (condensed `COGNITIVE_SIGNATURE_V1`)
5. **Voice** (condensed `VOICE_BLOCK`; **one** lexicon policy with post-filter)
6. **Role boundaries** (merge `CONSTRAINTS_BLOCK` essentials — not full safety router)

**Explicitly NOT in core:** memory payloads, per-turn guidance, category safety injections, token ceiling.

### B. Separate boundary modules (stay outside core)

- `safety.ts` + `roleEnforcement.ts` + `roleGuard.ts` — category & thread boundaries
- `languageGuard.ts` — faith/profanity turn injection + output sanitize (aligned with voice)
- `semanticCrisisCheck.ts` + crisis cards
- `memory.ts` safe rules + `context.ts` assembly
- `crossMemoryPolicy.ts`, `userLifeMemory.ts`, `conversationRetrieval.ts`, `narrativeEngine.ts`

### C. Dynamic guidance (runtime state)

- `responseDepthTrajectory.ts` / `responseBudget.ts` — routing only
- Turn injectors: `openFigure`, `uncertainty`, **`pauseInArc` (new)**, `explicitClosure`, `userGender`, `timeGap`, `sessionProcess` (flag)
- `OUTPUT_TOKEN_CEILING_GUIDANCE`

### D. Legacy compatibility (temporary exports)

- `buildSurgery1BasePrompt()` → delegates to `buildStayseeCorePrompt()` behind `STAYSEE_PROMPT_CORE=v1|legacy`
- `SURGERY1_LAYER_ID` + `aiAuditVersions.ts` aliases
- Re-export `SURGERY1_BLOCKS` shape for tests
- Keep `identity.ts`, `constitution.ts`, `gestalt/presence/stance/methodology` **unimported** until PR5

### E. Migration plan

| PR | Goal |
|----|------|
| **PR1** | This inventory + ADR «prompt core rebuild principles» |
| **PR2** | Create `stayseeCorePrompt.ts` + flag default **legacy**; parity tests |
| **PR3** | Staging: `STAYSEE_PROMPT_CORE=v1`; smoke matrix (arc+pause, recall, empty summary, crisis); optional `pauseInArcTurnGuidance` |
| **PR4** | Production flip; monitor `reply_pipeline_trace` + prod smoke |
| **PR5** | Remove SURGERY1 inline blocks, dead `buildSafetyPrompt`, unwired gestalt/presence/stance/methodology/identity; single voice/lexicon |

---

## 6. Key gaps for rebuild

1. **No pause-in-arc guidance** — v106 fixed routing but availability tails still leak in output.
2. **Constitution/process closure wording** contradicts pause≠closure product principle.
3. **Anti-fake-summary** missing for empty/low-context «подведи итог» requests.
4. **Voice vs languageGuard** profanity policy split (prompt allows, post-filter strips).
5. **~6 always-on BASE sections** + overlapping identity — high duplicate/conflict surface for any stacked `PROMPT_CANDIDATE_V1`.

---

## 7. Product principles (context for rebuild)

- Contact never resets; no Stacey-initiated process closure.
- User external leave = **pause / deferred contact**, not closure.
- No trigger-word/marker architecture for normal process (exception: crisis/safety).
- Do **not** stack `PROMPT_CANDIDATE_V1` as another layer — rebuild core instead.

---

*Audit method: static trace from `supabase/functions/staysee-chat/index.ts` imports and `systemPrompt` assembly. No runtime changes.*
