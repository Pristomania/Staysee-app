# Memory V3 Lifecycle Read Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let exactly one allowlisted StaySEE account use verified Memory V3 lifecycle state instead of legacy cross-conversation `user_memory` while preserving all per-conversation context and a safe legacy fallback.

**Architecture:** A pure exact-account gate authorizes one service-only read RPC. The RPC returns a closed bounded projection, a strict TypeScript store validates it, and a pure formatter creates a server-only prompt block. `staysee-chat` passes the loaded context into `buildContextPrompt`; a loaded state suppresses legacy cross-memory, while disabled, missing, or failed reads preserve the existing path.

**Tech Stack:** TypeScript, Node `node:test` through `tsx`, Deno-compatible Supabase Edge Function modules, PostgreSQL/Supabase SQL, service-role RPC, existing React/Vite application regression gates.

**Spec:** `docs/superpowers/specs/2026-09-20-memory-v3-lifecycle-read-canary-design.md`

## Global Constraints

- Work only in the linked worktree `D:/Staisy-main Приложение/Staysee-memory-v3` on `codex/memory-v3-lifecycle-read-canary`.
- Preserve the pre-existing modified `supabase/.temp/cli-latest` and every untracked `scripts/memory-v3-pilot/_tmp-*.json` artifact. Never edit, stage, delete, rename, or commit them.
- Follow TDD: write a behavior test, run it to obtain a real non-syntax RED, then write the minimum implementation.
- Stop for a focused review after each task. Commit only when Nastya explicitly authorizes it.
- Never read `.env`, access a deployed database, deploy a migration or Edge Function, change Supabase secrets, call OpenRouter, run a paid benchmark, or enable the canary while executing this plan.
- `STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE` accepts only exact `off` and `canary`; missing, empty, malformed, or unknown values mean `off`.
- `STAYSEE_MEMORY_V3_LIFECYCLE_READ_USER_ID` authorizes exactly one canonical lowercase UUID. Lists, arrays, wildcards, uppercase UUIDs, inherited values, and wrapper objects are invalid.
- Read authorization is independent from `STAYSEE_MEMORY_V3_MODE` and `STAYSEE_MEMORY_V3_SHADOW_USER_ID`.
- Disabled and non-allowlisted requests perform zero lifecycle RPC calls.
- One eligible response performs at most one lifecycle RPC and zero lifecycle provider calls, retries, repairs, or writes.
- A loaded lifecycle context is authoritative even when `items` is empty. Only disabled, missing-head, or failed reads use legacy cross-memory.
- Include only event/active, recurrence/active, and hypothesis/supported items; reject every other kind/status combination.
- Cap projection at 12 items and formatted output at 6,000 UTF-8 bytes.
- Never expose evidence, source messages, conversation IDs, memory keys, account IDs, run audit, usage, prompts, credentials, raw database responses, or raw exceptions.
- Keep lifecycle tables RLS-enabled with no `anon` or `authenticated` policies. The new RPC is service-role-only with `SECURITY DEFINER SET search_path = ''` and schema-qualified references.
- Use module-local `WeakSet` brands and closed diagnostics. Never trust external `name`, `message`, `code`, `diagnosticCode`, getters, prototypes, proxy traps, attacker property names, or `cause`.
- JSON-data-only boundaries accept only plain objects, own enumerable data properties, dense arrays, finite primitives, and exact allowlisted keys.
- Keep `conversation_summary`, recent messages, corrections, archive retrieval, weekly reflections, summaries, legacy writers, analytics, UI, and HTTP response schemas unchanged.
- Keep the feature off by default. This plan does not authorize migration deployment, environment changes, canary activation, or multi-account rollout.
- Frozen implementation hashes at plan authoring time:

