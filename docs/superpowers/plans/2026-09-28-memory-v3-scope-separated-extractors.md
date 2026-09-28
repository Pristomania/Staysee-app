# Memory V3 Scope-Separated Extractors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent lifecycle (cross-conversation) memory and dialogue memory from sharing semantic candidates by giving each scope its own extractor prompt, builder, version, live wiring, and historical-backfill identity.

**Architecture:** Keep the response schema, validation, evidence rules, safety boundary, transport, storage, and reconcilers shared where they are already scope-neutral. Add fixed scope-owned extractor modules and make every live/backfill consumer import exactly one of them. Split the historical profile identity while retaining one scope-neutral provider-price/budget module, and schedule eligible live dialogue and lifecycle runners independently.

**Tech Stack:** TypeScript, Deno-compatible Supabase Edge Functions, Node `node:test`, `tsx`, PostgreSQL-backed stores (unchanged), OpenRouter adapters (unchanged).

**Spec:** `docs/superpowers/specs/2026-09-28-memory-v3-scope-separated-extractors-design.md`

## Global Constraints

- No database migration, production-memory import, deploy, provider request, paid model call, or sensitive-history egress is authorized by this plan.
- Preserve the legacy `prompt.ts`, `shadowRunner.ts`, and `MEMORY_V3_EXTRACTOR_VERSION` behavior for the generic shadow/offline compatibility path.
- Production lifecycle code must use only `MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION` and `buildMemoryV3LifecycleExtractorRequest`.
- Production dialogue code must use only `MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION` and `buildMemoryV3DialogueExtractorRequest`.
- Lifecycle extractor version is exactly `memory-v3-openrouter-gemini-3.7-flash-lifecycle-extractor-v1`.
- Dialogue extractor version is exactly `memory-v3-openrouter-gemini-3.7-flash-dialogue-extractor-v1`.
- Lifecycle backfill profile id remains exactly `memory-v3-lifecycle-history-backfill-v1`.
- Dialogue backfill profile id is exactly `memory-v3-dialogue-history-backfill-v1`; the dialogue CLI must reject the lifecycle profile id before environment, network, or filesystem side effects.
- The existing `cross_memory_enabled` preference remains the master gate. New lifecycle/dialogue/per-conversation UI controls are outside this plan.
- Existing safe-output, sequential-call, hard-budget, no-retry, privacy-projection, fallback, and Telegram-alert behavior must not weaken.
- Existing 2026-09-28 artifacts remain untracked audit evidence and must not be rewritten, deleted, staged, or imported.
- Every production change starts with a behavioral RED, reaches GREEN, runs its focused regression set, and is committed separately with an `[agent]` commit subject.

## File Structure

### Create

- `supabase/functions/_shared/memoryV3/extractorRequest.ts` — shared request type, format/safety instruction fragments, validated cloning, and instruction-bound request construction; no scope selection.
- `supabase/functions/_shared/memoryV3/extractorRequest.cases.test.ts` — input validation, cloning, proxy/getter, mutation, and source-isolation tests.
- `supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.ts` — lifecycle-only instruction, version, and fixed builder.
- `supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.cases.test.ts` — lifecycle allowlist/exclusion/atomicity contract tests.
- `supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts` — dialogue-only instruction, version, and fixed builder.
- `supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.cases.test.ts` — dialogue-local narrative and explicit-scope contract tests.
- `supabase/functions/_shared/memoryV3/scopeExtractorSemanticFixtures.cases.test.ts` — locked paired examples showing intentionally different results for identical source dialogue.
- `scripts/memory-v3-pilot/history-backfill-provider-profile.ts` — scope-neutral route constants, price validation, and budget arithmetic extracted from the lifecycle profile.
- `scripts/memory-v3-pilot/history-backfill-provider-profile.test.ts` — frozen route, price age, decimal arithmetic, and hostile-input tests.
- `scripts/memory-v3-pilot/dialogue-history-backfill-profile.ts` — dialogue profile id and dialogue extractor identity.
- `scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts` — exact keys, values, deep freeze, and cross-profile rejection tests.

### Modify

