# Memory V3 Production Shadow Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline-verified, default-off Memory V3 shadow path that can later observe one explicitly allowlisted StaySEE account without changing replies or current memory.

**Architecture:** A pure TypeScript Memory V3 boundary validates configuration, source messages, the V2 layered response, and OpenRouter transport data. An atomic service-only PostgreSQL reservation enforces one call per canonical snapshot and at most four reservations per UTC day. `staysee-chat` composes the shadow runner only in the existing background summary cadence; no V3 output enters reply context, `conversation_summary`, `user_memory`, or the client response.

**Tech Stack:** TypeScript, Deno Edge Functions, Supabase/PostgreSQL, OpenRouter Chat Completions, Web Crypto SHA-256, standalone `tsx` case tests, existing Node Memory V3 regression tests.

**Spec:** `docs/superpowers/specs/2026-09-05-memory-v3-production-shadow-pilot-design.md`

## Global Constraints

- Work only in the linked worktree `D:/Staisy-main Приложение/Staysee-memory-v3` on `codex/memory-v3-pilot`.
- Read the spec before every task. Its approved SHA256 is `4DAD1CAA687ED599D0AEADF2068E20C35F03BDAEA220A0688C1CA2ECA340ACE8`.
- Complete exactly one task, run its gates, report, and stop for review. Do not start the next task automatically.
- Follow strict RED → GREEN TDD. A missing production module is an acceptable first RED; syntax, dependency, and fixture failures are not.
- Do not deploy migrations or Edge Functions, change Supabase configuration, read `.env`, call OpenRouter, or perform any paid request in Tasks 1–7.
- Do not add a live command or automatic execution path.
- The default mode is `off`. Unknown, missing, malformed, or nonmatching configuration produces zero reservations and zero provider calls.
- The pilot accepts one exact canonical UUID, not an email, list, wildcard, percentage, or client value.
- The hard cap is four reservations per allowlisted user per UTC day. Failed and abandoned reservations count.
- The enforceable input cap is 20,000 UTF-8 bytes; source rows are limited to 60; output is limited to 1,200 tokens.
- Budget accounting reserves 32,768 input tokens per run without claiming measured usage. At the reviewed $0.75/M input and $3.75/M output prices, the configured ceiling is $0.029076 per run and $0.116304 for four runs; it is not an actual billing guarantee.
- The model is `google/gemini-3.7-flash`; the extractor version is `memory-v3-openrouter-gemini-3.7-flash-shadow-v2`; the response contract is `v2-layered`.
- The application makes at most one HTTP POST for a new reservation. No retry, repair call, recursive extraction, or legacy-memory fallback is allowed.
- Store normalized `items` and `evidence` plus safe metadata only. Never store or log the raw prompt, raw provider body, raw content string, full dialogue snapshot, API key, Authorization header, or arbitrary exception text.
- Do not modify `memory.ts`, `summaryRefresh.ts`, `context.ts`, `userLifeMemory.ts`, `memoryLayersV2.ts`, `aiAuditVersions.ts`, either golden dataset, or current V1/V2 benchmark behavior.
- Do not stage, edit, delete, parse, or include the six `_tmp-live-benchmark-*.json` files. Their approved hashes are listed below.

| Artifact | SHA256 |
|---|---|
| `_tmp-live-benchmark-hypothesis-four-v2-admission-r1-gemini-20260905.json` | `CA3C5D12E1E0AB8DA5F31E4D40095E6FBAC07149592BD35C7A2BBD7680509B31` |
| `_tmp-live-benchmark-hypothesis-four-v2-gemini-20260905.json` | `FFB0543CD2B4CCE50B4A8D0F81F2976A0A6E54548B10C65DEA9D24A09B0CAEC0` |
| `_tmp-live-benchmark-hypothesis-four-v2-layer-decision-hypothesis-admission-r3-gemini-20260905.json` | `CDBBC3B692BEF16A308949DDF8E36370DA219D3EA6049ADE52CE248D0AEB6C1B` |
| `_tmp-live-benchmark-hypothesis-four-v2-layer-decision-r2-gemini-20260905.json` | `C2118DF912F0A13235C9A8C6B00DAFFB84E2293BADC31A55821F18BC254A0CCD` |
| `_tmp-live-benchmark-six-v2-gemini-20260902.json` | `4C853A7FF2DEDDB2AE544DCE767B039F9E7A5DBC16B437CBDD1AB9DE76DD93FB` |
| `_tmp-live-benchmark-six-v2-layer-decision-hypothesis-admission-r3-gemini-20260905.json` | `AC4FCA5CD0A170684DC89C345FEB997E1122E8C405844237912E237088535696` |

## File Structure

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/memoryV3/mode.ts` | Pure fail-closed mode and exact-account gate |
| `supabase/functions/_shared/memoryV3/messages.ts` | Ownership-scoped query and strict source-message projection |
| `supabase/functions/_shared/memoryV3/contract.ts` | Production dialogue/input validation and V2 layered extraction normalization |
| `supabase/functions/_shared/memoryV3/prompt.ts` | Static system instruction and allowlisted request projection |
| `supabase/functions/_shared/memoryV3/transport.ts` | Injected-fetch OpenRouter request and safe response projection |
| `supabase/functions/_shared/memoryV3/shadowStore.ts` | RPC reservation and terminal status writes |
| `supabase/functions/_shared/memoryV3/shadowRunner.ts` | Ordered preflight, hash, reservation, one call, persistence |
| `supabase/migrations/20260905120000_032_memory_v3_shadow_pilot.sql` | Durable identity ledger, 30-day run table, RLS, atomic functions, retention function |
| `supabase/functions/staysee-chat/index.ts` | Composition only: env, service client, runtime fetch, background scheduling |
| `scripts/memory-v3-pilot/README.md` | Offline status and activation/deployment gates |

---

### Task 1: Fail-Closed Mode and Bounded Source Messages

**Files:**
- Create: `supabase/functions/_shared/memoryV3/mode.ts`
- Create: `supabase/functions/_shared/memoryV3/mode.cases.test.ts`
- Create: `supabase/functions/_shared/memoryV3/messages.ts`
- Create: `supabase/functions/_shared/memoryV3/messages.cases.test.ts`

**Interfaces:**
- Produces: `parseMemoryV3ShadowMode(raw): "off" | "shadow"`
- Produces: `resolveMemoryV3ShadowEligibility(input): MemoryV3ShadowEligibility`
- Produces: `projectMemoryV3SourceRows(rows): MemoryV3DialogueMessage[]`
- Produces: `createMemoryV3MessageLoader(client): (userId, conversationId) => Promise<MemoryV3DialogueMessage[]>`
- Depends on: injected environment strings and an injected Supabase-shaped client only

- [ ] **Step 1: Write failing mode tests**

Create `mode.cases.test.ts` with synthetic UUIDs and these exact assertions:

```ts
import {
  parseMemoryV3ShadowMode,
  resolveMemoryV3ShadowEligibility,
} from "./mode.ts";