```text
ECE40C7EAE6DD806D84EA223DB7FB850452C241040CAFC235809B70BCF6779B2  supabase/functions/_shared/memoryV3/lifecycleContract.ts
071C9914B374ECC0461B6C49E0D85C00C8141AB3C7AE24AE960EDBADD6A6461A  supabase/functions/_shared/memoryV3/lifecycleReducer.ts
80247FD956861A5D8440E6217962DAFF15B9593A7A9E237BD56E9F7869EFE841  supabase/functions/_shared/memoryV3/lifecyclePrompt.ts
B298AE34C15CD6FBE83138CA353D28ABCD56FA220D918FDD15A824A4BD70F126  supabase/functions/_shared/memoryV3/lifecycleTransport.ts
B2E66F21EA1B48F9540C08444F2A9F36BE0319AA3D36366633E127898B53867E  supabase/functions/_shared/memoryV3/lifecycleStore.ts
55694E3366D76E20D015042348D238BB7C2AA11AB966D39A1B9BC12014916214  supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts
1BC7454D2140156ACEA1DE0F8FC89959D0590A26BC3E73BBDDC3774E5FE5AB21  supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql
B1F77B70CEF32A71DF0B9F33657398045656AD6FECE0AF4F7DDFC76C891445A6  supabase/migrations/20260915010000_035_memory_v3_lifecycle_shadow_development_cap.sql
FF66831A103A9BDA0AA3CBFA1D8C1316AEA2F2E4ED73F73466036B567DE17091  docs/superpowers/specs/2026-09-20-memory-v3-lifecycle-read-canary-design.md
```

## File Map

| Path | Responsibility |
|---|---|
| `memoryV3/lifecycleReadMode.ts` | Pure fail-closed mode and exact-account eligibility |
| `memoryV3/lifecycleReadStore.ts` | Strict service-role RPC adapter and closed read projection |
| `memoryV3/lifecycleReadPrompt.ts` | Pure bounded formatter for authoritative lifecycle context |
| `memoryV3/lifecycleReadWiring.cases.test.ts` | Context-selection and composition-root source locks |
| `migration 036` | Service-only bounded read RPC without new table policies |
| `context.ts` | Optional authoritative cross-memory replacement during prompt construction |
| `staysee-chat/index.ts` | Environment/service composition and legacy fallback |
| `README.md` | Offline status, exact safety boundary, and deployment STOP |

## Execution Precheck

Before Task 1 and again before every later task:

1. Confirm root, branch, HEAD/upstream, linked-worktree isolation, and `git status --short`.
2. Confirm only task files plus the protected `.temp` and `_tmp-*.json` files differ.
3. Recompute every frozen hash above and stop on mismatch.
4. Run `node --test scripts/memory-v3-pilot/*.test.mjs`; the authoring baseline is **769 tests / 199 suites / 769 pass / 0 fail**.
5. Run every existing `supabase/functions/_shared/memoryV3/*.cases.test.ts` file with `npx.cmd tsx`; all files must pass.
6. Run `git diff --check`; stop on whitespace errors.

---

### Task 1: Lock the Offline Baseline

**Files:**
- Create: none
- Modify: none
- Test: existing Memory V3 test suites only

**Interfaces:**
- Consumes: current merged pilot at `19d900beb9fe04cf4a08471e01a5bbbed2b919b0`.
- Produces: recorded exact baseline and verified frozen hashes for later task comparisons.

- [ ] **Step 1: Run the complete precheck**

Use the commands in Execution Precheck. Capture exact test totals and SHA-256 values without modifying files.

- [ ] **Step 2: Verify isolation**

Run:

```powershell
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree
git branch --show-current
git status --short
```

Expected: git-dir differs from git-common-dir, no superproject path, branch is `codex/memory-v3-lifecycle-read-canary`, and only protected pre-existing paths plus the spec/plan are present.

- [ ] **Step 3: Stop for review**

Report the baseline. Do not stage, commit, or begin Task 2 until the baseline is green.

---

### Task 2: Exact Read-Canary Eligibility

**Files:**
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadMode.ts`
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts`

