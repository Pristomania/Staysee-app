# Memory V3 Historical Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, review-first historical Memory V3 backfill that can inspect a complete account history, construct a draft state outside production, and atomically import only an explicitly reviewed initial state.

**Architecture:** A frozen profile and pure chunk planner prepare single-conversation history chunks. A read-only source adapter builds a provider-free manifest; a sequential offline engine applies the existing extractor, reconciler, contracts, and reducer to an in-memory state; a separate service-role importer revalidates the source digest and invokes one initial-import-only SQL transaction.

**Tech Stack:** TypeScript, Node.js `node:test` through `tsx`, Supabase JavaScript client, PostgreSQL/PLpgSQL, existing Memory V3 prompt/transport/contract/reducer modules, PowerShell verification commands.

**Spec:** `docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md`

## Global Constraints

- Work only in the existing linked worktree `D:/Staisy-main Приложение/Staysee-memory-v3` on branch `codex/memory-v3-history-backfill`.
- Preserve the pre-existing modified files `supabase/.temp/cli-latest` and `supabase/functions/_shared/narrativeEngine.cases.test.ts`; never stage or edit them.
- Preserve every untracked `scripts/memory-v3-pilot/_tmp-*.json` artifact; never stage, edit, rename, delete, or parse it.
- Preserve exact lifecycle limits except for one reviewed operational correction:
  historical backfill accepts up to 40,000 extractor request bytes while the
  normal live lifecycle path remains capped at 20,000. Preserve 60 messages per
  chunk, 80,000 reconciler request bytes, 100 state items, 500 total state
  evidence rows, two model calls per chunk, and `maxActive = 1`.
- Preserve exact provider privacy fields: `require_parameters: true`, `data_collection: "deny"`, and `zdr: true`.
- Preserve model `google/gemini-3.7-flash`, schema `memory-v3-lifecycle-state-v1`, pipeline `memory-v3-lifecycle-shadow-v1`, and reconciler `memory-v3-lifecycle-reconciler-v1`.
- The implementation must not read real dialogue, call a remote Supabase project, read `.env`, call a provider, spend money, deploy, import, or activate the canary during Tasks 1-9. Task 7 may use only a disposable local Supabase stack; if its CLI/runtime is unavailable, stop instead of downloading dependencies or using production.
- Tests use invented dialogue and generated synthetic UUIDs only. Repository fixtures contain no real user text, user identifier, email, key, token, or provider body.
- There is no application-layer retry, repair, fallback, parallel execution, partial import, automatic paid execution, or automatic canary activation.
- Raw source messages, prompts, raw provider responses, credentials, and thrown causes never enter public results, saved artifacts, stdout, stderr, or git.
- Pricing is supplied only by a separately reviewed snapshot less than 24 hours old. No historical price in code or this plan is treated as current.
- Every task ends with a fresh targeted test, relevant regression tests, `git diff --check`, exact path review, and STOP.
- Do not stage or commit at a task checkpoint. After separate explicit approval, stage only that task's files and use the listed `[agent]` commit subject.
- Re-run the frozen-hash command from Task 1 after every task. Any unexpected frozen-file drift is a blocker.

## File Map

### Create

- `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts` — characterization hashes and isolation locks.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts` — frozen profile, price snapshot validation, exact budget arithmetic.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts` — profile, price, budget, and hostile-input tests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts` — source snapshot validation, deterministic chunk planner, manifest and artifact contracts.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts` — message ordering, byte limits, digests, projections, and artifact tests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-source.ts` — paged read-only source interface and Supabase adapter.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts` — pagination, cutoff, ownership, and zero-provider tests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts` — dry-run and sequential paid draft engine.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts` — fake-adapter lifecycle scenarios and failure isolation.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-cli.ts` — argv/env-independent inspect/execute orchestration.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts` — flags, credentials, digest, budget, and side-effect ordering tests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-run.ts` — filesystem/env composition root and no-clobber safe output.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts` — target/tmp ownership, stdout/stderr, and direct-invocation locks.
- `supabase/migrations/20260920120000_037_memory_v3_lifecycle_backfill_import.sql` — service-only import audit table and atomic initial import RPC.
- `supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts` — static migration security and transaction-source contract.
- `supabase/tests/database/037_memory_v3_lifecycle_backfill_import.test.sql` — local PostgreSQL behavioral transaction tests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts` — artifact/review/source revalidation and RPC input builder.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts` — import preflight and no-provider tests.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.ts` — import-only safe composition root.
- `scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts` — file/env/RPC side-effect ordering tests.

### Modify

- `scripts/memory-v3-pilot/README.md` — operator workflow, five gates, commands, privacy, rollback.
- `scripts/memory-v3-pilot/memory-v3-dataset-v2.test.mjs` — documentation contract for the history-backfill section.

### Frozen

- `supabase/functions/_shared/memoryV3/lifecycleContract.ts`
- `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`
- `supabase/functions/_shared/memoryV3/lifecycleReducer.ts`
- `supabase/functions/_shared/memoryV3/transport.ts`
- `supabase/functions/_shared/memoryV3/lifecycleTransport.ts`
- `supabase/functions/_shared/memoryV3/messages.ts`
- `supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql`
- `supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql`
- `docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md`
- Golden V1/V2 datasets and all `_tmp-*.json` files.

## Pre-Implementation Documentation Checkpoint

Before Task 1, review the spec and this plan as documentation-only changes. No implementation file may exist yet. After separate explicit approval, create two documentation commits so their hashes remain independently reviewable:

```powershell
git add -- docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md
git commit -m "[agent] design: specify Memory V3 historical backfill"
git add -- docs/superpowers/plans/2026-09-20-memory-v3-historical-backfill.md
git commit -m "[agent] plan: implement Memory V3 historical backfill"
```

An ordinary push is a separate explicit action. The protected modified files and `_tmp` artifacts remain outside both commits.

---

### Task 1: Freeze the Existing Lifecycle Baseline

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts`

**Interfaces:**

- Consumes: current repository bytes and exported lifecycle constants.
- Produces: a source-lock test that later tasks run unchanged.

- [ ] **Step 1: Verify precheck and protected paths**

