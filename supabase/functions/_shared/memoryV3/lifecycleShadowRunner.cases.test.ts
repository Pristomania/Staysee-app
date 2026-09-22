import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createEmptyMemoryV3LifecycleState } from "./lifecycleReducer.ts";
import type { MemoryV3LifecycleStore } from "./lifecycleStore.ts";
import { createMemoryV3LifecycleOpenRouterAdapter } from "./lifecycleTransport.ts";
import {
  runMemoryV3LifecycleShadow,
  runMemoryV3LifecycleShadowBackgroundSafely,
} from "./lifecycleShadowRunner.ts";
import { buildMemoryV3ExtractorRequest } from "./prompt.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREATED_AT = "2026-09-15T10:00:00Z";
const RAW_SECRET = "RAW_LIFECYCLE_RUNNER_SECRET_SENTINEL";

function extractorContent(claim = "Любит утренние прогулки") {
  return JSON.stringify({
    layerDecisions: [
      { kind: "event", decision: "emit", itemRefs: ["item:1"] },
      { kind: "recurrence", decision: "omit", itemRefs: [] },
      { kind: "hypothesis", decision: "omit", itemRefs: [] },
    ],
    items: [{
      itemRef: "item:1",
      kind: "event",
      claim,
      status: "active",
      sensitivity: "normal",
      eventTimeStart: null,
      eventTimeEnd: null,
      alternative: null,
    }],
    evidence: [{
      itemRef: "item:1",
      sourceMessageId: MESSAGE_ID,
      relation: "supports",
      supportType: null,
      episodeKey: "episode:m1",
    }],
  });
}

const proposalContent = JSON.stringify({
  operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null }],
});
const emptyExtractorContent = JSON.stringify({
  layerDecisions: [
    { kind: "event", decision: "omit", itemRefs: [] },
    { kind: "recurrence", decision: "omit", itemRefs: [] },
    { kind: "hypothesis", decision: "omit", itemRefs: [] },
  ],
  items: [],
  evidence: [],
});

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const reserveInputs: unknown[] = [];
  const casInputs: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  const store: MemoryV3LifecycleStore = {
    async reserve(input) {
      calls.push("reserve");
      reserveInputs.push(input);
      return {
        status: "reserved",
        runId: RUN_ID,
        expectedStateRevision: 0,
        state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      };
    },
    async fail(input) {
      calls.push(`fail:${input.diagnosticCode}`);
    },
    async compareAndSwap(input) {
      calls.push("cas");
      casInputs.push(input);
      return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
    },
  };
  const options = {
    rawMode: "lifecycle_shadow",
    rawAllowedUserId: USER_ID,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    apiKey: "test-key",
    async loadMessages() {
      calls.push("messages");
      return [{ id: MESSAGE_ID, role: "user" as const, text: "Я люблю утренние прогулки", createdAt: CREATED_AT }];
    },
    store,
    extractorAdapterFactory() {
      calls.push("extractorFactory");
      return async () => {
        calls.push("extractor");
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { content: extractorContent(), usage: null };
      };
    },
    reconcilerAdapterFactory() {
      calls.push("reconcilerFactory");
      return async () => {
        calls.push("reconciler");
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { rawContent: proposalContent, usage: null };
      };
    },
    ...overrides,
  };
  return { options, calls, store, reserveInputs, casInputs, get maxActive() { return maxActive; } };
}