- `supabase/functions/_shared/memoryV3/prompt.ts` and `prompt.cases.test.ts` — keep the legacy instruction/version behavior while delegating request cloning to `extractorRequest.ts`.
- `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts` and `.cases.test.ts` — lifecycle builder/version only.
- `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts` and `.cases.test.ts` — dialogue builder/version only.
- `supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts` — replace the old mutual-exclusion assertion with independent scheduling assertions.
- `supabase/functions/staysee-chat/index.ts` — schedule eligible dialogue and lifecycle safe runners without an early return.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts` and `.test.ts` — consume provider-profile primitives and lifecycle identity.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts` and `.test.ts` — lifecycle builder for request bytes/digests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts` and `.test.ts` — lifecycle builder/version throughout execution and review packets.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts` — lifecycle request fixtures.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts`, `-import.test.ts`, and `-import-run.test.ts` — reconstruct and validate lifecycle identity.
- `scripts/memory-v3-pilot/dialogue-history-backfill-cli.ts` and `.test.ts` — dialogue profile only.
- `scripts/memory-v3-pilot/dialogue-history-backfill-contract.ts` and `.test.ts` — dialogue builder/profile for bytes/digests.
- `scripts/memory-v3-pilot/dialogue-history-backfill-engine.ts` and `.test.ts` — dialogue builder/version/profile throughout execution and packets.
- `scripts/memory-v3-pilot/dialogue-history-backfill-provider.ts` and `.test.ts` — scope-neutral provider primitives plus dialogue request fixtures.
- `scripts/memory-v3-pilot/dialogue-history-backfill-import.ts`, `-import.test.ts`, `-import-run.ts`, and `-import-run.test.ts` — dialogue profile/builder/version validation.
- `scripts/memory-v3-pilot/dialogue-history-backfill-run.test.ts` — exact dialogue profile CLI examples.
- `scripts/memory-v3-pilot/README.md` and `README-dialogue-history-backfill.md` — correct scope-owned commands and identities.

---

### Task 1: Shared request boundary and scope-owned prompt modules

**Files:**
- Create: `supabase/functions/_shared/memoryV3/extractorRequest.ts`
- Create: `supabase/functions/_shared/memoryV3/extractorRequest.cases.test.ts`
- Create: `supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.ts`
- Create: `supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.cases.test.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts`
- Create: `supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.cases.test.ts`
- Create: `supabase/functions/_shared/memoryV3/scopeExtractorSemanticFixtures.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/prompt.ts`
- Modify: `supabase/functions/_shared/memoryV3/prompt.cases.test.ts`

**Interfaces:**
- Produces: `MemoryV3ExtractorRequest`.
- Produces: `buildMemoryV3ExtractorRequestForInstruction(input: unknown, instruction: string): MemoryV3ExtractorRequest`; only fixed wrapper modules may call it.
- Produces: `MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION` and `buildMemoryV3LifecycleExtractorRequest(input: unknown)`.
- Produces: `MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION` and `buildMemoryV3DialogueExtractorRequest(input: unknown)`.
- Preserves: `MEMORY_V3_SYSTEM_INSTRUCTION` and `buildMemoryV3ExtractorRequest(input: unknown)` from `prompt.ts` for legacy consumers.

- [ ] **Step 1: Record the baseline before editing**

Run:

```powershell
git status --short
npx tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts
git diff --check
```

Expected: prompt and contract suites pass; status contains no unexpected tracked changes.

- [ ] **Step 2: Write failing scope-prompt tests**

Add tests that import modules which do not exist yet and lock the exact identities and boundary rules:

```ts
assert.equal(
  MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION,
  "memory-v3-openrouter-gemini-3.7-flash-lifecycle-extractor-v1",
);
assert.equal(
  MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
  "memory-v3-openrouter-gemini-3.7-flash-dialogue-extractor-v1",
);

const lifecycle = buildMemoryV3LifecycleExtractorRequest(dialogue());
const dialogueRequest = buildMemoryV3DialogueExtractorRequest(dialogue());
assert.notEqual(lifecycle.system, dialogueRequest.system);
assert.match(lifecycle.system, /one short atomic cross-conversation fact/i);
assert.match(lifecycle.system, /omit event chronology, conflict history, health, medical information, personal therapy, religion, and third-party plans/i);
assert.match(lifecycle.system, /"запомни здесь".*conversation-only.*omit/i);
assert.match(dialogueRequest.system, /same conversation continues/i);
assert.match(dialogueRequest.system, /events, decisions, conflict history, and bounded narrative context/i);
```

Also test that the shared request boundary rejects unknown keys and getters without executing them, returns fresh message objects, and never accepts a runtime `scope` field.

Add a table-driven prompt-contract suite with these exact paired examples embedded in the two instructions:

```ts
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const fixtures = [
  { source: "Сын съехал и может уйти в армию", lifecycle: "Есть сын", dialogue: "may retain move and army context" },
  { source: "С Димой дважды расходились, сейчас вместе", lifecycle: "Состоит в отношениях с Димой", dialogue: "may retain breakup history" },
  { source: "Живет одна в доме площадью 100 м²", lifecycle: "Живет одна", dialogue: "may retain property detail when relevant" },
  { source: "Не употребляет алкоголь из-за страха за здоровье", lifecycle: "omit", dialogue: "may retain locally when relevant and safe" },
  { source: "Проходила личную и групповую терапию и училась консультированию", lifecycle: "omit personal therapy; separately evidenced professional role only", dialogue: "may retain therapy context when relevant and safe" },
  { source: "Запомни здесь: у меня есть сын", lifecycle: "omit because conversation-only", dialogue: "admit" },
  { source: "Запомни: у меня есть сын", lifecycle: "Есть сын", dialogue: "may also retain locally" },
] as const;

