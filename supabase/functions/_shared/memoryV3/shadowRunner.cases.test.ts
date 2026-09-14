import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MEMORY_V3_EXTRACTOR_VERSION,
  MEMORY_V3_MODEL,
} from "./contract.ts";
import type { MemoryV3DialogueMessage } from "./messages.ts";
import type { MemoryV3ShadowStore } from "./shadowStore.ts";
import { createMemoryV3OpenRouterAdapter } from "./transport.ts";
import {
  projectSafeMemoryV3ShadowDiagnostic,
  runMemoryV3Shadow,
  runMemoryV3ShadowBackgroundSafely,
} from "./shadowRunner.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RAW_SECRET = "RAW_SHADOW_SECRET_SENTINEL";

const emptyResponse = JSON.stringify({
  layerDecisions: [
    { kind: "event", decision: "omit", itemRefs: [] },
    { kind: "recurrence", decision: "omit", itemRefs: [] },
    { kind: "hypothesis", decision: "omit", itemRefs: [] },
  ],
  items: [],
  evidence: [],
});

function messages(text = "Сегодня я вышла на прогулку."): MemoryV3DialogueMessage[] {
  return [{
    id: MESSAGE_ID,
    role: "user",
    text,
    createdAt: "2026-09-05T10:00:00.000Z",
  }];
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls = {
    load: 0,
    factory: 0,
    model: 0,
    reserve: 0,
    succeed: 0,
    fail: 0,
  };
  const reservations: unknown[] = [];
  const successes: unknown[] = [];
  const failures: unknown[] = [];
  const store: MemoryV3ShadowStore = {
    async reserve(input) {
      calls.reserve += 1;
      reservations.push(input);
      return { status: "reserved", runId: RUN_ID };
    },
    async succeed(input) {
      calls.succeed += 1;
      successes.push(input);
    },
    async fail(input) {
      calls.fail += 1;
      failures.push(input);
    },
  };
  const options = {
    rawMode: "shadow",
    rawAllowedUserId: USER_ID,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    apiKey: "test-key",
    async loadMessages() {
      calls.load += 1;
      return messages();
    },
    store,
    modelAdapterFactory() {
      calls.factory += 1;
      return async () => {
        calls.model += 1;
        return {
          content: emptyResponse,
          usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.0001 },
        };
      };
    },
    ...overrides,
  };
  return { options, calls, reservations, successes, failures, store };
}

function assertNoWork(calls: ReturnType<typeof harness>["calls"]) {
  assert.deepEqual(calls, {
    load: 0,
    factory: 0,
    model: 0,
    reserve: 0,
    succeed: 0,
    fail: 0,
  });
}