**Interfaces:**
- Consumes: raw server strings and the authenticated user ID.
- Produces:

```ts
export type MemoryV3LifecycleReadMode = "off" | "canary";

export type MemoryV3LifecycleReadEligibility =
  | { eligible: true; mode: "canary"; userId: string }
  | {
      eligible: false;
      mode: MemoryV3LifecycleReadMode;
      reason: "disabled" | "invalid_allowlist" | "user_not_allowlisted";
    };

export function parseMemoryV3LifecycleReadMode(
  raw: string | null | undefined,
): MemoryV3LifecycleReadMode;

export function resolveMemoryV3LifecycleReadEligibility(input: {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
}): MemoryV3LifecycleReadEligibility;
```

- [ ] **Step 1: Write failing eligibility tests**

Cover exact `canary`, exact `off`, missing/empty/unknown/case-variant modes, matching canonical UUID, different user, uppercase/malformed/list/wildcard IDs, null/array/primitive options, unknown/symbol/non-enumerable/inherited fields, getter/setter-only fields, revoked proxies, stateful traps, input non-mutation, and zero getter execution.

Use exact safety assertions:

```ts
assert.equal(getterCalls, 0);
assert.equal("cause" in error, false);
assert.equal(error.message, "[memory-v3:lifecycle-read-mode] invalid eligibility input");
assert.equal(JSON.stringify(error).includes(RAW_SENTINEL), false);
```

- [ ] **Step 2: Run RED**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for `lifecycleReadMode.ts`; no syntax or fixture error.

- [ ] **Step 3: Implement the pure gate**

Use an exact canonical UUID regex, an exact three-field options allowlist, descriptor inspection, plain/null-prototype object validation, and a module-local `WeakSet` error brand. Do not import Deno, Supabase, filesystem, network, or existing shadow mode.

- [ ] **Step 4: Run GREEN and regressions**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts
npx.cmd tsx supabase/functions/_shared/memoryV3/mode.cases.test.ts
```

Expected: all pass; `mode.ts` remains unchanged.

- [ ] **Step 5: Verify and stop**

Run `node --check` on both new files, `git diff --check`, frozen hashes, and `git status --short`. Stop for review with nothing staged.

---

### Task 3: Service-Only SQL Projection and Strict Store

**Files:**
- Create: `supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql`
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadStore.ts`
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts`

**Interfaces:**
- Consumes: an injected Supabase-compatible RPC client and one canonical user ID.
- Produces:

```ts
export const MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION =
  "memory-v3-lifecycle-read-context-v1" as const;
export const MEMORY_V3_LIFECYCLE_READ_MAX_ITEMS = 12;

export interface MemoryV3LifecycleReadContext {
  schemaVersion: "memory-v3-lifecycle-read-context-v1";
  stateRevision: number;
  items: Array<{
    kind: "event" | "recurrence" | "hypothesis";
    claim: string;
    status: "active" | "supported";
    sensitivity: "normal" | "sensitive";
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    alternative: string | null;
    updatedAt: string;
  }>;
}

export interface MemoryV3LifecycleReadStore {
  load(userId: string): Promise<MemoryV3LifecycleReadContext | null>;
}

export function projectMemoryV3LifecycleReadContext(
  value: unknown,
): MemoryV3LifecycleReadContext;

export function createMemoryV3LifecycleReadStore(
  client: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> },
): MemoryV3LifecycleReadStore;
```

- [ ] **Step 1: Write failing SQL and store tests**

Assert the migration creates only `load_memory_v3_lifecycle_read_context(uuid)`, uses `SECURITY DEFINER SET search_path = ''`, schema-qualifies every lifecycle table, selects only current statuses, orders by `updated_at DESC, memory_key COLLATE "C"`, limits 12, returns `null` without a head, returns a closed object with an authoritative empty array, revokes from `PUBLIC`, `anon`, and `authenticated`, grants only `service_role`, adds no policy, and never references evidence/runs/identities/dialogue/provider fields.

Store tests cover a valid mixed context, null, empty items, all invalid kind/status combinations, bad hypothesis alternative, bad event dates, unsafe revision, over-cap arrays, unknown/symbol/non-enumerable/accessor/inherited/sparse/cyclic values, revoked proxies, stateful traps, PromiseLike RPC builders, client prototype methods, input/result non-mutation, no aliasing, raw database error non-leak, and one RPC exactly.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts
```