for (const fixture of fixtures) {
  assert.match(MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.source), "u"));
  assert.match(MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.lifecycle), "u"));
  assert.match(MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.source), "u"));
  assert.match(MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION, new RegExp(escapeRegExp(fixture.dialogue), "u"));
}
```

This offline suite locks the policy and examples supplied to the model. Actual model compliance remains the separately approved paid acceptance gate.

- [ ] **Step 3: Run the new tests and verify a genuine RED**

Run:

```powershell
npx tsx supabase/functions/_shared/memoryV3/extractorRequest.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/scopeExtractorSemanticFixtures.cases.test.ts
```

Expected: failure is `ERR_MODULE_NOT_FOUND` or missing named exports from the three new production modules, not test syntax failure.

- [ ] **Step 4: Implement the shared request constructor**

Move the request interface and validated clone into `extractorRequest.ts`:

```ts
export interface MemoryV3ExtractorRequest {
  system: string;
  input: {
    caseId: string;
    messages: MemoryV3DialogueMessage[];
  };
}

export function buildMemoryV3ExtractorRequestForInstruction(
  input: unknown,
  instruction: string,
): MemoryV3ExtractorRequest {
  const validated = validateMemoryV3Dialogue(input);
  return {
    system: instruction,
    input: {
      caseId: validated.caseId,
      messages: validated.messages.map(({ id, role, text, createdAt }) => ({
        id,
        role,
        text,
        createdAt,
      })),
    },
  };
}
```

Keep format, evidence, and prompt-injection safety instruction fragments in this module. Do not add `scope`, profile id, environment reads, filesystem access, fetch, or provider code.

- [ ] **Step 5: Implement the two fixed wrapper modules**

Use exact fixed exports and no runtime policy selector:

```ts
export const MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION =
  "memory-v3-openrouter-gemini-3.7-flash-lifecycle-extractor-v1" as const;

export function buildMemoryV3LifecycleExtractorRequest(
  input: unknown,
): MemoryV3ExtractorRequest {
  return buildMemoryV3ExtractorRequestForInstruction(
    input,
    MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION,
  );
}
```

```ts
export const MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION =
  "memory-v3-openrouter-gemini-3.7-flash-dialogue-extractor-v1" as const;

export function buildMemoryV3DialogueExtractorRequest(
  input: unknown,
): MemoryV3ExtractorRequest {
  return buildMemoryV3ExtractorRequestForInstruction(
    input,
    MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION,
  );
}
```

The lifecycle instruction must explicitly enumerate the allowlist, require one atomic claim, distill an allowed core from a story, omit the excluded detail categories, and respect explicit conversation-only wording. The dialogue instruction must explicitly permit conversation-local people, events, decisions, conflict history, temporary context, and safe user-originated sensitive context.

- [ ] **Step 6: Preserve the legacy prompt API**

Keep the old instruction byte-for-byte and delegate only the cloning call:

```ts
export type { MemoryV3ExtractorRequest } from "./extractorRequest.ts";