describe("Memory V3 lifecycle shadow runner gates", () => {
  it("skips disabled and non-allowlisted accounts before database or providers", async () => {
    for (const overrides of [
      { rawMode: "off" },
      { rawMode: "lifecycle_shadow", userId: OTHER_USER_ID },
    ]) {
      const test = harness(overrides);
      const result = await runMemoryV3LifecycleShadow(test.options);
      assert.equal(result.status, "skipped");
      assert.deepEqual(test.calls, []);
    }
  });

  it("allows lifecycle_all for canonical accounts without an allowlist", async () => {
    for (const userId of [USER_ID, OTHER_USER_ID]) {
      const test = harness({
        rawMode: "lifecycle_all",
        rawAllowedUserId: undefined,
        userId,
        store: {
          ...harness().store,
          async reserve(input) {
            test.calls.push("reserve");
            test.reserveInputs.push(input);
            return { status: "duplicate" as const };
          },
        },
      });

      assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
        status: "skipped",
        reason: "duplicate",
      });
      assert.deepEqual(test.calls, ["messages", "reserve"]);
      assert.equal((test.reserveInputs[0] as { userId: string }).userId, userId);
    }
  });

  it("rejects a malformed account in lifecycle_all before database or providers", async () => {
    const test = harness({
      rawMode: "lifecycle_all",
      rawAllowedUserId: undefined,
      userId: "not-a-user-id",
    });

    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "skipped",
      reason: "user_not_allowlisted",
    });
    assert.deepEqual(test.calls, []);
  });

  it("rejects invalid identifiers and dependencies before loading messages", async () => {
    for (const overrides of [
      { conversationId: "bad" },
      { apiKey: "" },
      { loadMessages: 1 },
      { extractorAdapterFactory: null },
      { reconcilerAdapterFactory: null },
      { store: {} },
    ]) {
      const test = harness(overrides);
      assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
        status: "failed", runId: null, diagnosticCode: "invalid_source",
      });
      assert.deepEqual(test.calls, []);
    }
  });

  it("rejects top-level accessors and oversized extractor requests with zero database/provider work", async () => {
    let getterCalls = 0;
    const accessor = harness();
    Object.defineProperty(accessor.options, "apiKey", {
      enumerable: true,
      get() { getterCalls += 1; return "test-key"; },
    });
    assert.deepEqual(await runMemoryV3LifecycleShadow(accessor.options), {
      status: "failed", runId: null, diagnosticCode: "unknown_failure",
    });
    assert.equal(getterCalls, 0);
    assert.deepEqual(accessor.calls, []);

    const oversized = harness({
      async loadMessages() {
        oversized.calls.push("messages");
        return [{ id: MESSAGE_ID, role: "user" as const, text: "x".repeat(21_000), createdAt: CREATED_AT }];
      },
    });
    assert.deepEqual(await runMemoryV3LifecycleShadow(oversized.options), {
      status: "failed", runId: null, diagnosticCode: "invalid_source",
    });
    assert.deepEqual(oversized.calls, ["messages"]);
  });

  it("safe-wraps revoked and throwing top-level proxies without leaking trap messages", async () => {
    const revoked = Proxy.revocable(harness().options, {});
    revoked.revoke();
    const revokedResult = await runMemoryV3LifecycleShadow(revoked.proxy);
    assert.deepEqual(revokedResult, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });

    const throwing = new Proxy(harness().options, {
      getPrototypeOf() { throw new Error(RAW_SECRET); },
    });
    const throwingResult = await runMemoryV3LifecycleShadow(throwing);
    assert.deepEqual(throwingResult, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });
    assert.equal(JSON.stringify([revokedResult, throwingResult]).includes(RAW_SECRET), false);
  });
});