const NASTYA = "11111111-1111-4111-8111-111111111111";
const SON = "22222222-2222-4222-8222-222222222222";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(parseMemoryV3ShadowMode(undefined) === "off", "missing mode is off");
assert(parseMemoryV3ShadowMode("shadow") === "shadow", "shadow is accepted");
for (const raw of ["", "off ", "SHADOW", "on", "response", "shadow,off"]) {
  assert(parseMemoryV3ShadowMode(raw) === "off", `fail closed for ${String(raw)}`);
}

const allowed = resolveMemoryV3ShadowEligibility({
  rawMode: "shadow",
  rawAllowedUserId: NASTYA,
  userId: NASTYA,
});
assert(allowed.eligible === true, "exact UUID is eligible");

for (const rawAllowedUserId of [
  undefined,
  "*",
  "nastya@example.test",
  `${NASTYA},${SON}`,
  NASTYA.toUpperCase(),
]) {
  const result = resolveMemoryV3ShadowEligibility({
    rawMode: "shadow",
    rawAllowedUserId,
    userId: NASTYA,
  });
  assert(result.eligible === false, "invalid allowlist must fail closed");
}
assert(
  resolveMemoryV3ShadowEligibility({
    rawMode: "shadow",
    rawAllowedUserId: NASTYA,
    userId: SON,
  }).eligible === false,
  "second account is not eligible",
);
```

- [ ] **Step 2: Run the mode test and confirm RED**

Run:

```bash
npx tsx supabase/functions/_shared/memoryV3/mode.cases.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `mode.ts`.

- [ ] **Step 3: Implement the pure mode gate**

Use these public types and exact canonical UUID rule:

```ts
export type MemoryV3ShadowMode = "off" | "shadow";

export type MemoryV3ShadowEligibility =
  | { eligible: true; mode: "shadow"; userId: string }
  | {
      eligible: false;
      mode: "off" | "shadow";
      reason: "disabled" | "invalid_allowlist" | "user_not_allowlisted";
    };

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseMemoryV3ShadowMode(
  raw: string | null | undefined,
): MemoryV3ShadowMode {
  return raw === "shadow" ? "shadow" : "off";
}
```

`resolveMemoryV3ShadowEligibility` must first parse the mode, then validate both UUID strings as primitive canonical UUIDs, then require exact equality. It must not trim, lowercase, split, or accept boxed strings.

- [ ] **Step 4: Write failing source-message tests**

Create `messages.cases.test.ts`. Cover all of the following with a fake chainable Supabase client:

```ts
const rows = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    sender: "ai",
    content: "Контекст",
    created_at: "2026-09-05T10:01:00.000Z",
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    sender: "user",
    content: "Первое сообщение",
    created_at: "2026-09-05T10:00:00.000Z",
  },
];

const projected = projectMemoryV3SourceRows(rows);
assert(projected[0].role === "user", "oldest row first");
assert(projected[1].role === "assistant", "ai maps to assistant");
assert(Object.keys(projected[0]).join(",") === "id,role,text,createdAt", "allowlist");
assert(rows[0].content === "Контекст", "input is not mutated");
```

Also assert rejection of: non-array input, more than 60 rows, empty rows, sparse arrays, extra array keys, duplicate IDs, invalid UUID, unknown sender, empty/non-string content, invalid timestamp, symbol/accessor/non-enumerable fields, zero user messages, and raw exception sentinel leakage.

For `createMemoryV3MessageLoader`, assert the query selects only `id, sender, content, created_at`, constrains conversation ownership before messages are returned, orders by `created_at ASC` then `id ASC`, and applies `limit(60)`. An owned conversation with no rows is invalid because the extractor requires at least one user message. Ownership, empty-source, and query errors must throw a branded safe error without raw database text or `cause`.

- [ ] **Step 5: Implement strict message projection and loader**

Use these public shapes:

```ts
export interface MemoryV3DialogueMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface MemoryV3MessageClient {
  from(table: string): unknown;
}

export function projectMemoryV3SourceRows(
  rows: unknown,
): MemoryV3DialogueMessage[];

export function createMemoryV3MessageLoader(
  client: MemoryV3MessageClient,
): (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
```

Inspect all objects with own enumerable data descriptors without executing getters. Copy only the four output fields. Sort the copied rows with code-unit comparison after timestamp comparison. Verify conversation ownership with `conversations.id` and `conversations.user_id`, then query `messages.conversation_id`; never trust a client-supplied ownership claim.

- [ ] **Step 6: Run Task 1 gates**