export function buildMemoryV3ExtractorRequest(input: unknown): MemoryV3ExtractorRequest {
  return buildMemoryV3ExtractorRequestForInstruction(
    input,
    MEMORY_V3_SYSTEM_INSTRUCTION,
  );
}
```

The existing equality assertion against `EXTRACTOR_SYSTEM_INSTRUCTION_V2` must remain GREEN.

- [ ] **Step 7: Run focused GREEN and regression tests**

Run:

```powershell
npx tsx supabase/functions/_shared/memoryV3/extractorRequest.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/scopeExtractorSemanticFixtures.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/transport.cases.test.ts
git diff --check
```

Expected: all suites pass and the legacy prompt equality remains unchanged.

- [ ] **Step 8: Commit Task 1**

```powershell
git add supabase/functions/_shared/memoryV3/extractorRequest.ts supabase/functions/_shared/memoryV3/extractorRequest.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.ts supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.cases.test.ts supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.cases.test.ts supabase/functions/_shared/memoryV3/scopeExtractorSemanticFixtures.cases.test.ts supabase/functions/_shared/memoryV3/prompt.ts supabase/functions/_shared/memoryV3/prompt.cases.test.ts
git commit -m "[agent] feat: separate Memory V3 extractor prompts"
```

### Task 2: Wire live runners to fixed scope identities

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`

**Interfaces:**
- Consumes: the two builders and version constants from Task 1.
- Preserves: runner option/result types, store interfaces, diagnostics, caps, transport, reconciliation, and reducer behavior.

- [ ] **Step 1: Add RED source-isolation and runtime identity assertions**

For lifecycle:

```ts
assert.match(source, /from "\.\/lifecycleExtractorPrompt\.ts"/);
assert.doesNotMatch(source, /from "\.\/prompt\.ts"/);
assert.doesNotMatch(source, /dialogueExtractorPrompt/);
assert.equal(reservation.extractorVersion, MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION);
assert.equal(capturedRequest.system, MEMORY_V3_LIFECYCLE_EXTRACTOR_SYSTEM_INSTRUCTION);
```

For dialogue:

```ts
assert.match(source, /from "\.\/dialogueExtractorPrompt\.ts"/);
assert.doesNotMatch(source, /from "\.\/prompt\.ts"/);
assert.doesNotMatch(source, /lifecycleExtractorPrompt/);
assert.equal(reservation.extractorVersion, MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION);
assert.equal(capturedRequest.system, MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION);
```

Add a mismatch response test proving `normalizeMemoryV3LayeredResponse` rejects the legacy or opposite-scope extractor version and persists `extractor_contract_invalid`.

- [ ] **Step 2: Run both runner suites and verify RED**

```powershell
npx tsx supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
```

Expected: assertions show both runners still import the legacy prompt/version.

- [ ] **Step 3: Replace lifecycle imports and identity uses**

Use only:

```ts
import {
  MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION,
  buildMemoryV3LifecycleExtractorRequest,
} from "./lifecycleExtractorPrompt.ts";
```

Replace the builder return type, byte-fitting calls, reservation `extractorVersion`, and normalization expected version with the lifecycle names.

- [ ] **Step 4: Replace dialogue imports and identity uses**

Use only:

```ts
import {
  MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
  buildMemoryV3DialogueExtractorRequest,
} from "./dialogueExtractorPrompt.ts";
```

Replace the builder return type, byte-fitting calls, reservation `extractorVersion`, and normalization expected version with the dialogue names.

- [ ] **Step 5: Run focused GREEN and legacy regression**

```powershell
npx tsx supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
git diff --check
```

Expected: scope runners pass with distinct identities; legacy shadow runner still passes with the legacy identity.

- [ ] **Step 6: Commit Task 2**

```powershell
git add supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
git commit -m "[agent] refactor: bind Memory V3 live runners to scope"
```