Run:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --name-status
```

Expected:

- branch `codex/memory-v3-history-backfill`;
- HEAD contains the two approved documentation commits directly above base `657d42a5a412f1d53551f470fa02c7ba1a32f89f`; record the exact current SHA rather than hard-coding the not-yet-created plan-commit SHA;
- the spec and plan are tracked and clean; only the pre-existing protected paths are dirty/untracked;
- index empty.

- [ ] **Step 2: Run the existing baselines**

Run:

```powershell
node --test scripts/memory-v3-pilot/*.test.mjs
$memoryTests = rg --files supabase/functions/_shared/memoryV3 | Where-Object { $_ -like '*.cases.test.ts' }
npx.cmd tsx --test $memoryTests
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-model-benchmark-profile.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-dataset.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-cli.test.ts scripts/memory-v3-pilot/lifecycle-model-benchmark-run.test.ts
```

Expected: every command exits `0`. The last verified reference was 769/769 MJS and 368/368 Memory V3 TypeScript; report fresh totals rather than silently accepting a different baseline.

- [ ] **Step 3: Write the characterization test**

The test must hash the exact frozen list and assert this map:

```ts
const EXPECTED_SHA256 = Object.freeze({
  'supabase/functions/_shared/memoryV3/lifecycleContract.ts': 'ECE40C7EAE6DD806D84EA223DB7FB850452C241040CAFC235809B70BCF6779B2',
  'supabase/functions/_shared/memoryV3/lifecyclePrompt.ts': '80247FD956861A5D8440E6217962DAFF15B9593A7A9E237BD56E9F7869EFE841',
  'supabase/functions/_shared/memoryV3/lifecycleReducer.ts': '071C9914B374ECC0461B6C49E0D85C00C8141AB3C7AE24AE960EDBADD6A6461A',
  'supabase/functions/_shared/memoryV3/transport.ts': '8FA07F500CE2E20A736549CF05B4BC1B274C8F1AC477B24C8EE6389069FAC567',
  'supabase/functions/_shared/memoryV3/lifecycleTransport.ts': 'B298AE34C15CD6FBE83138CA353D28ABCD56FA220D918FDD15A824A4BD70F126',
  'supabase/functions/_shared/memoryV3/messages.ts': '46A3189C840082F52A8FEEC662F35D4FFE571B39D6FE8E5292C872FC0A01FF73',
  'supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql': '1BC7454D2140156ACEA1DE0F8FC89959D0590A26BC3E73BBDDC3774E5FE5AB21',
  'supabase/migrations/20260920010000_036_memory_v3_lifecycle_read_canary.sql': 'A81C4C01C5059E3F259F5D141825404B4F00623D980EEA67B9751B20EB070099',
  'docs/superpowers/specs/2026-09-20-memory-v3-historical-backfill-design.md': '3B5B49DADFE56385E6CBDFB171C5666F3C51EBCB4E160EC8EEE1B8A7D0C283EA',
});
```

It also imports lifecycle constants and asserts:

```ts
assert.equal(MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES, 60);
assert.equal(MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES, 20_000);
assert.equal(MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES, 80_000);
assert.equal(MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL, 32_768);
assert.equal(MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL, 1_200);
assert.equal(MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS, 100);
assert.equal(MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE, 500);
assert.equal(MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN, 2);
```

The test reads source only. It must not import `.env`, network libraries, wrappers, or artifacts.

- [ ] **Step 4: Run the new characterization test**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
```

Expected: PASS. A hash mismatch is a blocker, not a reason to update the expected map.

- [ ] **Step 5: Verify task scope and STOP**

Run:

```powershell
git diff --check
git status --short
git diff --cached --name-status
```

Expected: one new Task 1 test plus the protected pre-existing paths; index empty. Report hashes and fresh test totals, then STOP.

After separate approval, stage only the Task 1 test and commit:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
git commit -m "[agent] test: lock Memory V3 history backfill baseline"
```

---

### Task 2: Add the Frozen Profile and Exact Budget Contract

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts`

**Interfaces:**

- Consumes: lifecycle constants from `lifecycleContract.ts`.
- Produces:

```ts
export const LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID = 'memory-v3-lifecycle-history-backfill-v1' as const;

export interface LifecycleHistoryBackfillProfile {
  profileId: typeof LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID;
  schemaVersion: 'memory-v3-lifecycle-state-v1';
  pipelineVersion: 'memory-v3-lifecycle-shadow-v1';
  extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2';
  reconcilerVersion: 'memory-v3-lifecycle-reconciler-v1';
  model: 'google/gemini-3.7-flash';
  maxMessagesPerChunk: 60;
  maxExtractorRequestBytes: 40_000;
  maxReconcilerRequestBytes: 80_000;
  reservedInputTokensPerCall: 32_768;
  maxOutputTokensPerCall: 1_200;
  maxStateItems: 100;
  maxStateEvidence: 500;
  maxCallsPerChunk: 2;
  maxActive: 1;
  executeFlag: '--execute-history-backfill-paid-requests';
}

export interface LifecycleHistoryPriceSnapshot {
  model: 'google/gemini-3.7-flash';
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  observedAt: string;
  sourceUrl: string;
}

export function getLifecycleHistoryBackfillProfile(profileId: unknown): LifecycleHistoryBackfillProfile;
export function validateLifecycleHistoryPriceSnapshot(value: unknown, nowMs: number): LifecycleHistoryPriceSnapshot;
export function calculateLifecycleHistoryBudget(input: {
  chunkCount: number;
  priceSnapshot: LifecycleHistoryPriceSnapshot;
  maxBudgetUsd: string;
}): {
  maxRequests: number;
  ceilingNanodollars: bigint;
  ceilingUsd: string;
  hardMaxNanodollars: bigint;
  gate: 'PASS';
};
```

- [ ] **Step 1: Write profile and budget RED tests**

Cover these exact groups:

```ts
describe('history backfill profile', () => {
  it('returns the registry-owned deeply frozen profile');
  it('copies every lifecycle limit exactly');
  it('rejects unknown strings, objects, boxed strings, symbols, arrays, and null');
  it('does not execute a getter container');
});

describe('fresh price snapshot', () => {
  it('accepts exact JSON data with matching model and HTTPS source URL');
  it('rejects a snapshot older than 24 hours or dated in the future');
  it('rejects number prices, negative prices, exponent notation, extra fields, getters, cycles, symbols, and proxies');
});

describe('exact budget arithmetic', () => {
  it('uses two requests per chunk and integer nanodollars');
  it('rejects zero, negative, fractional, or unsafe chunk counts');
  it('rejects a hard maximum below the ceiling');
  it('does not reconstruct actual billing');
});
```

Use decimal-string helpers in the test so expected ceiling values are exact integers, not floating-point comparisons.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lifecycle-history-backfill-profile.ts` while the test file itself parses.

- [ ] **Step 3: Implement the frozen profile and exact arithmetic**

Implementation rules:

1. Import the existing lifecycle constants rather than restating mutable values.
2. Deep-freeze the profile and return the same object identity on each lookup.
3. Validate JSON-data-only records through own enumerable data descriptors. Never access untrusted fields directly.
4. Accept decimal prices and maximum budget only as canonical nonnegative strings matching `^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$`.
5. Convert dollars to nanodollars with `BigInt`, padding the fractional part to nine digits.
6. Convert USD-per-million prices to a rational token cost and round the worst-case ceiling upward, never downward.
7. Reject snapshots where `nowMs - observedAt` is negative or exceeds exactly 86,400,000 milliseconds.
8. Return only a `PASS` budget; failures throw a branded fixed-message error without `cause`.

The price validator must first project this exact field list:

```ts
const PRICE_FIELDS = [
  'model',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'observedAt',
  'sourceUrl',
] as const;
```

- [ ] **Step 4: Run GREEN and regressions**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
node --test scripts/memory-v3-pilot/benchmark-budget.test.mjs
```

Expected: all PASS.

- [ ] **Step 5: Verify task scope and STOP**

Run the Task 1 frozen-hash command, `git diff --check`, `git status --short`, and `git diff --cached --name-status`. Expected: only the two Task 2 files plus protected paths, index empty.

After separate approval, commit only the Task 2 files:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-profile.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
git commit -m "[agent] feat: add Memory V3 history backfill profile"
```

---

### Task 3: Validate Source Snapshots and Plan Deterministic Chunks

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts`

**Interfaces:**

- Consumes: `getLifecycleHistoryBackfillProfile`, `buildMemoryV3ExtractorRequest`, `validateMemoryV3Dialogue`, `MemoryV3DialogueMessage`.
- Produces:

```ts
export interface LifecycleHistoryConversationInput {
  conversationId: string;
  createdAt: string;
  messages: MemoryV3DialogueMessage[];
}

export interface LifecycleHistorySourceSnapshotInput {
  userId: string;
  sourceCutoff: string;
  conversations: LifecycleHistoryConversationInput[];
}

export interface LifecycleHistoryPreparedChunk {
  chunkId: string;
  conversationOrdinal: number;
  chunkOrdinal: number;
  conversationId: string;
  messages: MemoryV3DialogueMessage[];
  firstCreatedAt: string;
  lastCreatedAt: string;
  firstMessageId: string;
  lastMessageId: string;
  messageCount: number;
  userMessageCount: number;
  extractorRequestBytes: number;
  extractorRequestSha256: string;
  sourceDigest: string;
}

export interface LifecycleHistoryBackfillManifest {
  schemaVersion: 'memory-v3-lifecycle-history-manifest-v1';
  profileId: 'memory-v3-lifecycle-history-backfill-v1';
  sourceCutoff: string;
  sourceSnapshotDigest: string;
  conversationCount: number;
  messageCount: number;
  userMessageCount: number;
  chunkCount: number;
  maxProviderCalls: number;
  conversations: Array<{
    conversationOrdinal: number;
    messageCount: number;
    userMessageCount: number;
    firstCreatedAt: string;
    lastCreatedAt: string;
    chunkCount: number;
  }>;
  chunks: Array<{
    chunkId: string;
    conversationOrdinal: number;
    chunkOrdinal: number;
    messageCount: number;
    userMessageCount: number;
    firstCreatedAt: string;
    lastCreatedAt: string;
    extractorRequestBytes: number;
    extractorRequestSha256: string;
    sourceDigest: string;
  }>;
}

export interface PreparedLifecycleHistoryBackfill {
  userId: string;
  manifest: LifecycleHistoryBackfillManifest;
  chunks: LifecycleHistoryPreparedChunk[];
}

export function prepareLifecycleHistoryBackfill(input: {
  profileId: unknown;
  snapshot: unknown;
}): PreparedLifecycleHistoryBackfill;

export function canonicalLifecycleHistoryDigest(value: unknown): string;
```

- [ ] **Step 1: Write chunk-planner RED tests**

Create synthetic factories instead of fixed real-looking identifiers:

```ts
function syntheticUuid(index: number): string {
  const tail = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}
```

Test exact behavior:

- source objects are not mutated;
- conversations sort by earliest message time then conversation ID;
- messages sort by `createdAt`, then ID using relational UTF-16 order;
- 61 short messages become two contiguous chunks;
- a real-shaped indivisible historical message above the 20,000-byte live cap
  is preserved without truncation;
- the largest prefix at or below 40,000 bytes is selected;
- a request of exactly 40,000 bytes passes and 40,001 fails or splits;
- every chunk contains a user message;
- an oversized single message and an assistant-only unusable prefix fail closed;
- no message is duplicated, omitted, truncated, or moved between conversations;
- global chunk order uses last timestamp, last ID, conversation ordinal, chunk ordinal;
- changing role, text, ID, time, or conversation changes the source digest;
- `extractorRequestSha256` equals SHA-256 of the exact UTF-8 `JSON.stringify(buildMemoryV3ExtractorRequest(dialogue))` bytes and changes when that request changes;
- manifest contains no `conversationId`, message ID, message text, or user ID;
- prepared chunks contain trusted IDs only in memory;
- getter, setter, symbol, non-enumerable, sparse, cyclic, proxy, and revoked-proxy inputs fail without sentinel leakage.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for the production contract module.

- [ ] **Step 3: Implement validation and chunk planning**

Use this exact high-level algorithm:

```ts
export function prepareLifecycleHistoryBackfill(input: {
  profileId: unknown;
  snapshot: unknown;
}): PreparedLifecycleHistoryBackfill {
  const profile = getLifecycleHistoryBackfillProfile(readOwnProfileId(input));
  const source = validateAndCloneSourceSnapshot(readOwnSnapshot(input));
  const conversations = canonicalizeConversations(source);
  const chunks = conversations.flatMap((conversation, conversationOrdinal) =>
    chunkOneConversation({ profile, source, conversation, conversationOrdinal }),
  );
  chunks.sort(comparePreparedChunks);
  const manifest = projectManifest(profile, source, conversations, chunks);
  return deepFreeze({ userId: source.userId, manifest, chunks });
}
```

`chunkOneConversation` must evaluate candidate prefixes through the real request builder:

```ts
const dialogue = validateMemoryV3Dialogue({
  caseId: `memory-v3-shadow:${source.userId}:${conversation.conversationId}`,
  messages: candidateMessages,
});
const request = buildMemoryV3ExtractorRequest(dialogue);
const serializedRequest = JSON.stringify(request);
const bytes = new TextEncoder().encode(serializedRequest).byteLength;
const extractorRequestSha256 = createHash('sha256')
  .update(serializedRequest, 'utf8')
  .digest('hex');
```

Do not include `conversationId`, source message IDs, text, or `userId` in `projectManifest`. Compute `chunkId` as SHA-256 over the UTF-8 bytes of `canonicalStringify([profileId, sourceDigest, conversationOrdinal, chunkOrdinal])`; never hash ambiguous string concatenation. The resulting digest is safe to expose.

The extractor `caseId` deliberately reuses the frozen production dialogue format. Chunk identity remains the manifest `chunkId` plus the exact request digest; do not invent a `memory-v3-history:*` case ID because the frozen production contract rejects it.

- [ ] **Step 4: Run GREEN and contract regressions**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
npx.cmd tsx --test supabase/functions/_shared/memoryV3/contract.cases.test.ts supabase/functions/_shared/memoryV3/prompt.cases.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Verify task scope and STOP**

Run frozen hashes, `git diff --check`, source privacy scan, status, and index review. The production module must not import fs, env, Supabase, HTTP, or provider adapters.

After separate approval:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts
git commit -m "[agent] feat: add deterministic Memory V3 history chunking"
```

---

### Task 4: Add Provider-Free Source Inspection

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-source.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts`

**Interfaces:**

- Consumes: `prepareLifecycleHistoryBackfill`.
- Produces:

```ts
export interface LifecycleHistoryPageCursor {
  createdAt: string;
  id: string;
}

export interface LifecycleHistorySourceReader {
  listConversationsPage(input: {
    userId: string;
    sourceCutoff: string;
    after: LifecycleHistoryPageCursor | null;
    limit: 100;
  }): Promise<unknown>;
  listMessagesPage(input: {
    userId: string;
    conversationId: string;
    sourceCutoff: string;
    after: LifecycleHistoryPageCursor | null;
    limit: 100;
  }): Promise<unknown>;
}

export interface LifecycleHistorySupabaseClient {
  from(table: string): unknown;
}

export function createLifecycleHistorySupabaseReader(client: unknown): LifecycleHistorySourceReader;
export async function inspectLifecycleHistorySource(input: {
  profileId: unknown;
  userId: unknown;
  sourceCutoff: unknown;
  reader: unknown;
}): Promise<PreparedLifecycleHistoryBackfill>;
```

- [ ] **Step 1: Write source-inspection RED tests**

Test:

- pages of exactly 100 continue with `(createdAt, id)` keysets;
- the final short page stops;
- rows at the cutoff are included and newer rows are rejected;
- all conversations belong to the exact target user;
- all messages belong to the requested conversation;
- duplicate conversation/message IDs fail before preparation;
- page order from the fake client does not change the final digest;
- missing, repeated, or nonadvancing cursors fail rather than loop;
- malformed Supabase response, query error, getter, proxy, and raw error sentinel become a fixed source diagnostic;
- adapter calls occur sequentially;
- zero extractor/reconciler/provider/fetch calls occur;
- public manifest contains only the fields declared in Task 3.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts
```

Expected: missing production source module.

- [ ] **Step 3: Implement the reader and inspection loop**

The inspection loop is exact:

```ts
const conversations = await collectConversationPages(reader, userId, sourceCutoff);
const withMessages: LifecycleHistoryConversationInput[] = [];
for (const conversation of conversations) {
  const messages = await collectMessagePages(
    reader,
    userId,
    conversation.conversationId,
    sourceCutoff,
  );
  withMessages.push({
    conversationId: conversation.conversationId,
    createdAt: conversation.createdAt,
    messages,
  });
}
return prepareLifecycleHistoryBackfill({
  profileId,
  snapshot: { userId, sourceCutoff, conversations: withMessages },
});
```

The Supabase adapter selects only required fields, applies user/conversation ownership filters, applies `created_at <= sourceCutoff`, orders `created_at` then `id` ascending, and uses a composite keyset condition after the cursor. It never logs the query, rows, IDs, or errors.

- [ ] **Step 4: Run GREEN and zero-side-effect regressions**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
```

Expected: all PASS, with fake counters proving provider calls `0`.

- [ ] **Step 5: Verify task scope and STOP**

Run frozen hashes, `git diff --check`, source import scan, status, and index review. The source module may depend on the Supabase-shaped injected client but not `process.env`, `.env`, fs, global fetch, or provider modules.

After separate approval:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-source.ts scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts
git commit -m "[agent] feat: add read-only Memory V3 history inspection"
```

---

### Task 5: Build the Sequential Offline Draft Engine

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts`

**Interfaces:**

- Consumes: prepared chunks, profile/budget, existing extractor/reconciler transports, contracts, prompts, and reducer.
- Produces:

```ts
export type LifecycleHistoryBackfillStage =
  | 'extractor_transport'
  | 'extractor_parse'
  | 'extractor_contract'
  | 'reconciler_request'
  | 'reconciler_transport'
  | 'reconciler_parse'
  | 'reconciler_contract'
  | 'reducer';

export interface LifecycleHistoryBackfillResult {
  schemaVersion: 'memory-v3-lifecycle-history-result-v1';
  profileId: 'memory-v3-lifecycle-history-backfill-v1';
  model: 'google/gemini-3.7-flash';
  manifest: LifecycleHistoryBackfillManifest;
  priceSnapshot: LifecycleHistoryPriceSnapshot;
  budget: {
    maxRequests: number;
    reservedInputTokensPerCall: 32_768;
    maxOutputTokensPerCall: 1_200;
    ceilingUsd: string;
    hardMaxUsd: string;
    gate: 'PASS';
  };
  execute: boolean;
  attemptedChunkCount: number;
  successChunkCount: number;
  failureCount: number;
  providerCallCount: number;
  maxActive: 1;
  retryCount: 0;
  repairCount: 0;
  fallbackCount: 0;
  finalState: MemoryV3LifecycleState | null;
  chunks: Array<{
    chunkId: string;
    status: 'succeeded';
    changed: boolean;
    resultingStateRevision: number;
    itemCount: number;
    evidenceCount: number;
    transitionTypes: string[];
  }>;
  failures: Array<{
    chunkId: string;
    stage: LifecycleHistoryBackfillStage;
    diagnosticCode: string;
  }>;
  actualUsage: { promptTokens: number; completionTokens: number } | null;
  actualCostUsd: number | null;
  semanticReview: { status: 'required' };
}

export async function runLifecycleHistoryBackfill(input: {
  profileId: unknown;
  prepared: unknown;
  priceSnapshot: unknown;
  maxBudgetUsd: unknown;
  nowMs: number;
  execute: unknown;
  extractorAdapter?: MemoryV3ModelAdapter;
  reconcilerAdapter?: MemoryV3LifecycleModelAdapter;
}): Promise<LifecycleHistoryBackfillResult>;

export function buildLifecycleHistoryReviewPacket(result: unknown): {
  schemaVersion: 'memory-v3-lifecycle-history-review-packet-v1';
  payloadSha256: string;
  items: Array<{
    memoryKey: string;
    kind: string;
    claim: string;
    status: string;
    sensitivity: string;
    alternative: string | null;
    evidence: Array<{
      sourceMessageId: string;
      relation: string;
      supportType: string | null;
      episodeKey: string | null;
      mentionTime: string;
    }>;
    semanticVerdict: null;
    reviewerNotes: null;
  }>;
};
```

The saved artifact is exactly `{ benchmarkResult, semanticReviewPacket }`. Compute `semanticReviewPacket.payloadSha256` over `canonicalStringify({ benchmarkResult, items: semanticReviewPacket.items })`, where the temporary hash input omits only the `payloadSha256` field itself. The initial packet keeps every `semanticVerdict` and `reviewerNotes` value at `null`; the separate review-decision file never mutates the artifact. Task 8 recomputes the same projection byte-for-byte before accepting a decision.

- [ ] **Step 1: Write engine RED tests with fake adapters**

Cover:

- dry run validates manifest and budget with zero adapters and returns no state;
- dry run and execute results preserve the exact validated price snapshot and budget projection without calling either adapter during preflight;
- execute requires both adapters only after source/budget preflight succeeds;
- each successful chunk calls extractor then reconciler exactly once;
- chunks run in manifest order with `maxActive = 1`;
- state begins empty and flows from one chunk to the next;
- event correction, cross-conversation recurrence, hypothesis rejection, assistant denial, injection, and no-worthy-memory scenarios reach exact authored final state;
- exact request byte caps are rechecked before calls;
- provider privacy fields remain exact in both request transports, including the frozen transport-level `allow_fallbacks: true`; there is still no application-layer retry, repair, or fallback;
- failure in a middle chunk stops subsequent chunks and sets `finalState` to `null`;
- no importable partial result is returned;
- request `2N + 1` is blocked before adapter invocation;
- inner rejection counts one call;
- actual usage/cost is present only when all successful responses provide validated usage;
- result and review packet exclude raw dialogue, prompts, raw provider content, API key sentinels, and error sentinels;
- spoofed diagnostics, getters, proxies, cycles, symbols, and revoked values fail safely.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts
```

Expected: missing engine module.

- [ ] **Step 3: Implement dry-run preflight**

Validation order is locked:

1. JSON-data-only options;
2. own enumerable `profileId` data descriptor;
3. trusted profile lookup;
4. prepared manifest/chunk consistency and source digest;
5. fresh price snapshot;
6. exact budget arithmetic;
7. extractor byte recheck for every chunk;
8. provider-call cap calculation;
9. return dry-run result when `execute === false`;
10. validate adapters only when `execute === true`.

Malformed credentials/adapters cannot mask an earlier source or budget failure.

- [ ] **Step 4: Implement the paid in-memory loop**

Use the current production functions in this order for every chunk:

```ts
let state = createEmptyMemoryV3LifecycleState({ userId: prepared.userId });
for (const chunk of prepared.chunks) {
  const dialogue = validateMemoryV3Dialogue({
    caseId: `memory-v3-shadow:${prepared.userId}:${chunk.conversationId}`,
    messages: chunk.messages,
  });
  const extractorRequest = buildMemoryV3ExtractorRequest(dialogue);
  assertUtf8BytesAtMost(extractorRequest, profile.maxExtractorRequestBytes);
  assertExtractorRequestDigest(extractorRequest, chunk.extractorRequestSha256);
  const extractorTransport = await callExtractorOnce(extractorAdapter, extractorRequest);
  const parsedExtraction = parseJsonDataOnly(extractorTransport.content);
  const extraction = await normalizeMemoryV3LayeredResponse(
    parsedExtraction,
    dialogue,
    profile.extractorVersion,
  );
  const reconcileBundle = buildMemoryV3LifecycleReconcileRequest({
    userId: prepared.userId,
    conversationId: chunk.conversationId,
    messages: chunk.messages,
    state,
    extraction,
  });
  assertUtf8BytesAtMost(reconcileBundle.request, profile.maxReconcilerRequestBytes);
  const reconcilerTransport = await callReconcilerOnce(reconcilerAdapter, reconcileBundle.request);
  const proposal = validateMemoryV3LifecycleProposal(
    parseJsonDataOnly(reconcilerTransport.rawContent),
    {
      state,
      extraction,
      bindings: reconcileBundle.bindings,
    },
  );
  const reduced = await applyMemoryV3LifecycleStep({
    state,
    at: chunk.lastCreatedAt,
    conversationId: chunk.conversationId,
    extraction,
    proposal,
    trustedForgetMemoryKeys: [],
  });
  state = validateMemoryV3LifecycleState(
    {
      ...reduced.state,
      stateRevision: state.stateRevision + (reduced.changed ? 1 : 0),
    },
    prepared.userId,
  );
}
```

Implement `callExtractorOnce` and `callReconcilerOnce` as private one-call helpers in this module. Each helper checks the shared `2 * prepared.chunks.length` cap before incrementing, increments the attempt counter before invoking its adapter, invokes that adapter exactly once, and validates the returned own enumerable data fields (`content`/`rawContent` plus nullable usage) without getters, symbols, cycles, sparse arrays, or attacker-controlled error text. A rejected inner adapter call still consumes one attempt; a blocked call consumes none.

Define `parseJsonDataOnly(raw)` in this module as a fixed-diagnostic boundary: require a primitive string, call `JSON.parse` once, then recursively clone only plain objects and dense arrays through own enumerable data descriptors, rejecting accessors, symbols, non-enumerable fields, cycles, proxies, and revoked proxies without copying raw exception text. Define `assertUtf8BytesAtMost(request, limit)` to serialize once with `JSON.stringify`, count `new TextEncoder().encode(serialized).byteLength`, and throw the fixed stage diagnostic when the count exceeds `limit`; for extractor requests, require equality with the prepared byte count as well. Define `assertExtractorRequestDigest(request, expected)` to hash the UTF-8 `JSON.stringify(request)` bytes with `createHash('sha256')` and throw the fixed `extractor_contract` diagnostic unless the lowercase hex digest equals `expected`; call it before the first provider call for that chunk. After every reducer call, increment `stateRevision` by exactly one only when `reduced.changed` is true, then revalidate the whole state and caps. Wrap each boundary with fixed branded diagnostics. Never serialize `extraction`, `proposal`, dialogue, or transport body into the public result.

- [ ] **Step 5: Run GREEN and production lifecycle regressions**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts
npx.cmd tsx --test supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts supabase/functions/_shared/memoryV3/transport.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleTransport.cases.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Verify task scope and STOP**

Run frozen hashes, syntax, whitespace, privacy/import scan, status, and index review. Engine imports must be limited to profile/contract/source plus the approved production lifecycle modules; no fs, env, Supabase client, wrappers, app code, or global fetch.

After separate approval:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts
git commit -m "[agent] feat: add offline Memory V3 history backfill engine"
```

---

### Task 6: Add Safe Inspection and Paid-Run Composition

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-cli.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-run.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts`

**Interfaces:**

- Consumes: source inspection, engine, existing OpenRouter adapters/transports, Supabase client factory through injection.
- Produces:

```ts
export async function runLifecycleHistoryBackfillFromArgv(input: {
  argv: unknown;
  sourceReader: unknown;
  readEnvText: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
  nowMs: number;
}): Promise<{
  benchmarkResult: LifecycleHistoryBackfillResult;
  semanticReviewPacket: ReturnType<typeof buildLifecycleHistoryReviewPacket> | null;
}>;

export async function main(input: {
  argv: unknown;
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string>;
  accessImpl: (path: string) => Promise<void>;
  writeFileImpl: (path: string, data: string, options: { flag: 'wx' }) => Promise<void>;
  linkImpl: (existingPath: string, newPath: string) => Promise<void>;
  unlinkImpl: (path: string) => Promise<void>;
  createSourceReader: (url: string, serviceKey: string) => LifecycleHistorySourceReader;
  fetchImpl: typeof fetch;
  nowMs: number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}): Promise<number>;
```

- [ ] **Step 1: Write CLI RED tests**

Freeze these two commands:

```text
--inspect-source --profile memory-v3-lifecycle-history-backfill-v1 --source-cutoff 2026-09-20T00:00:00.000Z --price-snapshot-file C:\safe\price.json --max-budget-usd 1.000000000
```

```text
--execute-history-backfill-paid-requests --profile memory-v3-lifecycle-history-backfill-v1 --source-cutoff 2026-09-20T00:00:00.000Z --expected-source-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --price-snapshot-file C:\safe\price.json --max-budget-usd 1.000000000 --safe-output-file C:\safe\history-backfill.json
```

Tests prove:

- inspect and execute flags are mutually exclusive;
- execute requires expected source digest and safe output;
- user ID is read only from `STAYSEE_MEMORY_V3_BACKFILL_USER_ID`, never argv;
- Supabase URL/service key are required for both modes;
- API key is read only for execute and only after source/budget preflight;
- inspect makes zero provider calls and returns packet `null`;
- execute source digest mismatch makes zero provider calls;
- execute uses exact model/profile and explicit budget;
- unknown, duplicate, reordered value flags, relative paths, wrong extensions, getters, symbols, and sparse argv fail safely;
- no credential value, user ID, path, raw row, normalized claim, evidence ID, or raw error appears in stdout/stderr.

- [ ] **Step 2: Run CLI RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts
```

Expected: missing CLI module.

- [ ] **Step 3: Implement CLI orchestration**

Use exact mode ordering:

1. parse data-only argv;
2. load and validate price snapshot;
3. read Supabase URL, service key, and target user ID through injected `readEnvText`;
4. inspect source and calculate budget;
5. return provider-free result for inspect mode;
6. compare expected source digest for execute mode;
7. read API key;
8. build one extractor and one reconciler adapter over the injected fetch;
9. execute the engine;
10. build review packet only after complete success.

`.env` parsing uses exact names and never returns a full environment object.

- [ ] **Step 4: Write run-root RED tests**

Cover:

- safe-output target and target `.tmp` preflight before file/env/source/provider reads;
- existing target or temp means zero source/provider calls;
- missing fs dependency means zero source/provider calls;
- `writeFile` uses `{ flag: 'wx' }`;
- `link(tmp, target)` publishes without overwrite;
- only a temp successfully created by this process is unlinked;
- race-created target remains unchanged;
- successful execute saves the full sensitive artifact only to the explicit safe-output file, while stdout emits one separate safe JSON summary containing only status, profile ID, source digest, chunk/item/evidence counts, payload digest, and `outputWritten: true`;
- recomputing the canonical artifact projection yields exactly `semanticReviewPacket.payloadSha256` and changing any manifest, state, chunk, or review-item field changes the digest;
- stderr is one fixed safe JSON failure;
- dry inspect does not auto-save;
- direct invocation is the only place allowed to bind filesystem, process argv, env path, and `globalThis.fetch`.

- [ ] **Step 5: Run run-root RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts
```

Expected: missing run module.

- [ ] **Step 6: Implement the safe composition root**

Follow the existing ownership sequence:

```ts
await assertAbsent(accessImpl, outputFile);
await assertAbsent(accessImpl, `${outputFile}.tmp`);
const payload = await runLifecycleHistoryBackfillFromArgv(dependencies);
const text = `${JSON.stringify(payload)}\n`;
await writeFileImpl(`${outputFile}.tmp`, text, { flag: 'wx' });
tempCreated = true;
await linkImpl(`${outputFile}.tmp`, outputFile);
await unlinkImpl(`${outputFile}.tmp`);
tempCreated = false;
writeStdout(`${JSON.stringify(projectSafePublishSummary(payload))}\n`);
```

`projectSafePublishSummary` returns only the allowlisted scalar/count/digest fields named in Step 4 and never returns `finalState`, review items, claims, evidence, user/conversation/message IDs, paths, or credentials. On a publish failure, write no success stdout and unlink only when `tempCreated === true`. Never use rename, overwrite, a random temp name, retry, or automatic cleanup of a pre-existing temp.

- [ ] **Step 7: Run GREEN and all backfill tests**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
```

Expected: all PASS. Do not run either real command in Tasks 1-9.

- [ ] **Step 8: Verify task scope and STOP**

Run frozen hashes, syntax, whitespace, privacy scan, status, and index review. Confirm real `.env`, Supabase, provider, and paid calls are all zero.

After separate approval:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-cli.ts scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-run.ts scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts
git commit -m "[agent] feat: add safe Memory V3 history backfill runner"
```

---

### Task 7: Add the Atomic Initial-Import Migration

**Files:**

- Create: `supabase/migrations/20260920120000_037_memory_v3_lifecycle_backfill_import.sql`
- Create: `supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts`
- Create: `supabase/tests/database/037_memory_v3_lifecycle_backfill_import.test.sql`

**Interfaces:**

- Consumes: existing lifecycle head/items/evidence tables and exact state JSON.
- Produces:

```sql
CREATE TABLE public.memory_v3_lifecycle_backfill_imports (
  import_id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  artifact_digest text NOT NULL UNIQUE CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_cutoff timestamptz NOT NULL,
  profile_id text NOT NULL CHECK (profile_id = 'memory-v3-lifecycle-history-backfill-v1'),
  schema_version text NOT NULL CHECK (schema_version = 'memory-v3-lifecycle-state-v1'),
  pipeline_version text NOT NULL CHECK (pipeline_version = 'memory-v3-lifecycle-shadow-v1'),
  extractor_version text NOT NULL CHECK (extractor_version = 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2'),
  reconciler_version text NOT NULL CHECK (reconciler_version = 'memory-v3-lifecycle-reconciler-v1'),
  expected_state_revision bigint NOT NULL CHECK (expected_state_revision = 0),
  resulting_state_revision bigint NOT NULL CHECK (resulting_state_revision >= 1),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  evidence_count integer NOT NULL CHECK (evidence_count BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE OR REPLACE FUNCTION public.import_memory_v3_lifecycle_backfill_state(
  p_import_id uuid,
  p_user_id uuid,
  p_expected_state_revision bigint,
  p_artifact_digest text,
  p_source_snapshot_digest text,
  p_source_cutoff timestamptz,
  p_profile_id text,
  p_pipeline_version text,
  p_extractor_version text,
  p_reconciler_version text,
  p_state jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint);
```

- [ ] **Step 1: Write static migration RED tests**

The TypeScript source-contract test must fail because migration 037 is absent, then assert after implementation:

- exact table/function names and signatures;
- `SECURITY DEFINER SET search_path = ''`;
- RLS enabled and all public/anon/authenticated privileges revoked;
- exact service-role table and function grants;
- no dynamic SQL and no caller-controlled schema/table/function identifiers;
- head selected `FOR UPDATE`;
- current revision exactly `0` and current item count exactly `0`;
- state schema/user/revision/ordinal/item/evidence validations;
- evidence ownership joins messages to conversations and target user;
- evidence source is a user message at exactly `mentionTime` and not newer than `p_source_cutoff`;
- delete/insert/head update/audit insert are inside the function;
- no exception handler that swallows a middle failure;
- no provider, HTTP, cron, or canary-secret mutation.

- [ ] **Step 2: Run static RED**

Run:

```powershell
npx.cmd tsx --test supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts
```

Expected: FAIL because migration 037 does not exist.

- [ ] **Step 3: Write PostgreSQL behavioral tests**

The pgTAP file creates synthetic profile/conversation/message ownership rows inside its test transaction and covers:

```sql
SELECT plan(18);
SELECT lives_ok(valid_import_sql('valid'), 'valid initial import');
SELECT is((SELECT count(*) FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = test_user()), 1::bigint, 'one item imported');
SELECT throws_ok(valid_import_sql('duplicate-user'), NULL, NULL, 'duplicate user import rejected');
SELECT throws_ok(valid_import_sql('duplicate-digest'), NULL, NULL, 'duplicate digest rejected');
SELECT throws_ok(valid_import_sql('nonzero-head'), NULL, NULL, 'nonzero head rejected');
SELECT throws_ok(valid_import_sql('foreign-conversation'), NULL, NULL, 'foreign conversation rejected');
SELECT throws_ok(valid_import_sql('foreign-message'), NULL, NULL, 'foreign message rejected');
SELECT throws_ok(valid_import_sql('assistant-message'), NULL, NULL, 'assistant evidence rejected');
SELECT throws_ok(valid_import_sql('mention-time-mismatch'), NULL, NULL, 'evidence mention time mismatch rejected');
SELECT throws_ok(valid_import_sql('message-after-cutoff'), NULL, NULL, 'evidence newer than cutoff rejected');
SELECT throws_ok(valid_import_sql('invalid-status'), NULL, NULL, 'invalid status rejected');
SELECT throws_ok(valid_import_sql('item-cap'), NULL, NULL, 'item cap rejected');
SELECT throws_ok(valid_import_sql('evidence-cap'), NULL, NULL, 'evidence cap rejected');
SELECT throws_ok(valid_import_sql('forced-audit-failure'), NULL, NULL, 'forced final audit failure rolls back');
SELECT is((SELECT state_revision FROM public.memory_v3_lifecycle_shadow_heads WHERE user_id = rollback_user()), 0::bigint, 'forced failure leaves head unchanged');
SELECT is((SELECT count(*) FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = rollback_user()), 0::bigint, 'forced failure leaves no items');
SELECT is((SELECT count(*) FROM public.memory_v3_lifecycle_shadow_evidence WHERE user_id = rollback_user()), 0::bigint, 'forced failure leaves no evidence');
SELECT is((SELECT count(*) FROM public.memory_v3_lifecycle_backfill_imports WHERE user_id = rollback_user()), 0::bigint, 'forced failure leaves no audit row');
SELECT * FROM finish();
```

Define `valid_import_sql(case_name text)` and generated-ID helpers in the same test file. For the rollback case, install a test-only trigger on `memory_v3_lifecycle_backfill_imports` that raises for `rollback_user()` during the final audit insert, invoke an otherwise valid import, and assert that head revision, items, evidence, and audit remain unchanged. The trigger and fixtures live inside the test transaction, which rolls back.

- [ ] **Step 4: Implement migration 037**

Validation order inside the function:

1. fixed versions, digests, import ID, expected revision;
2. JSON object shape, exact state schema/user/revision/next ordinal;
3. item and total evidence caps;
4. item fields, statuses, dates, alternatives, revisions, unique memory keys;
5. evidence fields, relations, support/episode matrix, user provenance;
6. evidence message/conversation/user ownership, user role, exact mention time, and cutoff;
7. create the empty head with `INSERT ... ON CONFLICT DO NOTHING`, then select that exact user head `FOR UPDATE`;
8. reject prior user import, duplicate digest, nonzero head, or existing items;
9. insert items and evidence;
10. update head to artifact revision/next ordinal;
11. insert audit row;
12. return `succeeded` and resulting revision.

The function relies on PostgreSQL statement atomicity. It contains no exception block that commits partial work.

- [ ] **Step 5: Run static GREEN**

Run:

```powershell
npx.cmd tsx --test supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run local database tests**

Run in a disposable local Supabase stack, never production. First require an already-installed local CLI; do not let `npx` download it:

```powershell
if (-not (Test-Path '.\node_modules\.bin\supabase.cmd')) {
  throw 'local Supabase CLI is not installed; STOP without network installation'
}
.\node_modules\.bin\supabase.cmd start
.\node_modules\.bin\supabase.cmd db reset --local
.\node_modules\.bin\supabase.cmd test db
```

Expected: migration 037 applies and all 18 pgTAP assertions pass. If Docker/local Supabase is unavailable, stop the task as blocked; do not substitute the production project.

- [ ] **Step 7: Verify task scope and STOP**

Run frozen hashes, `git diff --check`, migration privacy/security scan, status, and index review. Confirm migration 034/036 unchanged and no remote Supabase command executed.

After separate approval:

```powershell
git add -- supabase/migrations/20260920120000_037_memory_v3_lifecycle_backfill_import.sql supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts supabase/tests/database/037_memory_v3_lifecycle_backfill_import.test.sql
git commit -m "[agent] feat: add atomic Memory V3 backfill import"
```

---

### Task 8: Add Reviewed Import Preflight and Import-Only Runner

**Files:**

- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.ts`
- Create: `scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts`

**Interfaces:**

- Consumes: saved artifact, separate review decision, fresh source inspection, one RPC dependency.
- Produces:

```ts
export interface LifecycleHistoryReviewDecision {
  schemaVersion: 'memory-v3-lifecycle-history-review-v1';
  payloadSha256: string;
  verdict: 'PASS';
  reviewedAt: string;
  reviewer: 'Nastya';
  items: Array<{
    memoryKey: string;
    semanticVerdict: 'PASS';
    reviewerNotes: string | null;
  }>;
}

export interface LifecycleHistoryImportClient {
  loadCurrentHead(userId: string): Promise<unknown>;
  importInitialState(input: {
    importId: string;
    userId: string;
    expectedStateRevision: 0;
    artifactDigest: string;
    sourceSnapshotDigest: string;
    sourceCutoff: string;
    profileId: string;
    pipelineVersion: string;
    extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2';
    reconcilerVersion: string;
    state: MemoryV3LifecycleState;
  }): Promise<unknown>;
}

export async function importReviewedLifecycleHistory(input: {
  artifact: unknown;
  reviewDecision: unknown;
  freshPreparedSource: unknown;
  userId: unknown;
  importId: unknown;
  client: unknown;
}): Promise<{
  status: 'succeeded';
  artifactDigest: string;
  sourceSnapshotDigest: string;
  resultingStateRevision: number;
  itemCount: number;
  evidenceCount: number;
}>;
```

- [ ] **Step 1: Write import-library RED tests**

Cover:

- accepts only a complete successful execute artifact with nonempty final state;
- recalculates canonical payload digest and matches review decision;
- requires verdict `PASS`, reviewer `Nastya`, and valid reviewed timestamp;
- requires exactly one own-data review row for every final-state `memoryKey`, in canonical key order, with no missing, duplicate, or extra row and `semanticVerdict: 'PASS'` for each item;
- allows only a bounded nullable reviewer note per item and keeps the reviewed artifact itself immutable;
- requires fresh source digest/cutoff/profile/chunk count to match artifact;
- requires production head revision `0` and zero items;
- calls one RPC with exact state/version/digest fields;
- validates RPC result and resulting revision;
- mismatch in artifact, review, source, target, head, or RPC means zero RPC mutations;
- no provider adapter/fetch is accepted or imported;
- raw dialogue, credentials, paths, and trap sentinels never appear in output/errors;
- input artifacts are not mutated.

- [ ] **Step 2: Run library RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts
```

Expected: missing import module.

- [ ] **Step 3: Implement import preflight**

Exact ordering:

```ts
const artifact = validateCompleteArtifact(readArtifact(input));
const decision = validateReviewDecision(readDecision(input));
const fresh = validatePreparedSource(readFreshSource(input));
assertDigestMatchesArtifact(artifact);
assertDecisionMatchesArtifact(decision, artifact);
assertFreshSourceMatchesArtifact(fresh, artifact);
const head = await client.loadCurrentHead(userId);
assertEmptyInitialHead(head);
const response = await client.importInitialState(buildRpcInput(artifact, userId, importId));
return validateImportResponse(response, artifact);
```

Any validation failure throws before `importInitialState`.

- [ ] **Step 4: Write runner RED tests**

Freeze this import command:

```text
--import-reviewed-history --artifact-file C:\safe\history-backfill.json --review-file C:\safe\history-backfill-review.json --import-id 00000000-0000-4000-8000-000000000001
```

Tests prove:

- exact flag set and absolute `.json` files;
- artifact and review files are read before environment or network;
- user ID, Supabase URL, and service key come from exact env names;
- fresh source inspection occurs before head/RPC;
- no OpenRouter key or provider fetch is read or accepted;
- malformed file, review mismatch, source mismatch, nonempty head, or RPC error yields one safe failure and no retry;
- success writes one safe stdout summary and no artifact copy;
- direct invocation binds fs/Supabase only; library remains injectable.

- [ ] **Step 5: Run runner RED**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts
```

Expected: missing import-run module.

- [ ] **Step 6: Implement the import-only runner**

The runner parses the artifact to recover exact `sourceCutoff` and `profileId`, creates the read-only source reader, recomputes the prepared source in memory, creates a service-role RPC client, and invokes `importReviewedLifecycleHistory` once. It never imports provider transport modules and never reads `OPENROUTER_API_KEY`.

- [ ] **Step 7: Run GREEN and migration contracts**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts
npx.cmd tsx --test supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts
```

Expected: all PASS, provider call count fixed at zero for import tests.

- [ ] **Step 8: Verify task scope and STOP**

Run frozen hashes, syntax, whitespace, privacy/import scan, status, and index review. No actual artifact, review file, `.env`, source, RPC, or remote Supabase endpoint may be used.

After separate approval:

```powershell
git add -- scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts
git commit -m "[agent] feat: add reviewed Memory V3 backfill importer"
```

---

### Task 9: Document the Operator Workflow and Run the Full Offline Gate

**Files:**

- Modify: `scripts/memory-v3-pilot/README.md`
- Modify: `scripts/memory-v3-pilot/memory-v3-dataset-v2.test.mjs`

**Interfaces:**

- Consumes: every Task 1-8 public command and safety contract.
- Produces: one operator-facing section and one source-locked documentation contract.

- [ ] **Step 1: Write documentation RED assertions**

Add a test that isolates the heading `## Memory V3 historical backfill` and requires these statements:

- design is offline/review-first and not automatic production learning;
- current live loader covers one conversation and at most 60 recent messages;
- inspection reads complete eligible history up to a cutoff with zero provider calls;
- paid run requires a fresh price snapshot, exact source digest, explicit flag, and hard budget;
- no application-layer retry, repair, fallback, or parallel calls; the frozen provider transport keeps its existing `allow_fallbacks: true` routing field;
- artifact contains normalized personal memory and must remain untracked;
- human PASS is tied to payload digest and contains one explicit PASS row for every final memory;
- import is initial-only, service-role-only, and atomic;
- read canary remains off until a separate activation;
- rollback is read mode off, not destructive deletion;
- real source inspection, paid execution, migration deployment, import, and activation are separate approvals.

- [ ] **Step 2: Run documentation RED**

Run:

```powershell
node --test scripts/memory-v3-pilot/memory-v3-dataset-v2.test.mjs
```

Expected: one new failure stating that the historical backfill section is missing.

- [ ] **Step 3: Add the README section**

Document safe command shapes without a real user ID, real path, current price, key, or authorization value. The paid and import commands are explicitly labeled examples that must not be run during implementation. State that exact commands are generated only after source inspection and approvals.

- [ ] **Step 4: Run all targeted tests**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-profile.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-source.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-engine.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-cli.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-run.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.test.ts
npx.cmd tsx --test supabase/functions/_shared/memoryV3/lifecycleBackfillMigration.cases.test.ts
node --test scripts/memory-v3-pilot/memory-v3-dataset-v2.test.mjs
```

Expected: all PASS.

- [ ] **Step 5: Run full offline regressions**

Run:

```powershell
node --test scripts/memory-v3-pilot/*.test.mjs
$memoryTests = rg --files supabase/functions/_shared/memoryV3 | Where-Object { $_ -like '*.cases.test.ts' }
npx.cmd tsx --test $memoryTests
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

Expected: all commands exit `0`. Do not waive a failure as unrelated until a clean-tree baseline proves it predates this branch; if it predates the branch, document it and fix it in a separate authorized task rather than suppressing it here.

- [ ] **Step 6: Run final frozen/privacy/scope checks**

Run:

```powershell
npx.cmd tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-frozen.test.ts
git diff --check
git diff --cached --check
git status --short
git diff --name-only
git diff --cached --name-status
```

Scan created/modified files for secrets, real identifiers, raw dialogue, `Authorization`, direct production URLs, retries, fallback/repair logic, automatic execute flags, and accidental `_tmp` staging. Expected: no violations and empty index.

- [ ] **Step 7: Verify task scope and STOP**

Report:

- exact test/suite counts;
- syntax/typecheck/lint/build results;
- hashes of every new file and frozen file;
- exact changed paths;
- confirmation that network, `.env`, remote Supabase, provider, paid, deploy, import, canary activation, stage, commit, and push were all zero; report local disposable Supabase use separately if Task 7 ran it.

After separate approval:

```powershell
git add -- scripts/memory-v3-pilot/README.md scripts/memory-v3-pilot/memory-v3-dataset-v2.test.mjs
git commit -m "[agent] docs: document Memory V3 history backfill"
```

---

## Final Operational STOP

Completion of Tasks 1-9 produces tested software only. It does not authorize any real-data or production operation.

The next actions remain separate and sequential:

1. review the complete implementation diff and commit chain;
2. ordinary push and PR only after explicit approval;
3. merge only after review;
4. run provider-free real source inspection only after explicit approval;
5. verify a fresh provider price and obtain a paid maximum-budget authorization;
6. perform at most one paid backfill with no application-layer retry;
7. review every resulting memory and create a digest-bound PASS decision;
8. deploy migration 037 only after explicit approval and backup verification;
9. import once only after explicit approval naming the artifact digest and target;
10. verify projection and activate canary only after another explicit approval.

At no point may a worker infer permission for the next action from approval of the previous action.

## Plan Self-Review

### Spec coverage

| Spec requirement | Plan task |
|---|---|
| frozen profile and limits | Task 2 |
| complete read-only source inspection | Task 4 |
| deterministic single-conversation chunks | Task 3 |
| exact source digest and sanitized manifest | Tasks 3-4 |
| sequential in-memory extractor/reconciler/reducer | Task 5 |
| two calls per chunk, no retry, maxActive one | Task 5 |
| fresh price and explicit hard budget | Tasks 2, 5, 6 |
| no raw dialogue in artifacts/errors | Tasks 3, 5, 6 |
| human digest-bound review | Tasks 5, 8 |
| atomic initial-only import | Task 7 |
| fresh source revalidation before import | Task 8 |
| canary remains off and rollback documented | Task 9 |
| full offline regression and privacy gate | Task 9 |

### Type consistency

- `PreparedLifecycleHistoryBackfill` is created in Task 3, returned by Task 4, consumed by Tasks 5 and 8.
- `LifecycleHistoryBackfillResult` and review packet are created in Task 5, serialized in Task 6, validated in Task 8.
- `extractorRequestSha256` is created in Task 3 and revalidated before each Task 5 extractor call.
- `semanticReviewPacket.payloadSha256` covers the canonical result and review items; Task 8 requires one separate PASS decision row for every final memory key.
- `LifecycleHistorySourceReader` is defined in Task 4 and injected into Tasks 6 and 8.
- SQL RPC fields in Task 7 match `LifecycleHistoryImportClient.importInitialState` in Task 8.
- Profile, schema, pipeline, model, byte caps, state caps, and execute flag use one spelling throughout.

### Scope result

The backfill engine and atomic importer are two boundaries of one review-first feature: the engine's only production destination is the importer, and the importer accepts only the engine's digest-bound artifact. Separate plans would leave either an unimportable draft or an importer with no trusted artifact contract, so this plan keeps them together while preserving independent task reviews.