```bash
npx tsx supabase/functions/_shared/memoryV3/mode.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/messages.cases.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Expected: both case scripts exit 0; existing Memory V3 suite remains green; no network or `.env` read.

- [ ] **Step 7: Commit Task 1 after review approval**

```bash
git add supabase/functions/_shared/memoryV3/mode.ts supabase/functions/_shared/memoryV3/mode.cases.test.ts supabase/functions/_shared/memoryV3/messages.ts supabase/functions/_shared/memoryV3/messages.cases.test.ts
git commit -m "[agent] feat: add Memory V3 shadow eligibility and messages"
```

Stop. Do not start Task 2 automatically.

---

### Task 2: Production V2 Contract and Prompt Parity

**Files:**
- Create: `supabase/functions/_shared/memoryV3/contract.ts`
- Create: `supabase/functions/_shared/memoryV3/contract.cases.test.ts`
- Create: `supabase/functions/_shared/memoryV3/prompt.ts`
- Create: `supabase/functions/_shared/memoryV3/prompt.cases.test.ts`

**Interfaces:**
- Consumes: `MemoryV3DialogueMessage[]` from Task 1
- Produces: `validateMemoryV3Dialogue(input): MemoryV3DialogueInput`
- Produces: `normalizeMemoryV3LayeredResponse(raw, input, extractorVersion): Promise<MemoryV3Extraction>`
- Produces: `buildMemoryV3ExtractorRequest(input): MemoryV3ExtractorRequest`
- Produces: `MEMORY_V3_EXTRACTOR_VERSION`, `MEMORY_V3_MODEL`, `MEMORY_V3_MAX_PROMPT_BYTES`, `MEMORY_V3_MAX_OUTPUT_TOKENS`, `MEMORY_V3_RESERVED_INPUT_TOKENS`, and the frozen nanodollar planning constants below

- [ ] **Step 1: Write contract parity RED tests**

Build synthetic dialogue fixtures with UUID message IDs. Dynamically import the approved offline modules only from the test file:

```ts
import {
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
} from "./contract.ts";

const dialogue = {
  caseId:
    "memory-v3-shadow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  messages: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "user",
      text: "Когда мне страшно, я часто шучу, чтобы стало легче.",
      createdAt: "2026-09-05T10:00:00.000Z",
    },
  ],
};