describe("Memory V3 shadow runner ordered preflight", () => {
  it("runs one successful extraction and persists only normalized data", async () => {
    const h = harness();
    const result = await runMemoryV3Shadow(h.options);
    assert.deepEqual(result, { status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0 });
    assert.deepEqual(h.calls, { load: 1, factory: 1, model: 1, reserve: 1, succeed: 1, fail: 0 });
    assert.equal(h.reservations.length, 1);
    const reservation = h.reservations[0] as Record<string, unknown>;
    assert.equal(reservation.extractorVersion, MEMORY_V3_EXTRACTOR_VERSION);
    assert.equal(reservation.model, MEMORY_V3_MODEL);
    assert.match(String(reservation.inputHash), /^[0-9a-f]{64}$/);
    assert.equal(reservation.sourceLastMessageId, MESSAGE_ID);
    assert.equal(reservation.messageCount, 1);
    assert.equal(reservation.userMessageCount, 1);
    const success = h.successes[0] as Record<string, unknown>;
    assert.equal(success.runId, RUN_ID);
    assert.deepEqual(success.usage, { promptTokens: 10, completionTokens: 5, costUsd: 0.0001 });
    assert.equal(JSON.stringify(success).includes("test-key"), false);
  });

  it("keeps the reviewed success stages in one strict source order", () => {
    const source = readFileSync(new URL("./shadowRunner.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function runMemoryV3Shadow("));
    const offsets = [
      body.indexOf("resolveMemoryV3ShadowEligibility("),
      body.indexOf("projected.loadMessages"),
      body.indexOf("buildMemoryV3ExtractorRequest("),
      body.indexOf("hashDialogue("),
      body.indexOf("await reserve("),
      body.indexOf("const adapter = (projected.modelAdapterFactory"),
      body.indexOf("normalizeMemoryV3LayeredResponse("),
      body.indexOf("await succeed("),
    ];
    assert.equal(offsets.every((offset) => offset >= 0), true, String(offsets));
    assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
  });

  it("uses a deterministic content-sensitive canonical input hash", async () => {
    const first = harness();
    const second = harness();
    const changed = harness({ loadMessages: async () => messages("Другой синтетический факт.") });
    await runMemoryV3Shadow(first.options);
    await runMemoryV3Shadow(second.options);
    await runMemoryV3Shadow(changed.options);
    const firstHash = (first.reservations[0] as Record<string, unknown>).inputHash;
    const secondHash = (second.reservations[0] as Record<string, unknown>).inputHash;
    const changedHash = (changed.reservations[0] as Record<string, unknown>).inputHash;
    assert.equal(firstHash, secondHash);
    assert.notEqual(firstHash, changedHash);
    assert.match(String(firstHash), /^[0-9a-f]{64}$/);
  });

  it("stops safely before reservation when canonical hashing fails", async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    assert.ok(cryptoDescriptor);
    const h = harness();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      enumerable: true,
      value: {
        subtle: {
          async digest() {
            throw new Error(RAW_SECRET);
          },
        },
      },
    });
    try {
      const result = await runMemoryV3Shadow(h.options);
      assert.deepEqual(result, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });
      assert.equal(h.calls.load, 1);
      assert.equal(h.calls.reserve, 0);
      assert.equal(h.calls.factory, 0);
      assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    } finally {
      Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    }
  });

  it("skips disabled and non-allowlisted users before inspecting credentials or dependencies", async () => {
    for (const [overrides, expected] of [
      [{ rawMode: "off" }, { status: "skipped", reason: "disabled" }],
      [{ rawMode: "lifecycle_shadow" }, { status: "skipped", reason: "disabled" }],
      [{ userId: OTHER_USER_ID }, { status: "skipped", reason: "user_not_allowlisted" }],
      [{ rawAllowedUserId: "invalid" }, { status: "skipped", reason: "user_not_allowlisted" }],
    ] as const) {
      const h = harness({
        ...overrides,
        apiKey: 123,
        loadMessages: null,
        store: null,
        modelAdapterFactory: null,
      });
      assert.deepEqual(await runMemoryV3Shadow(h.options), expected);
      assertNoWork(h.calls);
    }
  });

  it("rejects top-level accessors and symbols without executing getters", async () => {
    let getterCalls = 0;
    const h = harness();
    const accessor = { ...h.options } as Record<PropertyKey, unknown>;
    Object.defineProperty(accessor, "apiKey", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return RAW_SECRET;
      },
    });
    const first = await runMemoryV3Shadow(accessor as never);
    assert.deepEqual(first, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });
    assert.equal(getterCalls, 0);
    assertNoWork(h.calls);

    const symbol = { ...h.options, [Symbol("secret")]: RAW_SECRET };
    const second = await runMemoryV3Shadow(symbol as never);
    assert.deepEqual(second, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });
    assertNoWork(h.calls);
  });

  it("stops all eligible invalid states before reservation and provider", async () => {
    const cases: Array<Record<string, unknown>> = [
      { apiKey: null },
      { conversationId: "invalid" },
      { loadMessages: null },
      { store: null },
      { modelAdapterFactory: null },
      { loadMessages: async () => { throw new Error(RAW_SECRET); } },
      { loadMessages: async () => [{ ...messages()[0], role: "assistant" }] },
      { loadMessages: async () => Array.from({ length: 61 }, (_, index) => ({
        ...messages()[0],
        id: `${String(index).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`,
      })) },
      { loadMessages: async () => messages("x".repeat(25_000)) },
    ];
    for (const overrides of cases) {
      const h = harness(overrides);
      const result = await runMemoryV3Shadow(h.options);
      assert.equal(result.status, "failed");
      assert.equal(h.calls.reserve, 0);
      assert.equal(h.calls.factory, 0);
      assert.equal(h.calls.model, 0);
      assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    }
  });
});