describe("Memory V3 lifecycle shadow ordered orchestration", () => {
  it("uses the largest recent contiguous dialogue suffix that fits the extractor byte cap", async () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      id: index === 59
        ? MESSAGE_ID
        : `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      role: index % 2 === 1 ? "user" as const : "assistant" as const,
      text: `${index % 2 === 1 ? "Пользователь" : "Ассистент"} ${index} ${"я".repeat(600)}`,
      createdAt: `2026-09-15T10:${String(index).padStart(2, "0")}:00Z`,
    }));
    messages[59].text = `Я люблю утренние прогулки ${"я".repeat(600)}`;
    const original = structuredClone(messages);
    const caseId = `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`;
    assert.equal(
      new TextEncoder().encode(JSON.stringify(buildMemoryV3ExtractorRequest({ caseId, messages }))).byteLength > 20_000,
      true,
    );

    let extractorRequest: unknown;
    const test = harness({
      async loadMessages() {
        test.calls.push("messages");
        return messages;
      },
      extractorAdapterFactory() {
        test.calls.push("extractorFactory");
        return async (request: unknown) => {
          test.calls.push("extractor");
          extractorRequest = request;
          return { content: extractorContent(), usage: null };
        };
      },
    });

    const result = await runMemoryV3LifecycleShadow(test.options);
    assert.equal(result.status, "succeeded");
    assert.ok(extractorRequest && typeof extractorRequest === "object");
    const input = (extractorRequest as { input: { messages: typeof messages } }).input;
    assert.equal(input.messages.length < messages.length, true);
    assert.equal(input.messages.at(-1)?.id, MESSAGE_ID);
    assert.equal(input.messages.some((message) => message.role === "user"), true);
    assert.deepEqual(input.messages, messages.slice(messages.length - input.messages.length));
    assert.equal(new TextEncoder().encode(JSON.stringify(extractorRequest)).byteLength <= 20_000, true);

    const oneMore = messages.slice(messages.length - input.messages.length - 1);
    assert.equal(
      new TextEncoder().encode(JSON.stringify(buildMemoryV3ExtractorRequest({ caseId, messages: oneMore }))).byteLength > 20_000,
      true,
    );
    assert.equal((test.reserveInputs[0] as { messageCount: number }).messageCount, input.messages.length);
    assert.deepEqual(messages, original);
  });

  it("reserves before exactly one sequential extractor and reconciler call, then CAS", async () => {
    const test = harness();
    const result = await runMemoryV3LifecycleShadow(test.options);
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.itemCount, 1);
    assert.equal(result.evidenceCount, 1);
    assert.equal(result.transitionCount, 1);
    assert.equal(result.stateRevision, 1);
    assert.deepEqual(test.calls, [
      "messages", "reserve", "extractorFactory", "extractor",
      "reconcilerFactory", "reconciler", "cas",
    ]);
    assert.equal(test.maxActive, 1);
    assert.equal(test.reserveInputs.length, 1);
    assert.deepEqual(test.reserveInputs[0], {
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      pipelineVersion: "memory-v3-lifecycle-shadow-v1",
      extractorVersion: "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
      reconcilerVersion: "memory-v3-lifecycle-reconciler-v1",
      model: "google/gemini-3.7-flash",
      inputHash: (test.reserveInputs[0] as { inputHash: string }).inputHash,
      sourceLastMessageId: MESSAGE_ID,
      sourceLastCreatedAt: CREATED_AT,
      messageCount: 1,
      userMessageCount: 1,
    });
    assert.match((test.reserveInputs[0] as { inputHash: string }).inputHash, /^[0-9a-f]{64}$/);
    assert.equal(test.casInputs.length, 1);
    const cas = test.casInputs[0] as Record<string, unknown>;
    assert.equal(cas.expectedStateRevision, 0);
    assert.equal((cas.state as { stateRevision: number }).stateRevision, 1);
    assert.equal(cas.changed, true);
    assert.equal((cas.operations as unknown[]).length, 1);
    assert.equal((cas.transitions as unknown[]).length, 1);
    assert.equal(test.calls.some((entry) => entry.startsWith("fail:")), false);
  });

  it("uses a deterministic content-sensitive canonical input identity", async () => {
    const hashes: string[] = [];
    for (const text of ["Первый текст", "Второй текст"]) {
      const test = harness({
        async loadMessages() {
          return [{ id: MESSAGE_ID, role: "user" as const, text, createdAt: CREATED_AT }];
        },
      });
      assert.equal((await runMemoryV3LifecycleShadow(test.options)).status, "succeeded");
      hashes.push((test.reserveInputs[0] as { inputHash: string }).inputHash);
    }
    assert.match(hashes[0], /^[0-9a-f]{64}$/);
    assert.notEqual(hashes[0], hashes[1]);
  });

  it("keeps the reserved revision for an unchanged empty extraction", async () => {
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: null }),
      reconcilerAdapterFactory: () => async () => ({ rawContent: JSON.stringify({ operations: [] }), usage: null }),
    });
    const result = await runMemoryV3LifecycleShadow(test.options);
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0,
      transitionCount: 0, stateRevision: 0,
    });
    const cas = test.casInputs[0] as Record<string, unknown>;
    assert.equal(cas.changed, false);
    assert.equal((cas.state as { stateRevision: number }).stateRevision, 0);
    assert.equal(test.calls.some((entry) => entry.startsWith("fail:")), false);
  });

  it("stops duplicate and daily-cap reservations before providers", async () => {
    for (const status of ["duplicate", "daily_cap"] as const) {
      const test = harness({
        store: {
          ...harness().store,
          async reserve() { test.calls.push("reserve"); return { status }; },
        },
      });
      assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), { status: "skipped", reason: status });
      assert.deepEqual(test.calls, ["messages", "reserve"]);
    }
  });

  it("persists extractor transport failures once without trusting spoofed diagnostics", async () => {
    const fake = Object.assign(new Error(RAW_SECRET), { diagnosticCode: "reconciler_contract_invalid" });
    const test = harness({ extractorAdapterFactory: () => async () => { test.calls.push("extractor"); throw fake; } });
    const result = await runMemoryV3LifecycleShadow(test.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "extractor_transport_failed" });
    assert.deepEqual(test.calls, ["messages", "reserve", "extractor", "fail:extractor_transport_failed"]);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });

  it("reports only a branded safe reconciler transport diagnostic while persisting the generic failure", async () => {
    const reported: string[] = [];
    const test = harness({
      reconcilerAdapterFactory: () => createMemoryV3LifecycleOpenRouterAdapter({
        apiKey: "test-key",
        fetchImpl: async () => new Response(RAW_SECRET, { status: 400 }),
      }),
    });

    const result = await runMemoryV3LifecycleShadow(test.options, (code) => reported.push(code));

    assert.deepEqual(result, {
      status: "failed",
      runId: RUN_ID,
      diagnosticCode: "reconciler_transport_failed",
    });
    assert.deepEqual(reported, ["provider_http_400"]);
    assert.equal(JSON.stringify({ result, reported }).includes(RAW_SECRET), false);
    assert.equal(test.calls.at(-1), "fail:reconciler_transport_failed");
  });

  it("maps extractor parse, shape, and contract failures without retry", async () => {
    const cases = [
      ["{", "extractor_parse_invalid"],
      [JSON.stringify({}), "extractor_shape_invalid"],
      [extractorContent(""), "extractor_contract_invalid"],
    ] as const;
    for (const [content, diagnosticCode] of cases) {
      const test = harness({ extractorAdapterFactory: () => async () => ({ content, usage: null }) });
      assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
        status: "failed", runId: RUN_ID, diagnosticCode,
      });
      assert.equal(test.calls.filter((entry) => entry === "reserve").length, 1);
      assert.equal(test.calls.some((entry) => entry.startsWith("fail:")), true);
      assert.equal(test.calls.includes("reconciler"), false);
    }
  });

  it("enforces the reconciler byte cap after extraction and before its adapter", async () => {
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: extractorContent("x".repeat(81_000)), usage: null }),
    });
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_request_too_large",
    });
    assert.equal(test.calls.includes("reconciler"), false);
    assert.equal(test.calls.at(-1), "fail:reconciler_request_too_large");
  });

  it("maps reconciler parse and contract failures and never retries", async () => {
    for (const [rawContent, diagnosticCode] of [
      ["{", "reconciler_parse_invalid"],
      [JSON.stringify({ operations: [] }), "reconciler_contract_invalid"],
    ] as const) {
      const test = harness({ reconcilerAdapterFactory: () => async () => ({ rawContent, usage: null }) });
      assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
        status: "failed", runId: RUN_ID, diagnosticCode,
      });
      assert.equal(test.calls.filter((entry) => entry === "reserve").length, 1);
      assert.equal(test.calls.at(-1), `fail:${diagnosticCode}`);
    }
  });

  it("maps a malformed reconciler envelope to shape failure", async () => {
    const test = harness({ reconcilerAdapterFactory: () => async () => ({ rawContent: "{}", usage: null }) });
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_shape_invalid",
    });
    assert.equal(test.calls.at(-1), "fail:reconciler_shape_invalid");
  });

  it("validates proposal references through the trusted bundle bindings", async () => {
    let reconcilerCalls = 0;
    const rawContent = JSON.stringify({
      operations: [{ type: "create", candidateRef: "candidate:9999", targetMemoryRef: null }],
    });
    const test = harness({ reconcilerAdapterFactory: () => async () => {
      reconcilerCalls += 1;
      return { rawContent, usage: null };
    } });
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_contract_invalid",
    });
    assert.equal(test.calls.at(-1), "fail:reconciler_contract_invalid");
    assert.equal(reconcilerCalls, 1);
  });

  it("terminalizes an oversized reserved state before either provider", async () => {
    const empty = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    for (const oversizedState of [
      { ...empty, items: Array.from({ length: 101 }, () => null) },
      { ...empty, items: [{ evidence: Array.from({ length: 501 }, () => null) }] },
    ]) {
      const test = harness();
      test.options.store = {
        ...test.store,
        async reserve() { test.calls.push("reserve"); return {
          status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0, state: oversizedState as never,
        }; },
        async fail(input) { test.calls.push(`fail:${input.diagnosticCode}`); },
      };
      assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
        status: "failed", runId: RUN_ID, diagnosticCode: "state_too_large",
      });
      assert.deepEqual(test.calls, ["messages", "reserve", "fail:state_too_large"]);
    }
  });

  it("safe-wraps a hostile reserved-state proxy and persists one reservation failure", async () => {
    const test = harness();
    const hostile = new Proxy(createEmptyMemoryV3LifecycleState({ userId: USER_ID }), {
      getOwnPropertyDescriptor() { throw new Error(RAW_SECRET); },
    });
    test.options.store = {
      ...test.store,
      async reserve() { test.calls.push("reserve"); return {
        status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0, state: hostile,
      }; },
      async fail(input) { test.calls.push(`fail:${input.diagnosticCode}`); },
    };
    const result = await runMemoryV3LifecycleShadow(test.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "reservation_failed" });
    assert.deepEqual(test.calls, ["messages", "reserve", "fail:reservation_failed"]);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });

  it("reports state_write_failed when terminal failure persistence itself fails", async () => {
    const test = harness();
    test.options.store = {
      ...test.store,
      async fail() { test.calls.push("fail"); throw new Error(RAW_SECRET); },
    };
    test.options.extractorAdapterFactory = () => async () => { test.calls.push("extractor"); throw new Error(RAW_SECRET); };
    const result = await runMemoryV3LifecycleShadow(test.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "state_write_failed" });
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    assert.equal(test.calls.filter((entry) => entry === "extractor").length, 1);
    assert.equal(test.calls.filter((entry) => entry === "fail").length, 1);
  });

  it("returns state conflict without calling fail after the terminal CAS", async () => {
    const test = harness({
      store: {
        ...harness().store,
        async reserve() {
          test.calls.push("reserve");
          return { status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0,
            state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }) };
        },
        async compareAndSwap() { test.calls.push("cas"); return { status: "state_conflict" as const }; },
        async fail(input: { diagnosticCode: string }) { test.calls.push(`fail:${input.diagnosticCode}`); },
      },
    });
    assert.deepEqual(await runMemoryV3LifecycleShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "state_conflict",
    });
    assert.equal(test.calls.at(-1), "cas");
    assert.equal(test.calls.some((entry) => entry.startsWith("fail:")), false);
  });

  it("sanitizes reservation and state-write failures", async () => {
    const reserve = harness({ store: { ...harness().store, async reserve() { throw new Error(RAW_SECRET); } } });
    assert.deepEqual(await runMemoryV3LifecycleShadow(reserve.options), {
      status: "failed", runId: null, diagnosticCode: "reservation_failed",
    });

    const cas = harness({
      store: {
        ...harness().store,
        async reserve() { return { status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0,
          state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }) }; },
        async compareAndSwap() { throw new Error(RAW_SECRET); },
      },
    });
    const result = await runMemoryV3LifecycleShadow(cas.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "state_write_failed" });
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });
});

describe("Memory V3 lifecycle background isolation", () => {
  it("logs only a closed diagnostic for failed and malformed results", async () => {
    const logged: string[] = [];
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => ({ status: "failed", runId: RUN_ID, diagnosticCode: "extractor_parse_invalid" }),
      (code) => logged.push(code),
    );
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => ({ status: "failed", runId: RUN_ID, diagnosticCode: RAW_SECRET } as never),
      (code) => logged.push(code),
    );
    assert.deepEqual(logged, ["extractor_parse_invalid", "unknown_failure"]);
    assert.equal(JSON.stringify(logged).includes(RAW_SECRET), false);
  });

  it("never rejects when run or logging throws", async () => {
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => { throw new Error(RAW_SECRET); },
      () => { throw new Error(RAW_SECRET); },
    );
  });

  it("rejects malformed safe-result shapes without trusting their diagnostic", async () => {
    const logged: string[] = [];
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => ({ status: "failed", runId: "not-a-uuid", diagnosticCode: "extractor_parse_invalid" }),
      (code) => logged.push(code),
    );
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => ({ status: "succeeded", runId: RUN_ID, itemCount: -1, evidenceCount: 0,
        transitionCount: 0, stateRevision: 0 }),
      (code) => logged.push(code),
    );
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => ({ status: "failed", runId: null, diagnosticCode: "state_conflict" }),
      (code) => logged.push(code),
    );
    await runMemoryV3LifecycleShadowBackgroundSafely(
      async () => ({ status: "succeeded", runId: RUN_ID, itemCount: 101, evidenceCount: 0,
        transitionCount: 0, stateRevision: 0 }),
      (code) => logged.push(code),
    );
    assert.deepEqual(logged, ["unknown_failure", "unknown_failure", "unknown_failure", "unknown_failure"]);
  });
});

describe("Memory V3 lifecycle source isolation", () => {
  it("passes an empty trusted-forget list and never imports a legacy writer", () => {
    const source = readFileSync(new URL("./lifecycleShadowRunner.ts", import.meta.url), "utf8");
    assert.match(source, /trustedForgetMemoryKeys:\s*\[\]/);
    assert.equal(source.includes("conversation_summary"), false);
    assert.equal(source.includes("user_memory"), false);
    assert.equal(source.includes("shadowStore"), false);
    assert.equal(source.includes("globalThis.fetch"), false);
    assert.equal(source.includes("process.env"), false);
    assert.equal(source.includes("Deno.env"), false);
  });
});