const raw = {
  layerDecisions: [
    { kind: "event", decision: "omit", itemRefs: [] },
    { kind: "recurrence", decision: "omit", itemRefs: [] },
    { kind: "hypothesis", decision: "emit", itemRefs: ["h1"] },
  ],
  items: [
    {
      itemRef: "h1",
      kind: "hypothesis",
      claim: "Юмор может помогать выдерживать страх.",
      status: "candidate",
      sensitivity: "normal",
      eventTimeStart: null,
      eventTimeEnd: null,
      alternative: "Юмор может быть способом поддержать собеседника.",
    },
  ],
  evidence: [
    {
      itemRef: "h1",
      sourceMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      relation: "supports",
      supportType: null,
      episodeKey: "episode:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  ],
};

const normalized = await normalizeMemoryV3LayeredResponse(
  raw,
  validateMemoryV3Dialogue(dialogue),
  "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
);
assert(normalized.items.length === 1, "one item");
assert(normalized.evidence[0].provenanceRole === "user", "user provenance");
assert(normalized.evidence[0].mentionTime === dialogue.messages[0].createdAt, "time copied");
```

Add table-driven cases matching the approved V2 behavior: event/recurrence/hypothesis statuses, required relation matrix, recurrence `episode_observation` with two distinct episode keys, `pattern_confirmation` and `scope_boundary` with null episode key, assistant evidence rejection for every relation, date validation including ±14:00, duplicate evidence identity, forbidden identity fields, unknown fields, sparse arrays, accessor/symbol/non-enumerable rejection, layer decision completeness, and generic non-leaking diagnostics.

Lock the reviewed planning arithmetic with integer nanodollars: `32_768 * 750 + 1_200 * 3_750 === 29_076_000` per run and `29_076_000 * 4 === 116_304_000` per UTC day. These assertions describe configured exposure, not measured usage or a billing guarantee.

No production file may import `scripts/memory-v3-pilot`.

- [ ] **Step 2: Run contract test and confirm RED**

```bash
npx tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts
```

Expected: FAIL with missing `contract.ts`.

- [ ] **Step 3: Implement the production dialogue and response contract**

Export these constants and types:

```ts
export const MEMORY_V3_EXTRACTOR_VERSION =
  "memory-v3-openrouter-gemini-3.7-flash-shadow-v2";
export const MEMORY_V3_MODEL = "google/gemini-3.7-flash";
export const MEMORY_V3_MAX_PROMPT_BYTES = 20_000;
export const MEMORY_V3_MAX_OUTPUT_TOKENS = 1_200;
export const MEMORY_V3_RESERVED_INPUT_TOKENS = 32_768;
export const MEMORY_V3_MAX_SOURCE_MESSAGES = 60;
export const MEMORY_V3_MAX_DAILY_RESERVATIONS = 4;
export const MEMORY_V3_INPUT_NANODOLLARS_PER_TOKEN = 750;
export const MEMORY_V3_OUTPUT_NANODOLLARS_PER_TOKEN = 3_750;
export const MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_RUN = 29_076_000;
export const MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_DAY = 116_304_000;

export interface MemoryV3DialogueInput {
  caseId: string;
  messages: MemoryV3DialogueMessage[];
}

export interface MemoryV3Extraction {
  run: { caseId: string; extractorVersion: string };
  items: Array<{
    localItemKey: string;
    kind: "event" | "recurrence" | "hypothesis";
    claim: string;
    scope: "cross_conversation";
    conversationId: null;
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    status: string;
    sensitivity: "normal" | "sensitive";
    alternative: string | null;
  }>;
  evidence: Array<{
    itemKey: string;
    sourceMessageId: string;
    relation: "supports" | "contradicts" | "corrects" | "rejects";
    supportType: "episode_observation" | "pattern_confirmation" | "scope_boundary" | null;
    episodeKey: string | null;
    provenanceRole: "user";
    mentionTime: string;
  }>;
}
```

Port the approved validation algorithm from `contracts-v2.mjs` and normalization algorithm from `extractor-core-v2.mjs`, excluding all gold-only validation. Use Web Crypto SHA-256 over the same canonical structural item payload to create `localItemKey`. Treat `layerDecisions` as required input validation but do not store raw `itemRef` or decision rows in `MemoryV3Extraction`.

- [ ] **Step 4: Write prompt parity RED tests**

The test imports `EXTRACTOR_SYSTEM_INSTRUCTION_V2` from the approved offline module and requires exact runtime equality:

```ts
import { EXTRACTOR_SYSTEM_INSTRUCTION_V2 } from
  "../../../../scripts/memory-v3-pilot/extractor-prompt-v2.mjs";
import {
  MEMORY_V3_SYSTEM_INSTRUCTION,
  buildMemoryV3ExtractorRequest,
} from "./prompt.ts";

assert(
  MEMORY_V3_SYSTEM_INSTRUCTION === EXTRACTOR_SYSTEM_INSTRUCTION_V2,
  "production prompt must equal approved V2 prompt",
);

const request = buildMemoryV3ExtractorRequest(dialogue);
assert(Object.keys(request).join(",") === "system,input", "top-level allowlist");
assert(Object.keys(request.input).join(",") === "caseId,messages", "input allowlist");
assert(!JSON.stringify(request).includes("gold"), "no gold leak");
```

Add injection sentinel text to a user message and prove it appears only in `input.messages[*].text`, never in the static system instruction. Prove the input is not mutated and output message objects are new allowlisted copies.

- [ ] **Step 5: Implement the static prompt boundary**

```ts
export interface MemoryV3ExtractorRequest {
  system: string;
  input: {
    caseId: string;
    messages: MemoryV3DialogueMessage[];
  };
}

export function buildMemoryV3ExtractorRequest(
  input: unknown,
): MemoryV3ExtractorRequest {
  const validated = validateMemoryV3Dialogue(input);
  return {
    system: MEMORY_V3_SYSTEM_INSTRUCTION,
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

In the production file, define `MEMORY_V3_SYSTEM_INSTRUCTION` by copying the complete value of `EXTRACTOR_SYSTEM_INSTRUCTION_V2` from `scripts/memory-v3-pilot/extractor-prompt-v2.mjs` verbatim. The parity test above is the acceptance criterion. The committed production file must contain the complete static string, with no shortened marker, interpolation, or runtime reference to the offline filesystem.

- [ ] **Step 6: Run Task 2 gates**

```bash
npx tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
node --test scripts/memory-v3-pilot/contracts-v2.test.mjs scripts/memory-v3-pilot/extractor-prompt-v2.test.mjs scripts/memory-v3-pilot/extractor-core-v2.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Expected: all pass; source scan confirms production modules do not import the offline scripts.

- [ ] **Step 7: Commit Task 2 after review approval**

```bash
git add supabase/functions/_shared/memoryV3/contract.ts supabase/functions/_shared/memoryV3/contract.cases.test.ts supabase/functions/_shared/memoryV3/prompt.ts supabase/functions/_shared/memoryV3/prompt.cases.test.ts
git commit -m "[agent] feat: port Memory V3 shadow contract"
```

Stop. Do not start Task 3 automatically.

---

### Task 3: Injected OpenRouter Transport

**Files:**
- Create: `supabase/functions/_shared/memoryV3/transport.ts`
- Create: `supabase/functions/_shared/memoryV3/transport.cases.test.ts`

**Interfaces:**
- Consumes: `MemoryV3ExtractorRequest` and constants from Task 2
- Produces: `createMemoryV3OpenRouterAdapter(options): MemoryV3ModelAdapter`
- Produces: `projectSafeMemoryV3TransportDiagnostic(error): string | null`
- Runtime dependency: injected `fetchImpl`; no global fetch fallback

- [ ] **Step 1: Write transport RED tests**

Use an injected fake fetch and assert one exact POST:

```ts
const calls: Array<{ url: string; init: RequestInit }> = [];
const fetchImpl = async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  return new Response(JSON.stringify({
    id: "synthetic-response",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(validLayeredResponse), refusal: null },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const adapter = createMemoryV3OpenRouterAdapter({
  fetchImpl,
  apiKey: "test-key",
});
const result = await adapter(request);
assert(calls.length === 1, "one POST");
assert(calls[0].url === "https://openrouter.ai/api/v1/chat/completions", "fixed URL");
const body = JSON.parse(String(calls[0].init.body));
assert(body.model === "google/gemini-3.7-flash", "fixed model");
assert(body.max_tokens === 1200, "Gemini token field");
assert(body.reasoning.effort === "low", "reviewed reasoning effort");
assert(body.provider.require_parameters === true, "parameter lock");
assert(body.provider.data_collection === "deny", "data collection denied");
assert(body.provider.zdr === true, "ZDR required");
assert(body.provider.allow_fallbacks === true, "compatible endpoint fallback");
assert(result.content === JSON.stringify(validLayeredResponse), "content only");
```

In this test file only, instantiate the approved offline `createOpenRouterAdapter` with an injected recording transport and the same model, token field, output limit, reasoning effort, fallback flag, and `v2-layered` response contract. Compare the complete captured `body.response_format` object with the production fake-fetch request using `assert.deepEqual`. This is the exact schema parity lock; checking only `response_format.type` is insufficient.

Add cases for non-2xx status, timeout including hanging `response.text()`, response over 1,000,000 UTF-8 bytes, invalid JSON, top-level error, choice error, finish reason not `stop`, missing content, non-assistant role, refusal string, `refusal: null`, getters/proxies/revoked objects, spoofed diagnostic code, raw body sentinel, API key sentinel, and absence of `cause`.

Use an injected fake clock for timeout tests. Assert that `setTimeoutImpl` and `clearTimeoutImpl` are accepted only as a pair, the timer remains active through `response.text()` and JSON parsing, abort happens once, and cleanup happens once.

- [ ] **Step 2: Run transport test and confirm RED**

```bash
npx tsx supabase/functions/_shared/memoryV3/transport.cases.test.ts
```

Expected: FAIL with missing `transport.ts`.

- [ ] **Step 3: Implement the injected transport**

Expose this contract:

```ts
export interface MemoryV3TransportResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } | null;
}

export type MemoryV3ModelAdapter = (
  request: MemoryV3ExtractorRequest,
) => Promise<MemoryV3TransportResult>;

export function createMemoryV3OpenRouterAdapter(options: {
  fetchImpl: typeof fetch;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  setTimeoutImpl?: (handler: () => void, delayMs: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}): MemoryV3ModelAdapter;
```

Defaults are 60,000 ms, 1,000,000 response bytes, `globalThis.setTimeout`, and `globalThis.clearTimeout`. The two timer overrides are optional only together. Use one `AbortController`, one timer spanning fetch, body read, byte check, and JSON parse, and one timer cleanup in `finally`. Project only `choices[0].message.content` plus strictly validated numeric usage. Treat missing or untrusted usage as `null`; never estimate it as actual.

Build the same `v2-layered` JSON schema used by the approved adapter. Keep it local and frozen; unknown telemetry data fields may be ignored only after JSON-data-only descriptor inspection.

- [ ] **Step 4: Run Task 3 gates**

```bash
npx tsx supabase/functions/_shared/memoryV3/transport.cases.test.ts
node --test scripts/memory-v3-pilot/openrouter-adapter.test.mjs scripts/memory-v3-pilot/openrouter-fetch-transport.test.mjs
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Expected: all pass; `rg` confirms no `globalThis.fetch`, `.env`, `process.env`, raw response logging, or second HTTP call in the new production module.

- [ ] **Step 5: Commit Task 3 after review approval**

```bash
git add supabase/functions/_shared/memoryV3/transport.ts supabase/functions/_shared/memoryV3/transport.cases.test.ts
git commit -m "[agent] feat: add Memory V3 shadow transport"
```

Stop. Do not start Task 4 automatically.

---

### Task 4: Atomic Shadow Storage and Retention

**Files:**
- Create: `supabase/migrations/20260905120000_032_memory_v3_shadow_pilot.sql`
- Create: `supabase/functions/_shared/memoryV3/shadowStore.ts`
- Create: `supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts`

**Interfaces:**
- Consumes: `MemoryV3Extraction` from Task 2 and `MemoryV3TransportResult` from Task 3
- Produces SQL RPC: `reserve_memory_v3_shadow_run`
- Produces SQL RPC: `complete_memory_v3_shadow_run`
- Produces SQL RPC: `purge_memory_v3_shadow_runs()`
- Produces TypeScript: `createMemoryV3ShadowStore(client): MemoryV3ShadowStore`

- [ ] **Step 1: Write migration and store RED tests**

Read the migration as text in the test and assert exact security locks:

```ts
const sql = readFileSync(
  new URL("../../../migrations/20260905120000_032_memory_v3_shadow_pilot.sql", import.meta.url),
  "utf8",
);
assert(sql.includes("CREATE TABLE public.memory_v3_shadow_identities"), "identity ledger exists");
assert(sql.includes("CREATE TABLE public.memory_v3_shadow_runs"), "run table exists");
assert(sql.includes("ALTER TABLE public.memory_v3_shadow_identities ENABLE ROW LEVEL SECURITY"), "identity RLS enabled");
assert(sql.includes("ALTER TABLE public.memory_v3_shadow_runs ENABLE ROW LEVEL SECURITY"), "run RLS enabled");
assert(!/CREATE POLICY/i.test(sql), "no client policy");
assert(sql.includes("SECURITY DEFINER"), "RPCs are security definer");
assert(sql.includes("SET search_path = ''"), "empty fixed search path");
assert(sql.includes("public.memory_v3_shadow_identities"), "identity references are qualified");
assert(sql.includes("public.memory_v3_shadow_runs"), "run references are qualified");
assert(sql.includes("pg_advisory_xact_lock"), "atomic daily gate");
assert(sql.includes("INTERVAL '30 days'"), "retention");
assert(sql.includes("GRANT EXECUTE ON FUNCTION"), "service grant");
assert(sql.includes("TO service_role"), "service role only");
assert(!/TO\s+(anon|authenticated)/i.test(sql), "no client grant");
```

Migration tests must also prove that the durable identity key is unique over `(user_id, conversation_id, extractor_version, input_hash)`, the run row references that exact identity, expired run payloads are deleted inside reservation before duplicate/daily-cap decisions, purge deletes only run rows, and account/conversation deletion cascades through both tables. Lock the database diagnostic allowlist and terminal row invariants: `reserved` has no completion payload; `succeeded` has completion time, normalized extraction and counts but no diagnostic; `failed` has completion time and an allowlisted diagnostic but no extraction, item/evidence counts, or usage. Assert the reservation statements occur in the specified order by comparing their source offsets; a mere presence check is insufficient.

Store fake-RPC cases must prove: reserved result, duplicate result, daily-cap result, malformed RPC data rejection, database sentinel non-leak, terminal success projection, terminal failure projection, extraction copied without aliasing, and no arbitrary diagnostic string accepted.

- [ ] **Step 2: Run store test and confirm RED**

```bash
npx tsx supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
```

Expected: FAIL because the migration and `shadowStore.ts` are absent.

- [ ] **Step 3: Implement the migration**

Create both tables from the spec. `public.memory_v3_shadow_identities` contains only the non-content at-most-once identity and is retained until account/conversation deletion. `public.memory_v3_shadow_runs` contains the 30-day payload and has a composite foreign key to its matching identity row. Add the diagnostic allowlist and status-dependent terminal-shape constraints from the spec. Every object reference inside each `SECURITY DEFINER` function must be schema-qualified, and every such function must use `SET search_path = ''`.

The reservation function returns exactly one row with:

```sql
RETURNS TABLE(result text, run_id uuid)
```

Allowed results are `reserved`, `duplicate`, and `daily_cap`. Its transaction order is: ownership check; advisory lock by user and UTC date; delete expired rows from `public.memory_v3_shadow_runs`; durable identity lookup; daily run count; daily-cap decision; conflict-safe identity insert; matching `reserved` run insert. Daily count uses `created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` and rejects at 4. The identity insert must translate a cross-date unique conflict into `duplicate` without inserting a run row. A duplicate identity remains a duplicate even after its run payload has been purged.

The completion function accepts run ID, terminal status, allowlisted diagnostic code, counts, extraction JSON, trusted nullable usage, and completion time. It updates only a row currently in `reserved` state and verifies the passed user ID owns it.

`purge_memory_v3_shadow_runs()` deletes only run rows older than `now() - interval '30 days'`; it must not delete identity-ledger rows. Revoke all table/function access from `PUBLIC`, `anon`, and `authenticated`; grant only required table and function rights to `service_role`.

- [ ] **Step 4: Implement the TypeScript store boundary**

```ts
export type MemoryV3StoredDiagnostic =
  | "invalid_source"
  | "prompt_too_large"
  | "reservation_failed"
  | "transport_failed"
  | "transport_timeout"
  | "provider_http_4xx"
  | "provider_http_5xx"
  | "provider_response_invalid"
  | "extractor_parse_invalid"
  | "extractor_shape_invalid"
  | "extractor_contract_invalid"
  | "completion_write_failed"
  | "unknown_failure";

export interface MemoryV3ReservationInput {
  userId: string;
  conversationId: string;
  extractorVersion: string;
  model: string;
  inputHash: string;
  sourceLastMessageId: string;
  sourceLastCreatedAt: string;
  messageCount: number;
  userMessageCount: number;
}

export interface MemoryV3SuccessWrite {
  runId: string;
  userId: string;
  extraction: MemoryV3Extraction;
  itemCount: number;
  evidenceCount: number;
  usage: MemoryV3TransportResult["usage"];
}

export interface MemoryV3FailureWrite {
  runId: string;
  userId: string;
  diagnosticCode: MemoryV3StoredDiagnostic;
}

export type MemoryV3ReservationResult =
  | { status: "reserved"; runId: string }
  | { status: "duplicate" | "daily_cap" };

export interface MemoryV3ShadowStore {
  reserve(input: MemoryV3ReservationInput): Promise<MemoryV3ReservationResult>;
  succeed(input: MemoryV3SuccessWrite): Promise<void>;
  fail(input: MemoryV3FailureWrite): Promise<void>;
}

export function createMemoryV3ShadowStore(client: {
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: unknown;
  }>;
}): MemoryV3ShadowStore;
```

Copy all input through fixed allowlists and JSON-data-only inspection. `succeed` accepts only a normalized extraction plus nullable trusted usage. `fail` accepts only a diagnostic from the runner's closed set. Never surface database messages or attach `cause`.

- [ ] **Step 5: Run Task 4 gates**

```bash
npx tsx supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Also run a source assertion proving `memory_v3_shadow_runs` and `memory_v3_shadow_identities` do not appear in existing reply-context or legacy-memory modules.
Read `supabase/migrations/20260605120000_020_room_deletion.sql` and prove its account/room deletion path deletes the owning conversation so the new `ON DELETE CASCADE` foreign keys remove both shadow tables without adding a second manual delete path. Add a migration assertion that purging a run cannot remove the durable identity and therefore cannot make the same snapshot eligible for another paid call.

- [ ] **Step 6: Commit Task 4 after review approval**

```bash
git add supabase/migrations/20260905120000_032_memory_v3_shadow_pilot.sql supabase/functions/_shared/memoryV3/shadowStore.ts supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
git commit -m "[agent] feat: add Memory V3 shadow storage"
```

Stop. Do not deploy the migration and do not start Task 5 automatically.

---

### Task 5: Shadow Orchestrator

**Files:**
- Create: `supabase/functions/_shared/memoryV3/shadowRunner.ts`
- Create: `supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 public interfaces
- Produces: `runMemoryV3Shadow(options): Promise<MemoryV3ShadowResult>`
- Produces: `runMemoryV3ShadowBackgroundSafely(run, logSafe): Promise<void>`
- Produces: `projectSafeMemoryV3ShadowDiagnostic(error): MemoryV3ShadowDiagnostic | null`

- [ ] **Step 1: Write ordered-preflight RED tests**

Build spies for `loadMessages`, `store`, and `modelAdapter`. Assert this success order:

```ts
assert(
  trace.join(",") ===
    "eligibility,messages,prompt,hash,reserve,provider,normalize,succeed",
  "one ordered shadow run",
);
assert(modelCalls === 1, "one provider call");
```

Table-drive all zero-call cases: off mode, invalid allowlist, different account, invalid user/conversation UUID, missing API key, invalid injected dependency, source error, no user messages, more than 60 messages, prompt over 20,000 bytes, hash failure, reservation error, duplicate, and daily cap. For off mode and a nonmatching account, malformed or missing API-key/dependency fields must not replace the normal skip and none of `loadMessages`, store methods, adapter factory, or fetch may run. Accessor/symbol/non-enumerable top-level fields are still rejected during the initial data-only inspection without invoking accessors.

Add concurrency proof with two runners sharing one fake atomic store: one returns `reserved`, one returns `duplicate`, and total model calls equal 1.

Add provider/parse/shape/contract failures: each calls `store.fail` once with an allowlisted code, never retries, never calls `store.succeed`, and never leaks sentinels. Add completion-write failure: one paid adapter call, no retry, safe result `completion_write_failed`.

- [ ] **Step 2: Run runner test and confirm RED**

```bash
npx tsx supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
```

Expected: FAIL with missing `shadowRunner.ts`.

- [ ] **Step 3: Implement canonical identity hashing**

Use a null-prototype canonical projection with this exact shape:

```ts
const hashPayload = {
  schemaVersion: "memory-v3-shadow-input-v1",
  extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
  userId,
  conversationId,
  messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({
    id,
    role,
    text,
    createdAt,
  })),
};
```

Sort object keys recursively, preserve array order, UTF-8 encode, hash with `crypto.subtle.digest("SHA-256", bytes)`, and return lowercase 64-character hexadecimal.

- [ ] **Step 4: Implement the orchestrator**

```ts
export type MemoryV3ShadowDiagnostic = MemoryV3StoredDiagnostic;

export type MemoryV3ShadowResult =
  | { status: "skipped"; reason: "disabled" | "user_not_allowlisted" | "duplicate" | "daily_cap" }
  | { status: "succeeded"; runId: string; itemCount: number; evidenceCount: number }
  | { status: "failed"; runId: string | null; diagnosticCode: MemoryV3ShadowDiagnostic };

export async function runMemoryV3Shadow(options: {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
  conversationId: string;
  apiKey: string | null | undefined;
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
  store: MemoryV3ShadowStore;
  modelAdapterFactory: (apiKey: string) => MemoryV3ModelAdapter;
}): Promise<MemoryV3ShadowResult>;

export async function runMemoryV3ShadowBackgroundSafely(
  run: () => Promise<MemoryV3ShadowResult>,
  logSafe: (diagnosticCode: MemoryV3ShadowDiagnostic) => void,
): Promise<void>;
```

Inspect and copy top-level options first, then resolve mode and exact-account eligibility before requiring credentials or injected dependency shapes. A disabled or nonmatching configuration returns its normal skip without inspecting deeper credential/dependency values or invoking them. For an eligible account, validate all remaining offline state before reservation. After reservation, make exactly one adapter call, parse the returned content, normalize it, then persist success. Use module-local WeakSet branding for internal errors. Never trust external name/message/code/diagnostic getters.

`runMemoryV3ShadowBackgroundSafely` awaits the injected runner, logs only a failed result's allowlisted diagnostic code, ignores normal skips and success, and converts any untrusted throw into `unknown_failure`. It always resolves so background shadow behavior cannot reject the chat path.

- [ ] **Step 5: Run Task 5 gates**

```bash
npx tsx supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/mode.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/messages.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/transport.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Expected: all pass, with zero real network/database/env access.

- [ ] **Step 6: Commit Task 5 after review approval**

```bash
git add supabase/functions/_shared/memoryV3/shadowRunner.ts supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
git commit -m "[agent] feat: orchestrate Memory V3 shadow extraction"
```

Stop. Do not start Task 6 automatically.

---

### Task 6: `staysee-chat` Background Composition

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts` in the existing imports and background summary block around the `bgShould` decision
- Create: `supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts`

**Interfaces:**
- Consumes: `createMemoryV3MessageLoader`, `createMemoryV3ShadowStore`, `createMemoryV3OpenRouterAdapter`, `runMemoryV3Shadow`
- Produces no new public runtime API
- Runtime-owned dependencies: `Deno.env.get`, service client, and `globalThis.fetch.bind(globalThis)` only at composition

- [ ] **Step 1: Write source-lock and behavior RED tests**

The wiring test reads `staysee-chat/index.ts` and requires exact imports from the Memory V3 folder, one `runMemoryV3Shadow` call inside the existing background branch after `bgShould`, and no call before the reply is assembled.

Use the required Task 5 helper for behavior tests:

```ts
export async function runMemoryV3ShadowBackgroundSafely(
  run: () => Promise<MemoryV3ShadowResult>,
  logSafe: (code: string) => void,
): Promise<void> {
  try {
    const result = await run();
    if (result.status === "failed") logSafe(result.diagnosticCode);
  } catch {
    logSafe("unknown_failure");
  }
}
```

Tests must prove: off mode invokes no loader/store/fetch; nonmatching account invokes none; summary `bgShould=false` invokes none; shadow rejection does not reject the wrapper; safe logs contain no dialogue/provider/error sentinel; and the result cannot be passed to `buildContextPacket`, `buildContextPrompt`, `runConversationSummaryRefresh`, `user_memory`, `conversation_summary`, or the HTTP response.

- [ ] **Step 2: Run wiring test and confirm RED**

```bash
npx tsx supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts
```

Expected: FAIL because the composition is absent.

- [ ] **Step 3: Wire the independent background branch**

At the existing `bgShould` boundary, create independent promises:

```ts
const summaryRefreshPromise = (async () => {
  try {
    const summaryApiKey = Deno.env.get(PROVIDERS[ACTIVE_PROVIDER].envKey);
    if (!summaryApiKey) return;

    const previousSummary = getConversationSummary(
      packetForSummary.conversationMeta
    );
    await runConversationSummaryRefresh({
      supabase: svc,
      conversationId,
      userId,
      previousSummary,
      transcript: transcriptForSummary,
      memoryHints,
      extraDurableCorrections: sameTurnDurableCorrection
        ? [sameTurnDurableCorrection]
        : undefined,
      model: {
        baseUrl: PROVIDERS[ACTIVE_PROVIDER].baseUrl,
        model: PROVIDERS[ACTIVE_PROVIDER].model,
        apiKey: summaryApiKey,
        extraHeaders: PROVIDERS[ACTIVE_PROVIDER].extraHeaders,
      },
      diag: isMemoryDiagConversation(
        packetForSummary.conversationMeta?.title ?? null
      ) || isSummaryDiagConversation(
        packetForSummary.conversationMeta?.title ?? null
      )
        ? {
            enabled: isMemoryDiagConversation(
              packetForSummary.conversationMeta?.title ?? null
            ),
            conversationId,
            summaryDiag: isSummaryDiagConversation(
              packetForSummary.conversationMeta?.title ?? null
            )
              ? {
                  enabled: true,
                  clientType: "service",
                  path: "background",
                  title:
                    packetForSummary.conversationMeta?.title ??
                    null,
                }
              : undefined,
          }
        : undefined,
    });
  } catch (sumErr) {
    console.error("[staysee-chat] summary update failed:", sumErr);
  }
})();

const memoryV3ShadowPromise = runMemoryV3ShadowBackgroundSafely(
  () => runMemoryV3Shadow({
    rawMode: Deno.env.get("STAYSEE_MEMORY_V3_MODE"),
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
);

await Promise.allSettled([summaryRefreshPromise, memoryV3ShadowPromise]);
```

This is a refactor of the existing lines after the `bgShould` check, not a new summary helper. Preserve the existing `runConversationSummaryRefresh` arguments, diagnostic expression, and exact `"[staysee-chat] summary update failed:"` catch log; the only local rename is `apiKey` to `summaryApiKey` so the Memory V3 branch cannot capture it accidentally. The existing outer catch continues to cover transcript/decision preparation before the two promises are created. Do not log Memory V3 skip results.

- [ ] **Step 4: Prove current memory and reply isolation**

Run source assertions that:

```text
memory_v3_shadow_runs and memory_v3_shadow_identities occur only in the migration/store path
runMemoryV3Shadow occurs only in the background composition and tests
Memory V3 extraction is never an argument to context or summary functions
AI_AUDIT_MEMORY_VERSION remains structured-memory-v1
```

The current response assembly and return statements must have no diff except formatting required by the background refactor.

- [ ] **Step 5: Run Task 6 gates**

```bash
npx tsx supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
npm run typecheck
npm run lint
npm run build
node --test scripts/memory-v3-pilot/*.test.mjs
git diff --check
```

Expected: all available gates pass. No command reads `.env`, calls OpenRouter, or deploys.

- [ ] **Step 6: Commit Task 6 after review approval**

```bash
git add supabase/functions/staysee-chat/index.ts supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts
git commit -m "[agent] feat: wire Memory V3 production shadow path"
```

Stop. Do not deploy and do not start Task 7 automatically.

---

### Task 7: Documentation, Full Offline Gate, and Deployment STOP

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Test: all Task 1–6 case files and existing Memory V3 suites

**Interfaces:**
- Documents the completed but inactive shadow implementation
- Does not add a deployment script, live command, or activation command

- [ ] **Step 1: Write documentation assertions before README changes**

Add the documentation assertions to `stayseeChatWiring.cases.test.ts`, scoped to a new README section headed `## Memory V3 production shadow pilot (inactive)`:

```ts
for (const required of [
  "default off",
  "one exact account UUID",
  "four reservations per UTC day",
  "20,000 UTF-8 bytes",
  "32,768 input-token accounting reservation",
  "$0.029076",
  "$0.116304",
  "planning ceiling, not actual billing",
  "30 days",
  "identity ledger remains until account or conversation deletion",
  "does not affect replies",
  "does not write conversation_summary or user_memory",
  "not deployed",
  "no production shadow call has been authorized",
]) {
  assert(section.includes(required), `README missing: ${required}`);
}
```

Run the test and confirm it fails because the section is absent.

- [ ] **Step 2: Document the inactive implementation**

Add a concise section containing:

- exact mode and allowlist environment variable names, without a real UUID;
- model, extractor version, source limit, enforceable byte limit, 32,768-token accounting reservation, output limit, and daily cap;
- `$0.029076` per-run and `$0.116304` four-run planning ceilings, explicitly not measured usage or actual billing guarantees;
- separate service-only durable identity ledger plus 30-day run-payload table; the ledger contains no dialogue, claims, evidence, output, or diagnostics and remains only until account/conversation deletion;
- default-off and one-account scope;
- zero effect on replies/current memory/UI;
- no migration deployment, function deployment, env change, production data read, or provider call performed by implementation;
- the required future order: deploy with mode off, verify RLS/retention/zero calls, configure one UUID while off, obtain separate paid activation approval, then enable shadow.

Do not include an executable activation command, actual UUID, env-file path, API key, or provider response.

- [ ] **Step 3: Run the complete offline gate**

```bash
npx tsx supabase/functions/_shared/memoryV3/mode.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/messages.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/prompt.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/transport.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/shadowStore.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/shadowRunner.cases.test.ts
npx tsx supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts
node --test scripts/memory-v3-pilot/*.test.mjs
npm run typecheck
npm run lint
npm run build
git diff --check
```

Recompute and compare the spec and six artifact hashes from Global Constraints. Verify `git status --short` contains only intended tracked changes plus the six untouched artifacts.

- [ ] **Step 4: Run privacy and scope scans**

Scan the new/modified files for real API keys, JWTs, emails, user UUIDs, raw provider bodies, `process.env`, Supabase production/staging project references, automatic execution, retries, repair calls, and writes to legacy memory.

The only runtime global network access allowed is the injected `globalThis.fetch.bind(globalThis)` at the `staysee-chat` composition root. The library modules must contain no global fetch fallback.

- [ ] **Step 5: Commit Task 7 after review approval**

```bash
git add scripts/memory-v3-pilot/README.md supabase/functions/_shared/memoryV3/stayseeChatWiring.cases.test.ts
git commit -m "[agent] docs: document inactive Memory V3 shadow pilot"
```

- [ ] **Step 6: Final STOP**

Report the commit chain, test totals, unchanged hashes, and final status. Do not deploy the migration or function. Do not read `.env`. Do not configure the account UUID. Do not enable shadow mode. Do not call OpenRouter. Those operations require separate explicit authorization after implementation review.

## Spec Coverage Matrix

| Spec requirement | Implemented in |
|---|---|
| Default-off exact-account gate | Task 1 |
| Ownership-scoped bounded message source | Task 1 |
| V2 layered contract and typed evidence | Task 2 |
| Static prompt and injection boundary | Task 2 |
| One-call OpenRouter privacy boundary | Task 3 |
| Durable identity ledger, 30-day run table, RLS, uniqueness, daily cap | Task 4 |
| Run-payload purge without weakening at-most-once identity, plus deployment prerequisite | Task 4 and Task 7 documentation |
| Canonical input hash and ordered preflight | Task 5 |
| Safe diagnostics and fail-open behavior | Tasks 3–6 |
| No reply/current-memory effect | Task 6 |
| Offline-only implementation and explicit deployment gates | Task 7 |

## Execution Checkpoints

Every task ends in a STOP and independent review. Commit and push authorization apply only to the completed task under review. They never authorize the next task, deployment, environment changes, database access, production data access, or paid provider calls.