describe("Memory V3 shadow reservation and one-call behavior", () => {
  it("maps duplicate and daily cap to skips without creating an adapter", async () => {
    for (const status of ["duplicate", "daily_cap"] as const) {
      const h = harness({
        store: {
          ...harness().store,
          async reserve() {
            h.calls.reserve += 1;
            return { status };
          },
        },
      });
      const result = await runMemoryV3Shadow(h.options);
      assert.deepEqual(result, { status: "skipped", reason: status });
      assert.equal(h.calls.model, 0);
      assert.equal(h.calls.factory, 0);
    }
  });

  it("returns reservation_failed when reserve throws", async () => {
    const h = harness();
    h.options.store = {
      ...h.store,
      async reserve() {
        h.calls.reserve += 1;
        throw new Error(RAW_SECRET);
      },
    };
    const result = await runMemoryV3Shadow(h.options);
    assert.deepEqual(result, { status: "failed", runId: null, diagnosticCode: "reservation_failed" });
    assert.equal(h.calls.model, 0);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });

  it("allows only one concurrent provider call for one canonical input", async () => {
    let reserved = false;
    let modelCalls = 0;
    const store: MemoryV3ShadowStore = {
      async reserve() {
        if (reserved) return { status: "duplicate" };
        reserved = true;
        return { status: "reserved", runId: RUN_ID };
      },
      async succeed() {},
      async fail() {},
    };
    const common = {
      ...harness().options,
      store,
      modelAdapterFactory: () => async () => {
        modelCalls += 1;
        return { content: emptyResponse, usage: null };
      },
    };
    const results = await Promise.all([runMemoryV3Shadow(common), runMemoryV3Shadow(common)]);
    assert.deepEqual(results.map((entry) => entry.status).sort(), ["skipped", "succeeded"]);
    assert.equal(modelCalls, 1);
  });

  it("records adapter, parse, shape, and contract failures once without retry", async () => {
    const failures = [
      { content: null, expected: "transport_failed", throws: true },
      { content: "{", expected: "extractor_parse_invalid" },
      { content: JSON.stringify({ layerDecisions: [], items: [] }), expected: "extractor_shape_invalid" },
      { content: JSON.stringify({
        layerDecisions: [
          { kind: "event", decision: "omit", itemRefs: [] },
          { kind: "recurrence", decision: "omit", itemRefs: [] },
          { kind: "hypothesis", decision: "omit", itemRefs: [] },
        ],
        items: [{ itemRef: "x", kind: "event", claim: "x", status: "impossible", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, alternative: null }],
        evidence: [],
      }), expected: "extractor_contract_invalid" },
    ];
    for (const fixture of failures) {
      const h = harness({
        modelAdapterFactory: () => async () => {
          h.calls.model += 1;
          if (fixture.throws) throw new Error(RAW_SECRET);
          return { content: fixture.content as string, usage: null };
        },
      });
      const result = await runMemoryV3Shadow(h.options);
      assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: fixture.expected });
      assert.equal(h.calls.model, 1);
      assert.equal(h.calls.fail, 1);
      assert.equal(h.calls.succeed, 0);
      assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    }
  });

  it("classifies a malformed adapter result as a provider response failure", async () => {
    for (const adapterResult of [
      { content: null, usage: null },
      { content: emptyResponse, usage: null, extra: RAW_SECRET },
    ]) {
      const h = harness({
        modelAdapterFactory: () => async () => {
          h.calls.model += 1;
          return adapterResult as never;
        },
      });
      const result = await runMemoryV3Shadow(h.options);
      assert.deepEqual(result, {
        status: "failed",
        runId: RUN_ID,
        diagnosticCode: "provider_response_invalid",
      });
      assert.equal(h.calls.model, 1);
      assert.equal(h.calls.fail, 1);
      assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    }
  });

  it("preserves only a branded transport diagnostic from the real adapter", async () => {
    let fetchCalls = 0;
    const h = harness({
      modelAdapterFactory: (apiKey: string) => createMemoryV3OpenRouterAdapter({
        apiKey,
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ error: { message: RAW_SECRET } }), { status: 429 });
        }) as typeof fetch,
      }),
    });
    const result = await runMemoryV3Shadow(h.options);
    assert.deepEqual(result, {
      status: "failed",
      runId: RUN_ID,
      diagnosticCode: "provider_http_4xx",
    });
    assert.equal(fetchCalls, 1);
    assert.equal(h.calls.fail, 1);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });

  it("reports completion_write_failed after one paid call and never retries", async () => {
    const h = harness();
    h.options.store = {
      ...h.store,
      async succeed() {
        h.calls.succeed += 1;
        throw new Error(RAW_SECRET);
      },
    };
    const result = await runMemoryV3Shadow(h.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "completion_write_failed" });
    assert.equal(h.calls.model, 1);
    assert.equal(h.calls.succeed, 1);
    assert.equal(h.calls.fail, 0);
  });
});

describe("Memory V3 shadow safe diagnostics", () => {
  it("does not trust spoofed names, codes, accessors, or provider secrets", () => {
    let getterCalls = 0;
    const spoof = new Error(RAW_SECRET) as Error & { diagnosticCode?: string };
    spoof.name = "MemoryV3ShadowError";
    Object.defineProperty(spoof, "diagnosticCode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "provider_http_4xx";
      },
    });
    assert.equal(projectSafeMemoryV3ShadowDiagnostic(spoof), null);
    assert.equal(getterCalls, 0);
  });

  it("background wrapper logs only safe failures and always resolves", async () => {
    const logged: string[] = [];
    await runMemoryV3ShadowBackgroundSafely(
      async () => ({ status: "failed", runId: null, diagnosticCode: "prompt_too_large" }),
      (code) => logged.push(code),
    );
    await runMemoryV3ShadowBackgroundSafely(
      async () => ({ status: "skipped", reason: "disabled" }),
      (code) => logged.push(code),
    );
    await runMemoryV3ShadowBackgroundSafely(
      async () => { throw new Error(RAW_SECRET); },
      (code) => logged.push(code),
    );
    await runMemoryV3ShadowBackgroundSafely(
      async () => { throw new Error(RAW_SECRET); },
      () => { throw new Error(RAW_SECRET); },
    );
    assert.deepEqual(logged, ["prompt_too_large", "unknown_failure"]);
  });
});