Expected: module-not-found for `lifecycleReadStore.ts`; no syntax/setup error.

- [ ] **Step 3: Implement migration 036**

Build the JSON object in SQL from the head and a 12-row lateral subquery. Emit only `schemaVersion`, `stateRevision`, and the nine item fields. Filter with the three exact kind/status pairs before limiting. Do not change tables, triggers, retention, daily cap, or existing functions.

- [ ] **Step 4: Implement strict store projection**

Inspect the client without invoking getters, call exactly:

```ts
client.rpc("load_memory_v3_lifecycle_read_context", { p_user_id: userId })
```

Project the response into fresh objects. Use one module-local branded generic error:

```text
[memory-v3:lifecycle-read-store] operation failed
```

Do not attach `cause` or include database text.

- [ ] **Step 5: Run GREEN and frozen storage tests**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleStore.cases.test.ts
npx.cmd tsx supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
```

Expected: all pass; migrations 032–035 and existing store modules remain byte-identical.

- [ ] **Step 6: Verify and stop**

Run `node --check`, `git diff --check`, frozen hashes, privacy grep, and `git status --short`. Stop for review with nothing staged.

---

### Task 4: Bounded Lifecycle Prompt Block

**Files:**
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadPrompt.ts`
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadPrompt.cases.test.ts`

**Interfaces:**
- Consumes: `MemoryV3LifecycleReadContext` from Task 3.
- Produces:

```ts
export const MEMORY_V3_LIFECYCLE_READ_MAX_PROMPT_BYTES = 6_000;

export function formatMemoryV3LifecycleReadPrompt(
  context: MemoryV3LifecycleReadContext,
): string;
```

- [ ] **Step 1: Write failing formatter tests**

Test exact grouping for active events, active recurrences, and supported hypotheses; explicit `Hypothesis:` and `Alternative:` labels; deterministic order from validated input; empty context returns `""`; sensitive-use, current-user precedence, tentative-hypothesis, hidden-store, no-quote, and forbidden-meaning instructions; no schema revision or internal identifier; UTF-8 byte cap; input non-mutation; and safe rejection of every hostile shape.

Use concrete synthetic claims:

```ts
const claims = {
  event: "Пользователь вернулся к работе после отпуска.",
  recurrence: "При бытовой неопределённости заранее перепроверяет планы.",
  hypothesis: "Юмор помогает дозировать уязвимость.",
  alternative: "Юмор помогает поддержать окружающих.",
};
```

- [ ] **Step 2: Run RED**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadPrompt.cases.test.ts
```

Expected: module-not-found for `lifecycleReadPrompt.ts`.

- [ ] **Step 3: Implement the pure formatter**

Validate through a shared exported projector from `lifecycleReadStore.ts` rather than duplicating the schema. Escape control characters that could spoof section delimiters, keep claims as untrusted bullet text, and measure the final string with `TextEncoder`. Oversize input throws a local branded generic error without copying content.

- [ ] **Step 4: Run GREEN and prompt regressions**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadPrompt.cases.test.ts
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts
npx.cmd tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
```

- [ ] **Step 5: Verify and stop**

Run syntax, whitespace, frozen-hash, privacy, and status checks. Stop for review with nothing staged.

---

### Task 5: Authoritative Cross-Memory Replacement in Context Construction

**Files:**
- Modify: `supabase/functions/_shared/context.ts`
- Create: `supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts`

**Interfaces:**
- Consumes: optional validated `MemoryV3LifecycleReadContext`.
- Produces:

```ts
export interface ContextPromptOptions {
  lifecycleCrossMemory: MemoryV3LifecycleReadContext;
}