### Task 3: Make live scheduling independent

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts`

**Interfaces:**
- Consumes: unchanged safe background wrappers.
- Produces: one post-turn promise that schedules zero, one, or both production scope runners without one branch returning before the other is evaluated.
- Preserves: the existing profile master gate and mutually exclusive legacy generic shadow mode.

- [ ] **Step 1: Replace the old mutual-exclusion test with RED independence tests**

Assert the bounded write block contains two independently constructed promises and no dialogue early return:

```ts
assert.match(block, /const dialogueMemoryPromise/);
assert.match(block, /const lifecycleMemoryPromise/);
assert.match(block, /Promise\.all\(\[dialogueMemoryPromise, lifecycleMemoryPromise\]\)/);
assert.doesNotMatch(block, /if \(dialogueEligibility\.eligible\) \{\s*return runMemoryV3DialogueShadowBackgroundSafely/s);
```

Keep the existing read-path additive test and add an assertion that the legacy `shadow` branch cannot run beside `lifecycle_shadow` or `lifecycle_all`.

- [ ] **Step 2: Run the wiring suites and verify RED**

```powershell
npx tsx supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts
```

Expected: the current early-return/mutual-exclusion source fails the new assertions.

- [ ] **Step 3: Refactor the post-turn write block**

Use explicit independent promises after the master gate:

```ts
const dialogueMemoryPromise = dialogueEligibility.eligible
  ? runMemoryV3DialogueShadowBackgroundSafely(
      () => runMemoryV3DialogueShadow({
        userId,
        conversationId,
        apiKey: Deno.env.get("OPENROUTER_API_KEY"),
        loadMessages: createMemoryV3MessageLoader(svc),
        store: createMemoryV3DialogueStore(svc),
        extractorAdapterFactory: (apiKey) => createMemoryV3OpenRouterAdapter({
          apiKey,
          fetchImpl: globalThis.fetch.bind(globalThis),
        }),
        reconcilerAdapterFactory: (apiKey) => createMemoryV3DialogueOpenRouterAdapter({
          apiKey,
          fetchImpl: globalThis.fetch.bind(globalThis),
        }),
      }, (code) => console.error("[memory-v3-dialogue-transport]", code),
        (usage) => logMemoryV3LifecycleUsage(svc, usage)),
      (code) => console.error("[memory-v3-dialogue-shadow]", code),
    )
  : Promise.resolve();

const lifecycleMemoryPromise =
    memoryV3Mode === "lifecycle_shadow" || memoryV3Mode === "lifecycle_all"
  ? runMemoryV3LifecycleShadowBackgroundSafely(
      () => runMemoryV3LifecycleShadow({
        rawMode: memoryV3Mode,
        rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_SHADOW_USER_ID"),
        userId,
        conversationId,
        apiKey: Deno.env.get("OPENROUTER_API_KEY"),
        loadMessages: createMemoryV3MessageLoader(svc),
        store: createMemoryV3LifecycleStore(svc),
        extractorAdapterFactory: (apiKey) => createMemoryV3OpenRouterAdapter({
          apiKey,
          fetchImpl: globalThis.fetch.bind(globalThis),
        }),
        reconcilerAdapterFactory: (apiKey) => createMemoryV3LifecycleOpenRouterAdapter({
          apiKey,
          fetchImpl: globalThis.fetch.bind(globalThis),
        }),
      }, (code) => console.error("[memory-v3-lifecycle-transport]", code),
        (usage) => logMemoryV3LifecycleUsage(svc, usage)),
      (code) => {
        console.error("[memory-v3-lifecycle-shadow]", code);
        scheduleMemoryV3TelegramAlert("write", code);
      },
    )
  : memoryV3Mode === "shadow"
  ? runMemoryV3ShadowBackgroundSafely(
      () => runMemoryV3Shadow({
        rawMode: memoryV3Mode,
        rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_SHADOW_USER_ID"),
        userId,
        conversationId,
        apiKey: Deno.env.get("OPENROUTER_API_KEY"),
        loadMessages: createMemoryV3MessageLoader(svc),
        store: createMemoryV3ShadowStore(svc),
        modelAdapterFactory: (apiKey) => createMemoryV3OpenRouterAdapter({
          apiKey,
          fetchImpl: globalThis.fetch.bind(globalThis),
        }),
      }),
      (code) => console.error("[memory-v3-shadow]", code),
    )
  : Promise.resolve();

return Promise.all([dialogueMemoryPromise, lifecycleMemoryPromise]);
```

Use the existing full argument objects; do not change adapters, env names, error logging, usage logging, alert scheduling, or the `cross_memory_enabled` master gate.

- [ ] **Step 4: Run focused GREEN and typecheck**

```powershell
npx tsx supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts
npm run typecheck
git diff --check
```

Expected: all wiring/runner suites pass; typecheck has no new errors.

- [ ] **Step 5: Commit Task 3**

```powershell
git add supabase/functions/staysee-chat/index.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts
git commit -m "[agent] fix: schedule Memory V3 scopes independently"
```

### Task 4: Split provider pricing from scope-owned backfill profiles

**Files:**
- Create: `scripts/memory-v3-pilot/history-backfill-provider-profile.ts`
- Create: `scripts/memory-v3-pilot/history-backfill-provider-profile.test.ts`
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-profile.ts`
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts`

**Interfaces:**
- Produces scope-neutral route/price exports currently used by provider and budget code.
- Produces `getLifecycleHistoryBackfillProfile(profileId: unknown)` with lifecycle id/version.
- Produces `getDialogueHistoryBackfillProfile(profileId: unknown)` with dialogue id/version.
- Both profile objects are deeply frozen and exact-key validated.

- [ ] **Step 1: Add RED tests for exact profile ownership**

```ts
const lifecycle = getLifecycleHistoryBackfillProfile(
  "memory-v3-lifecycle-history-backfill-v1",
);
const dialogue = getDialogueHistoryBackfillProfile(
  "memory-v3-dialogue-history-backfill-v1",
);
assert.equal(lifecycle.profileId, "memory-v3-lifecycle-history-backfill-v1");
assert.equal(lifecycle.extractorVersion, MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION);
assert.equal(dialogue.profileId, "memory-v3-dialogue-history-backfill-v1");
assert.equal(dialogue.extractorVersion, MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION);
assert.notEqual(lifecycle, dialogue);
assert.equal(Object.isFrozen(lifecycle), true);
assert.equal(Object.isFrozen(dialogue), true);
```

Add source locks proving `dialogue-history-backfill-profile.ts` does not import the lifecycle profile and the common provider module contains neither profile id nor extractor version string.

- [ ] **Step 2: Run profile tests and verify RED**

```powershell
npx tsx --test scripts/memory-v3-pilot/history-backfill-provider-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
```

Expected: new modules are missing and the lifecycle profile still imports the legacy extractor version.

- [ ] **Step 3: Extract scope-neutral provider and budget code**

Move these responsibilities without semantic profile fields:

```ts
export const HISTORY_BACKFILL_PRIMARY_MODEL = "google/gemini-3.7-flash" as const;
export const HISTORY_BACKFILL_FALLBACK_MODEL = "mistralai/mistral-medium-3-5" as const;
export const HISTORY_BACKFILL_MODEL_ROUTE = Object.freeze([
  HISTORY_BACKFILL_PRIMARY_MODEL,
  HISTORY_BACKFILL_FALLBACK_MODEL,
] as const);

export function validateHistoryBackfillPriceSnapshot(input: unknown): HistoryBackfillPriceSnapshot;
export function calculateHistoryBackfillBudget(input: unknown): HistoryBackfillBudget;
```

Retain exact decimal arithmetic, one-day freshness validation, supported-parameter allowlist, ZDR requirement, proxy rejection, and branded safe errors.

- [ ] **Step 4: Implement thin scope profiles**

Lifecycle profile uses `MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION`; dialogue profile uses `MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION`. Each exports its own profile id, exact type, getter, validation helpers needed by its CLI, and the unchanged common route/cap values.

- [ ] **Step 5: Run GREEN plus hostile-input regression**

```powershell
npx tsx --test scripts/memory-v3-pilot/history-backfill-provider-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
git diff --check
```

Expected: exact values, deep freeze, stale-price rejection, proxy rejection, and budget calculations pass for both profiles.

- [ ] **Step 6: Commit Task 4**

```powershell
git add scripts/memory-v3-pilot/history-backfill-provider-profile.ts scripts/memory-v3-pilot/history-backfill-provider-profile.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-profile.ts scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
git commit -m "[agent] refactor: split Memory V3 backfill profiles"
```

### Task 5: Bind lifecycle history backfill and import validation

**Files:**
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts`
- Modify: `scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts`

**Interfaces:**
- Consumes: lifecycle profile and lifecycle extractor module only.
- Preserves: source snapshot, budget, call order, model fallback, safe output, review packet, approval, revision, and import RPC behavior.

- [ ] **Step 1: Add RED lifecycle source-lock and mismatch tests**

Across contract, engine, and import tests assert:

```ts
assert.doesNotMatch(source, /memoryV3\/prompt\.ts/);
assert.doesNotMatch(source, /dialogueExtractorPrompt/);
assert.match(source, /lifecycleExtractorPrompt\.ts/);
assert.equal(result.extractorVersion, MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION);
```

Add failures for dialogue extractor version/profile id and assert `fetchCalls === 0`, `writeCalls === 0`, and no temporary output.

- [ ] **Step 2: Run lifecycle backfill suites and verify RED**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts
```

Expected: old prompt/version imports violate the new assertions.

- [ ] **Step 3: Replace request/digest construction**

Every lifecycle request-byte, digest, engine, provider fixture, review packet, and import reconstruction must call:

```ts
buildMemoryV3LifecycleExtractorRequest(dialogue)
```

Every normalization, result, manifest, approval, and import comparison must use:

```ts
MEMORY_V3_LIFECYCLE_EXTRACTOR_VERSION
```

Import the request type from `extractorRequest.ts`, not legacy `prompt.ts`.

- [ ] **Step 4: Run lifecycle GREEN and CLI regression**

```powershell
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-approval.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts
npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts
git diff --check
```

Expected: all lifecycle history tests pass without provider or filesystem side effects beyond injected fakes.

- [ ] **Step 5: Commit Task 5**

```powershell
git add scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts
git commit -m "[agent] refactor: bind lifecycle history to lifecycle extractor"
```

### Task 6: Bind dialogue history stack to dialogue identity

**Files:**
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-cli.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-contract.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-engine.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-provider.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-import.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-import-run.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-import-run.test.ts`
- Modify: `scripts/memory-v3-pilot/dialogue-history-backfill-run.test.ts`

**Interfaces:**
- Consumes: dialogue profile, common provider profile, and dialogue extractor module only.
- Preserves: per-conversation ordering/isolation, revision capture, budget, safe output, no retry, review packet, approval, and import conflict behavior.

- [ ] **Step 1: Add RED profile rejection and source-isolation tests**

```ts
assert.equal(PROFILE_ID, "memory-v3-dialogue-history-backfill-v1");
await assert.rejects(
  () => runDialogueHistoryBackfillFromArgv([
    "--inspect-source",
    "--profile",
    "memory-v3-lifecycle-history-backfill-v1",
  ], io),
  /profile/u,
);
assert.equal(io.readEnvCalls, 0);
assert.equal(io.fetchCalls, 0);
assert.equal(io.writeCalls, 0);
```

For each dialogue production module, reject imports of `lifecycle-history-backfill-profile.ts`, `memoryV3/prompt.ts`, and `lifecycleExtractorPrompt.ts`.

- [ ] **Step 2: Run dialogue backfill suites and verify RED**

```powershell
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-import-run.test.ts
```

Expected: current lifecycle-profile and legacy-prompt coupling fails the assertions.

- [ ] **Step 3: Replace all dialogue profile imports**

Use only:

```ts
import {
  DIALOGUE_HISTORY_BACKFILL_PROFILE_ID,
  getDialogueHistoryBackfillProfile,
} from "./dialogue-history-backfill-profile.ts";
```

Provider route/price helpers import from `history-backfill-provider-profile.ts`. No dialogue production module imports the lifecycle profile.

- [ ] **Step 4: Replace dialogue request/version reconstruction**

Use:

```ts
buildMemoryV3DialogueExtractorRequest(dialogue)
MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION
```

through contract byte calculations, engine execution, manifests, packets, approval checks, provider fixtures, import reconstruction, and import-run types. Import `MemoryV3ExtractorRequest` from `extractorRequest.ts`.

- [ ] **Step 5: Preserve preflight ordering**

In CLI/run/import negative tests, prove wrong profile/version fails before:

```ts
assert.equal(readEnvCalls, 0);
assert.equal(providerHttpCalls, 0);
assert.equal(readFileCalls, 0);
assert.equal(writeFileCalls, 0);
assert.equal(linkCalls, 0);
assert.equal(unlinkCalls, 0);
```

Do not weaken getter/proxy/cycle, duplicate/missing/reordered conversation, revision, safe-output, or privacy assertions.

- [ ] **Step 6: Run full dialogue history GREEN**

```powershell
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-run.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-approval.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts
npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-import-run.test.ts
git diff --check
```

Expected: all dialogue tests pass with the dialogue profile id accepted and lifecycle profile id rejected before side effects.

- [ ] **Step 7: Commit Task 6**

```powershell
git add scripts/memory-v3-pilot/dialogue-history-backfill-profile.ts scripts/memory-v3-pilot/dialogue-history-backfill-profile.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-cli.ts scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-contract.ts scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-engine.ts scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-provider.ts scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-import.ts scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-import-run.ts scripts/memory-v3-pilot/dialogue-history-backfill-import-run.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-run.test.ts
git commit -m "[agent] refactor: bind dialogue history to dialogue extractor"
```

### Task 7: Documentation, full offline gate, and review PR

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Modify: `scripts/memory-v3-pilot/README-dialogue-history-backfill.md`

**Interfaces:**
- Documents exact commands and explains that profile ids and extractor identities are scope-owned.
- Produces no provider calls, deploy, merge, or import.

- [ ] **Step 1: Update commands and warnings**

The dialogue README commands must use:

```powershell
--profile memory-v3-dialogue-history-backfill-v1
```

Remove the explanation that dialogue intentionally accepts the lifecycle profile. Add a warning that cross-scope profile ids fail before env/network/fs and that old artifacts are audit-only under their recorded identity.

- [ ] **Step 2: Run the complete shared Memory V3 test set**

```powershell
Get-ChildItem 'supabase/functions/_shared/memoryV3' -Filter '*.test.ts' | Sort-Object Name | ForEach-Object {
  npx tsx $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: every Memory V3 suite exits 0.

- [ ] **Step 3: Run the complete lifecycle and dialogue history test sets**

```powershell
Get-ChildItem 'scripts/memory-v3-pilot' -Filter '*history-backfill*.test.ts' | Sort-Object Name | ForEach-Object {
  npx tsx --test $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: every history-backfill suite exits 0; provider HTTP calls remain injected/mocked.

- [ ] **Step 4: Run compile, lint-on-owned-files, build, and whitespace checks**

```powershell
npm run typecheck
npx eslint supabase/functions/_shared/memoryV3/extractorRequest.ts supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.ts supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/staysee-chat/index.ts scripts/memory-v3-pilot/history-backfill-provider-profile.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts scripts/memory-v3-pilot/dialogue-history-backfill-profile.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts scripts/memory-v3-pilot/dialogue-history-backfill-cli.ts scripts/memory-v3-pilot/dialogue-history-backfill-contract.ts scripts/memory-v3-pilot/dialogue-history-backfill-engine.ts scripts/memory-v3-pilot/dialogue-history-backfill-provider.ts scripts/memory-v3-pilot/dialogue-history-backfill-import.ts scripts/memory-v3-pilot/dialogue-history-backfill-import-run.ts
npm run build
git diff --check
git diff --cached --check
```

Expected: every command exits 0. If the repository has a pre-existing lint/build failure, record the exact baseline and prove no changed file introduced a new failure before proceeding.

- [ ] **Step 5: Run source-boundary and privacy scans**

```powershell
rg -n "buildMemoryV3ExtractorRequest|MEMORY_V3_EXTRACTOR_VERSION" supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts scripts/memory-v3-pilot -g "lifecycle-history-backfill-*.ts" -g "dialogue-history-backfill-*.ts"
rg -n "lifecycle-history-backfill-profile" scripts/memory-v3-pilot -g "dialogue-history-backfill*.ts"
rg -n "process\.env|Deno\.env|globalThis\.fetch|Authorization|OPENROUTER_API_KEY|sk-|eyJ" supabase/functions/_shared/memoryV3/extractorRequest.ts supabase/functions/_shared/memoryV3/lifecycleExtractorPrompt.ts supabase/functions/_shared/memoryV3/dialogueExtractorPrompt.ts
```

Expected: first scan finds legacy names only in legacy/tests explicitly retained, not scope production stacks; second scan returns no dialogue production imports; third scan returns no secrets/env/network access in prompt/request modules.

- [ ] **Step 6: Commit documentation**

```powershell
git add scripts/memory-v3-pilot/README.md scripts/memory-v3-pilot/README-dialogue-history-backfill.md
git commit -m "[agent] docs: explain Memory V3 scope-owned backfills"
```

- [ ] **Step 7: Verify final branch state and push normally**

```powershell
git status --short
git log --oneline --decorate -10
git diff origin/main...HEAD --check
git push -u origin codex/memory-v3-scope-separated-extractors
```

Expected: no unexpected tracked/untracked files, ordinary non-force push, and the branch contains only the design, plan, implementation, tests, and documentation for this scope.

- [ ] **Step 8: Open a review PR and stop before merge/deploy/paid work**

Create a PR with:

```text
Title: [agent] Separate Memory V3 lifecycle and dialogue extractors

Body:
- Gives lifecycle and dialogue independent extractor prompts, builders, versions, and backfill profiles.
- Removes dialogue early-return suppression of lifecycle scheduling.
- Preserves legacy shadow compatibility, schemas, master toggle, budgets, safe-output, and no-retry guarantees.
- Offline verification only; no deploy, provider call, paid run, or production-memory import.
```

Attach the PR to the task. Do not merge, deploy, inspect `.env`, call OpenRouter, run a paid acceptance, or import an artifact in this plan.

## Deferred Required Follow-Up

After this PR is reviewed and the semantic-isolation acceptance succeeds, write a separate design/spec for user controls:

- lifecycle memory on/off per profile;
- default dialogue-memory behavior for new conversations;
- per-conversation dialogue override;
- clear UI explanation of which scope is active;
- migration/defaults/backward compatibility;
- independent read/write gates and Telegram fallback alerts.

That controls project is required before StaySEE memory is described as fully user-configurable, but it must not delay or contaminate the semantic scope-separation implementation above.