export function buildContextPrompt(
  packet: ContextPacket,
  options?: ContextPromptOptions,
): string;
```

The presence of `options.lifecycleCrossMemory` is authoritative. An empty `items` array suppresses legacy cross-memory.

- [ ] **Step 1: Write failing context-selection tests**

Construct a complete synthetic `ContextPacket` with a conversation summary, legacy memory row, durable correction, weekly reflection, archive excerpt, and user evidence. Assert:

```ts
const legacy = buildContextPrompt(packet);
assert.match(legacy, /LEGACY_CROSS_MEMORY_SENTINEL/);

const loaded = buildContextPrompt(packet, { lifecycleCrossMemory: context });
assert.doesNotMatch(loaded, /LEGACY_CROSS_MEMORY_SENTINEL/);
assert.match(loaded, /MEMORY V3 — CROSS-CONVERSATION CONTEXT/);

const authoritativeEmpty = buildContextPrompt(packet, {
  lifecycleCrossMemory: { ...context, items: [] },
});
assert.doesNotMatch(authoritativeEmpty, /LEGACY_CROSS_MEMORY_SENTINEL/);
```

Also assert summary/corrections/weekly/archive/evidence remain, narrative construction receives no legacy cross-memory in authoritative mode, omitted options preserve byte-for-byte legacy output, packet/context are not mutated, and hostile options fail safely without executing getters.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts
```

Expected: the loaded call still includes the legacy sentinel or the options signature is rejected.

- [ ] **Step 3: Implement the optional replacement**

Inspect the optional options object with an exact one-field data-only boundary. When present, set `injectableCrossMemory` to `[]`, format the V3 block, and pass no legacy rows to `buildNarrativeContext`. When absent, execute the current code path unchanged.

- [ ] **Step 4: Run GREEN and context regressions**

Run the new test plus existing context, narrative, cross-memory, correction, retrieval, and usage tests discovered by `rg --files supabase/functions/_shared -g '*test.ts'`. Record exact commands and pass totals.

- [ ] **Step 5: Verify and stop**

Run syntax, whitespace, frozen hashes, source privacy grep, and status. Stop for review with nothing staged.

---

### Task 6: Compose the Canary in `staysee-chat`

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts`

**Interfaces:**
- Consumes: Task 2 eligibility, Task 3 store, Task 5 prompt option.
- Produces: one exact-account synchronous read before the main reply prompt, with legacy fallback and closed diagnostics.

- [ ] **Step 1: Extend wiring tests for a real RED**

Source-lock exact imports and the two exact environment names. Add an injected harness that proves:

- off/unknown mode and another account perform zero store loads;
- eligible account calls `load` once;
- loaded non-empty and loaded empty both suppress legacy row stamping;
- null/missing head preserves legacy prompt and row stamping;
- store throw, invalid shape, and oversized prompt preserve legacy prompt and log only `load_failed`, `invalid_shape`, or `too_large`;
- no getter/proxy/raw-error sentinel reaches logs;
- lifecycle context never enters response JSON, summary inputs, analytics, or client-visible objects;
- the main reply model remains the only provider call in this read path.

The source test must require:

```ts
Deno.env.get("STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE")
Deno.env.get("STAYSEE_MEMORY_V3_LIFECYCLE_READ_USER_ID")
```

and forbid implicit authorization through `STAYSEE_MEMORY_V3_SHADOW_USER_ID`.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts
```

Expected: missing composition imports/environment reads and legacy stamp suppression assertions fail; no syntax failure.

- [ ] **Step 3: Implement composition**

After `buildContextPacket` and before `buildContextPrompt`:

1. resolve eligibility;
2. if ineligible, do not create the read store;
3. if eligible, create the service client and read store, then call `load(userId)` once;
4. treat `null` as unavailable and preserve legacy;
5. pass a valid loaded object, including empty items, as `lifecycleCrossMemory`;
6. set `memoryItemIds = []` only when a context object was loaded;
7. catch all read/projection/format failures, log one closed code, and build the legacy prompt;
8. never repeat the read.

Keep `packetForSummary` unchanged so background legacy summary behavior does not consume lifecycle context.

- [ ] **Step 4: Run GREEN and full Memory V3 TypeScript suite**

```powershell
npx.cmd tsx supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts
```

Then run every `memoryV3/*.cases.test.ts` file. Expected: all pass.

- [ ] **Step 5: Run app gates**

```powershell
npm run typecheck
npm run lint
npm run build
```

If an existing unrelated lint issue appears, capture exact output and do not hide it by changing unrelated files.

- [ ] **Step 6: Verify and stop**

Run syntax, whitespace, frozen hashes, privacy grep, and status. Confirm `.env`, network, Supabase, provider, and paid calls are zero. Stop for review with nothing staged.

---

### Task 7: Documentation and Complete Offline Gate

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts`

**Interfaces:**
- Consumes: completed inactive read-canary implementation.
- Produces: an exact operational boundary and reproducible offline verification record.

- [ ] **Step 1: Write a failing documentation-contract test**

Require one scoped `Memory V3 lifecycle read canary` section that states:

- off by default;
- exact one-account gate;
- replaces only legacy cross-conversation prompt memory;
- preserves conversation summaries and technical fallback;
- authoritative empty suppresses legacy resurrection;
- current items are event/active, recurrence/active, hypothesis/supported only;
- one service-only RPC, zero lifecycle provider calls, zero writes, zero retries;
- no UI or HTTP exposure;
- migration 036 and activation require separate authorization;
- son's and other accounts remain unchanged.

- [ ] **Step 2: Run RED**

Run the documentation test and confirm the first missing statement fails.

- [ ] **Step 3: Update README**

Document only verified code behavior. Do not claim deployment, environment configuration, real-user validation, cost savings, or production quality.

- [ ] **Step 4: Run all offline gates**

```powershell
node --test scripts/memory-v3-pilot/*.test.mjs
$files=Get-ChildItem -LiteralPath 'supabase/functions/_shared/memoryV3' -Filter '*.cases.test.ts' | Sort-Object Name
foreach($file in $files){ npx.cmd tsx $file.FullName; if($LASTEXITCODE -ne 0){ exit 1 } }
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: all test suites and build gates pass; no network or provider call occurs.

- [ ] **Step 5: Run privacy and scope checks**

Confirm changed runtime files contain no real key, JWT, email, real account UUID, raw dialogue, Supabase URL, OpenRouter URL, `process.env`, filesystem write, retry loop, provider adapter, or automatic execution. Confirm migration 036 is unapplied and all frozen hashes match.

- [ ] **Step 6: Stop for final review**

Report exact tests, suites, pass/fail totals, changed paths, SHA-256 values, and `git status --short`. Do not stage, commit, push, deploy, apply migration 036, change secrets, or activate the canary.

---

### Task 8: Final Integration STOP

**Files:**
- Create: none
- Modify: none

**Interfaces:**
- Consumes: reviewed offline implementation and verification evidence.
- Produces: an explicit decision point before any external state change.

- [ ] **Step 1: Confirm the implementation remains inactive**

Verify no deployed migration 036, no Edge Function deploy, no read-mode secret, no canary activation, no provider call, and no paid run occurred.

- [ ] **Step 2: Present the focused git payload**

List only the spec, plan, new read modules/tests, migration 036, `context.ts`, `staysee-chat/index.ts`, and README. Explicitly list protected `.temp` and `_tmp-*.json` paths as excluded.

- [ ] **Step 3: STOP**

Wait for explicit authorization before staging or committing. Deployment and activation remain later, separate approvals even after a commit is created.
