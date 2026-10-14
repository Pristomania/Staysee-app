import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createEmptyMemoryV3DialogueState } from "./dialogueReducer.ts";
import type { MemoryV3DialogueStore } from "./dialogueStore.ts";
import { createMemoryV3DialogueOpenRouterAdapter } from "./dialogueTransport.ts";
import { createMemoryV3OpenRouterAdapter } from "./transport.ts";
import {
  runMemoryV3DialogueShadow,
  runMemoryV3DialogueShadowBackgroundSafely,
} from "./dialogueShadowRunner.ts";
import {
  MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION,
  MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
  buildMemoryV3DialogueExtractorRequest,
} from "./dialogueExtractorPrompt.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREATED_AT = "2026-09-15T10:00:00Z";
const RAW_SECRET = "RAW_DIALOGUE_RUNNER_SECRET_SENTINEL";

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
  operations: [{
    type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic: "person",
    supersedesMemoryRef: null,
  }],
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
  const failInputs: unknown[] = [];
  const extractorRequests: unknown[] = [];
  const cursorInputs: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  const store: MemoryV3DialogueStore = {
    async reserve(input) {
      calls.push("reserve");
      reserveInputs.push(input);
      return {
        status: "reserved",
        runId: RUN_ID,
        expectedStateRevision: 0,
        state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      };
    },
    async fail(input) {
      calls.push(`fail:${input.diagnosticCode}`);
      failInputs.push(input);
    },
    async compareAndSwap(input) {
      calls.push("cas");
      casInputs.push(input);
      return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
    },
    async lastSucceededCursor(input) {
      cursorInputs.push(input);
      return null;
    },
  };
  const options = {
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
      return async (request: unknown) => {
        calls.push("extractor");
        extractorRequests.push(request);
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
  return { options, calls, store, reserveInputs, casInputs, failInputs, extractorRequests, cursorInputs, get maxActive() { return maxActive; } };
}

describe("Memory V3 dialogue shadow runner gates", () => {
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
      assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
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
    assert.deepEqual(await runMemoryV3DialogueShadow(accessor.options), {
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
    assert.deepEqual(await runMemoryV3DialogueShadow(oversized.options), {
      status: "failed", runId: null, diagnosticCode: "invalid_source",
    });
    assert.deepEqual(oversized.calls, ["messages"]);
  });

  it("safe-wraps revoked and throwing top-level proxies without leaking trap messages", async () => {
    const revoked = Proxy.revocable(harness().options, {});
    revoked.revoke();
    const revokedResult = await runMemoryV3DialogueShadow(revoked.proxy);
    assert.deepEqual(revokedResult, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });

    const throwing = new Proxy(harness().options, {
      getPrototypeOf() { throw new Error(RAW_SECRET); },
    });
    const throwingResult = await runMemoryV3DialogueShadow(throwing);
    assert.deepEqual(throwingResult, { status: "failed", runId: null, diagnosticCode: "unknown_failure" });
    assert.equal(JSON.stringify([revokedResult, throwingResult]).includes(RAW_SECRET), false);
  });
});

describe("Memory V3 dialogue shadow ordered orchestration", () => {
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
      new TextEncoder().encode(JSON.stringify(buildMemoryV3DialogueExtractorRequest({ caseId, messages }))).byteLength > 20_000,
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

    const result = await runMemoryV3DialogueShadow(test.options);
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
      new TextEncoder().encode(JSON.stringify(buildMemoryV3DialogueExtractorRequest({ caseId, messages: oneMore }))).byteLength > 20_000,
      true,
    );
    assert.equal((test.reserveInputs[0] as { messageCount: number }).messageCount, input.messages.length);
    assert.deepEqual(messages, original);
  });

  it("reserves before exactly one sequential extractor and reconciler call, then CAS", async () => {
    const test = harness();
    const result = await runMemoryV3DialogueShadow(test.options);
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
      pipelineVersion: "memory-v3-dialogue-v1",
      extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
      reconcilerVersion: "memory-v3-dialogue-reconciler-v1",
      model: "google/gemini-3.7-flash",
      inputHash: (test.reserveInputs[0] as { inputHash: string }).inputHash,
      sourceLastMessageId: MESSAGE_ID,
      sourceLastCreatedAt: CREATED_AT,
      messageCount: 1,
      userMessageCount: 1,
    });
    assert.match((test.reserveInputs[0] as { inputHash: string }).inputHash, /^[0-9a-f]{64}$/);
    assert.equal(
      (test.extractorRequests[0] as { system: string }).system,
      MEMORY_V3_DIALOGUE_EXTRACTOR_SYSTEM_INSTRUCTION,
    );
    assert.equal(test.casInputs.length, 1);
    const cas = test.casInputs[0] as Record<string, unknown>;
    assert.equal(cas.expectedStateRevision, 0);
    assert.equal((cas.state as { stateRevision: number }).stateRevision, 1);
    assert.equal(cas.changed, true);
    assert.equal((cas.operations as unknown[]).length, 1);
    assert.equal((cas.transitions as unknown[]).length, 1);
    assert.equal(test.calls.some((entry) => entry.startsWith("fail:")), false);
  });

  it("logs real cost/tokens for both stages, tagged with their own stage and the shared run id", async () => {
    const test = harness({
      extractorAdapterFactory: () => async () => ({
        content: extractorContent(),
        usage: { promptTokens: 500, completionTokens: 80, costUsd: 0.00021 },
      }),
      reconcilerAdapterFactory: () => async () => ({
        rawContent: proposalContent,
        usage: { promptTokens: 900, completionTokens: 150, costUsd: 0.00045 },
      }),
    });
    const logged: unknown[] = [];
    const result = await runMemoryV3DialogueShadow(
      test.options,
      undefined,
      async (input) => { logged.push(input); },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(logged, [
      {
        userId: USER_ID, conversationId: CONVERSATION_ID, runId: RUN_ID, stage: "extractor",
        model: "google/gemini-3.7-flash", promptTokens: 500, completionTokens: 80, costUsd: 0.00021,
        pipeline: "dialogue",
      },
      {
        userId: USER_ID, conversationId: CONVERSATION_ID, runId: RUN_ID, stage: "reconciler",
        model: "google/gemini-3.7-flash", promptTokens: 900, completionTokens: 150, costUsd: 0.00045,
        pipeline: "dialogue",
      },
    ]);
  });

  it("never calls the usage logger when a stage reports no usage, and never fails the run if the logger throws", async () => {
    const test = harness({
      reconcilerAdapterFactory: () => async () => ({
        rawContent: proposalContent,
        usage: { promptTokens: 900, completionTokens: 150, costUsd: 0.00045 },
      }),
    });
    const logged: unknown[] = [];
    const result = await runMemoryV3DialogueShadow(
      test.options,
      undefined,
      async (input) => { logged.push(input); throw new Error("logging backend down"); },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(logged.length, 1);
    assert.equal((logged[0] as { stage: string }).stage, "reconciler");
  });

  it("uses a deterministic content-sensitive canonical input identity", async () => {
    const hashes: string[] = [];
    for (const text of ["Первый текст", "Второй текст"]) {
      const test = harness({
        async loadMessages() {
          return [{ id: MESSAGE_ID, role: "user" as const, text, createdAt: CREATED_AT }];
        },
      });
      assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
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
    const result = await runMemoryV3DialogueShadow(test.options);
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0,
      transitionCount: 0, stateRevision: 0,
    });
    const cas = test.casInputs[0] as Record<string, unknown>;
    assert.equal(cas.changed, false);
    assert.equal((cas.state as { stateRevision: number }).stateRevision, 0);
    assert.equal(test.calls.some((entry) => entry.startsWith("fail:")), false);
  });

  it("skips the reconciler entirely for an empty extraction but still persists a succeeded no-op run", async () => {
    let reconcilerFactoryCalls = 0;
    const extractorUsage = { promptTokens: 400, completionTokens: 20, costUsd: 0.0001 };
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: extractorUsage }),
      reconcilerAdapterFactory: () => {
        reconcilerFactoryCalls += 1;
        return async () => { throw new Error("the reconciler must not be called"); };
      },
    });
    const logged: unknown[] = [];
    const result = await runMemoryV3DialogueShadow(test.options, undefined, async (input) => { logged.push(input); });
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0, transitionCount: 0, stateRevision: 0,
    });
    assert.equal(reconcilerFactoryCalls, 0);
    assert.equal(test.casInputs.length, 1);
    assert.deepEqual(test.casInputs[0], {
      runId: RUN_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      expectedStateRevision: 0,
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      changed: false,
      extraction: {
        run: {
          caseId: `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`,
          extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
        },
        items: [],
        evidence: [],
      },
      operations: [],
      transitions: [],
      extractorUsage,
      reconcilerUsage: null,
    });
    assert.deepEqual(logged, [{
      userId: USER_ID, conversationId: CONVERSATION_ID, runId: RUN_ID, stage: "extractor",
      model: "google/gemini-3.7-flash", promptTokens: 400, completionTokens: 20, costUsd: 0.0001,
      pipeline: "dialogue",
    }]);
    assert.deepEqual(test.failInputs, []);
  });

  it("terminalizes an empty-extraction run through fail() when its no-op CAS conflicts", async () => {
    const test = harness({
      extractorAdapterFactory: () => async () => ({ content: emptyExtractorContent, usage: null }),
    });
    test.options.store = {
      ...test.store,
      async compareAndSwap() { test.calls.push("cas"); return { status: "state_conflict" as const }; },
    };
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "state_conflict",
    });
    assert.deepEqual(test.calls.slice(-2), ["cas", "fail:state_conflict"]);
    assert.equal(test.calls.includes("reconcilerFactory"), false);
  });

  it("stops duplicate and daily-cap reservations before providers", async () => {
    for (const status of ["duplicate", "daily_cap"] as const) {
      const test = harness({
        store: {
          ...harness().store,
          async reserve() { test.calls.push("reserve"); return { status }; },
        },
      });
      assert.deepEqual(await runMemoryV3DialogueShadow(test.options), { status: "skipped", reason: status });
      assert.deepEqual(test.calls, ["messages", "reserve"]);
    }
  });

  it("persists extractor transport failures once without trusting spoofed diagnostics", async () => {
    const fake = Object.assign(new Error(RAW_SECRET), { diagnosticCode: "reconciler_contract_invalid" });
    const test = harness({ extractorAdapterFactory: () => async () => { test.calls.push("extractor"); throw fake; } });
    const result = await runMemoryV3DialogueShadow(test.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "extractor_transport_failed" });
    assert.deepEqual(test.calls, ["messages", "reserve", "extractor", "fail:extractor_transport_failed"]);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    // The spoofed diagnosticCode isn't a real transport.ts-branded error, so
    // there's no trustworthy specific reason to persist -- transportDetail
    // stays null rather than echoing anything attacker-controlled.
    assert.equal((test.failInputs[0] as { transportDetail: unknown }).transportDetail, null);
  });

  it("persists the specific extractor transport diagnostic (not just the generic bucket) when the error is a real branded one", async () => {
    const test = harness({
      extractorAdapterFactory: () => createMemoryV3OpenRouterAdapter({
        apiKey: "test-key",
        fetchImpl: async () => new Response(RAW_SECRET, { status: 500 }),
      }),
    });
    const result = await runMemoryV3DialogueShadow(test.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "extractor_transport_failed" });
    assert.deepEqual(test.failInputs, [{
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "extractor_transport_failed", transportDetail: "provider_http_5xx",
      reconcilerRawResponse: null, reconcilerContext: null,
    }]);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });

  it("reports only a branded safe reconciler transport diagnostic while persisting the generic failure, now with the specific reason attached", async () => {
    const reported: string[] = [];
    const test = harness({
      reconcilerAdapterFactory: () => createMemoryV3DialogueOpenRouterAdapter({
        apiKey: "test-key",
        fetchImpl: async () => new Response(RAW_SECRET, { status: 400 }),
      }),
    });

    const result = await runMemoryV3DialogueShadow(test.options, (code) => reported.push(code));

    assert.deepEqual(result, {
      status: "failed",
      runId: RUN_ID,
      diagnosticCode: "reconciler_transport_failed",
    });
    assert.deepEqual(reported, ["provider_http_400"]);
    assert.equal(JSON.stringify({ result, reported }).includes(RAW_SECRET), false);
    assert.equal(test.calls.at(-1), "fail:reconciler_transport_failed");
    assert.deepEqual(test.failInputs, [{
      runId: RUN_ID, userId: USER_ID, diagnosticCode: "reconciler_transport_failed", transportDetail: "provider_http_400",
      reconcilerRawResponse: null, reconcilerContext: null,
    }]);
  });

  it("maps extractor parse, shape, and contract failures without retry", async () => {
    const cases = [
      ["{", "extractor_parse_invalid"],
      [JSON.stringify({}), "extractor_shape_invalid"],
      [extractorContent(""), "extractor_contract_invalid"],
    ] as const;
    for (const [content, diagnosticCode] of cases) {
      const test = harness({ extractorAdapterFactory: () => async () => ({ content, usage: null }) });
      assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
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
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
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
      assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
        status: "failed", runId: RUN_ID, diagnosticCode,
      });
      assert.equal(test.calls.filter((entry) => entry === "reserve").length, 1);
      assert.equal(test.calls.at(-1), `fail:${diagnosticCode}`);
      // The exact text the model returned is what makes a future
      // reconciler_contract_invalid diagnosable instead of a dead end --
      // see migration 065.
      assert.equal(
        (test.failInputs.at(-1) as { reconcilerRawResponse: unknown }).reconcilerRawResponse,
        rawContent,
      );
      // migration 071: the exact state/extraction/bindings the reconciler
      // was reasoning about, so a future failure can be replayed through
      // the real validator instead of reconstructed from memory.
      const context = JSON.parse(
        (test.failInputs.at(-1) as { reconcilerContext: string }).reconcilerContext,
      );
      assert.deepEqual(Object.keys(context).sort(), ["bindings", "extraction", "state"]);
      assert.equal(context.bindings.candidates[0].candidateRef, "candidate:0001");
    }
  });

  it("maps a malformed reconciler envelope to shape failure", async () => {
    const test = harness({ reconcilerAdapterFactory: () => async () => ({ rawContent: "{}", usage: null }) });
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_shape_invalid",
    });
    assert.equal(test.calls.at(-1), "fail:reconciler_shape_invalid");
    assert.equal(
      (test.failInputs.at(-1) as { reconcilerRawResponse: unknown }).reconcilerRawResponse,
      "{}",
    );
  });

  it("fails with reconciler_shape_invalid when an operation is missing the topic key", async () => {
    const malformedProposal = JSON.stringify({
      operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null }],
    });
    const test = harness({ reconcilerAdapterFactory: () => async () => ({ rawContent: malformedProposal, usage: null }) });
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_shape_invalid",
    });
    assert.equal(test.calls.at(-1), "fail:reconciler_shape_invalid");
  });

  it("validates proposal references through the trusted bundle bindings", async () => {
    let reconcilerCalls = 0;
    const rawContent = JSON.stringify({
      operations: [{
        type: "create", candidateRef: "candidate:9999", targetMemoryRef: null, topic: "person",
        supersedesMemoryRef: null,
      }],
    });
    const test = harness({ reconcilerAdapterFactory: () => async () => {
      reconcilerCalls += 1;
      return { rawContent, usage: null };
    } });
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_contract_invalid",
    });
    assert.equal(test.calls.at(-1), "fail:reconciler_contract_invalid");
    assert.equal(reconcilerCalls, 1);
    assert.equal(
      (test.failInputs.at(-1) as { reconcilerRawResponse: unknown }).reconcilerRawResponse,
      rawContent,
    );
  });

  it("terminalizes an oversized reserved state before either provider", async () => {
    const empty = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
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
      assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
        status: "failed", runId: RUN_ID, diagnosticCode: "state_too_large",
      });
      assert.deepEqual(test.calls, ["messages", "reserve", "fail:state_too_large"]);
    }
  });

  it("safe-wraps a hostile reserved-state proxy and persists one reservation failure", async () => {
    const test = harness();
    const hostile = new Proxy(createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }), {
      getOwnPropertyDescriptor() { throw new Error(RAW_SECRET); },
    });
    test.options.store = {
      ...test.store,
      async reserve() { test.calls.push("reserve"); return {
        status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0, state: hostile,
      }; },
      async fail(input) { test.calls.push(`fail:${input.diagnosticCode}`); },
    };
    const result = await runMemoryV3DialogueShadow(test.options);
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
    const result = await runMemoryV3DialogueShadow(test.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "state_write_failed" });
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
    assert.equal(test.calls.filter((entry) => entry === "extractor").length, 1);
    assert.equal(test.calls.filter((entry) => entry === "fail").length, 1);
  });

  it("persists state_conflict via fail after the terminal CAS, so the run never sits stuck", async () => {
    const test = harness({
      store: {
        ...harness().store,
        async reserve() {
          test.calls.push("reserve");
          return { status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0,
            state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }) };
        },
        async compareAndSwap() { test.calls.push("cas"); return { status: "state_conflict" as const }; },
        async fail(input: { diagnosticCode: string }) { test.calls.push(`fail:${input.diagnosticCode}`); },
      },
    });
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "state_conflict",
    });
    // A terminal CAS outcome must always be written back via fail(), even for
    // state_conflict -- otherwise the run row is left at "reserved" forever
    // with no diagnostic, indistinguishable from a genuinely stuck pipeline.
    assert.equal(test.calls.at(-1), "fail:state_conflict");
  });

  it("sanitizes reservation and state-write failures", async () => {
    const reserve = harness({ store: { ...harness().store, async reserve() { throw new Error(RAW_SECRET); } } });
    assert.deepEqual(await runMemoryV3DialogueShadow(reserve.options), {
      status: "failed", runId: null, diagnosticCode: "reservation_failed",
    });

    const cas = harness({
      store: {
        ...harness().store,
        async reserve() { return { status: "reserved" as const, runId: RUN_ID, expectedStateRevision: 0,
          state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }) }; },
        async compareAndSwap() { throw new Error(RAW_SECRET); },
      },
    });
    const result = await runMemoryV3DialogueShadow(cas.options);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "state_write_failed" });
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  });
});

describe("Memory V3 dialogue delta cursor", () => {
  type Message = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
  const PRIOR_MESSAGE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const OTHER_MESSAGE_ID = "99999999-9999-4999-8999-999999999999";
  const PRIOR: Message = { id: PRIOR_MESSAGE_ID, role: "assistant", text: "Привет! Как прошёл день?", createdAt: "2026-09-15T09:00:00Z" };
  const NEW: Message = { id: MESSAGE_ID, role: "user", text: "Я люблю утренние прогулки", createdAt: CREATED_AT };
  const LATER: Message = { id: OTHER_MESSAGE_ID, role: "user", text: "Сегодня снова гуляла", createdAt: "2026-09-15T11:00:00Z" };
  const PRIOR_CURSOR = { messageId: PRIOR_MESSAGE_ID, createdAt: PRIOR.createdAt };
  const NEW_CURSOR = { messageId: MESSAGE_ID, createdAt: CREATED_AT };
  const sentIds = (request: unknown) =>
    (request as { input: { messages: Array<{ id: string }> } }).input.messages.map(({ id }) => id);

  function withCursor(test: ReturnType<typeof harness>, cursor: unknown) {
    test.options.store = {
      ...test.store,
      async lastSucceededCursor(input) {
        test.calls.push("cursor");
        test.cursorInputs.push(input);
        return cursor as never;
      },
    };
    return test;
  }

  // Mirrors createMemoryV3MessageLoader's two call shapes over an in-memory
  // conversation (its real queries are covered in messages.cases.test.ts):
  // no cursor -> the last 60; a cursor -> the 5 messages ending at it, the
  // oldest 55 after it, and the newest id. Records each call's cursor, or
  // null for a two-argument call.
  function windowLoader(conversation: () => Message[], seen: unknown[]) {
    return async (_userId: string, _conversationId: string, ...cursor: unknown[]) => {
      const visible = conversation();
      if (cursor.length === 0) {
        seen.push(null);
        return visible.slice(-60);
      }
      seen.push(cursor[0]);
      const at = visible.findIndex((message) => message.id === (cursor[0] as { messageId: string }).messageId);
      return {
        context: visible.slice(Math.max(0, at - 4), at + 1),
        delta: visible.slice(at + 1, at + 56),
        latestMessageId: visible[visible.length - 1].id,
      };
    };
  }

  // Tracks every reserved run and answers lastSucceededCursor the way the
  // real query does: succeeded runs only, furthest (created_at, id) first.
  function trackingStore(seed: { messageId: string; createdAt: string } | null = null) {
    const runs: Array<{ runId: string; status: "reserved" | "succeeded" | "failed"; messageId: string; createdAt: string }> = [];
    const nextRunId = () => `eeeeeeee-eeee-4eee-8eee-${String(runs.length + 1).padStart(12, "0")}`;
    if (seed !== null) runs.push({ runId: nextRunId(), status: "succeeded", ...seed });
    const store: MemoryV3DialogueStore = {
      async reserve(input) {
        const runId = nextRunId();
        runs.push({ runId, status: "reserved", messageId: input.sourceLastMessageId, createdAt: input.sourceLastCreatedAt });
        return {
          status: "reserved", runId, expectedStateRevision: 0,
          state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
        };
      },
      async fail(input) { runs.find((run) => run.runId === input.runId)!.status = "failed"; },
      async compareAndSwap(input) {
        runs.find((run) => run.runId === input.runId)!.status = "succeeded";
        return { status: "succeeded", resultingStateRevision: input.state.stateRevision };
      },
      async lastSucceededCursor() {
        const best = runs
          .filter((run) => run.status === "succeeded")
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            (left.messageId < right.messageId ? 1 : left.messageId > right.messageId ? -1 : 0))[0];
        return best ? { messageId: best.messageId, createdAt: best.createdAt } : null;
      },
    };
    return { store, runs };
  }

  it("loads today's first-run window, with no cursor argument at all, when no run of this conversation has succeeded", async () => {
    const loaderArgs: unknown[][] = [];
    const test = harness({
      async loadMessages(...args: unknown[]) {
        loaderArgs.push(args);
        return [NEW];
      },
    });
    assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID]]);
  });

  it("reads this conversation's last succeeded cursor before loading, then loads only what follows it", async () => {
    const loaderArgs: unknown[][] = [];
    const test = withCursor(harness({
      async loadMessages(...args: unknown[]) {
        test.calls.push("messages");
        loaderArgs.push(args);
        return { context: [PRIOR], delta: [NEW], latestMessageId: MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
    assert.deepEqual(test.calls.slice(0, 3), ["cursor", "messages", "reserve"]);
    assert.deepEqual(test.cursorInputs, [{ userId: USER_ID, conversationId: CONVERSATION_ID }]);
    assert.deepEqual(loaderArgs, [[USER_ID, CONVERSATION_ID, PRIOR_CURSOR]]);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
    assert.equal((test.reserveInputs[0] as { sourceLastMessageId: string }).sourceLastMessageId, MESSAGE_ID);
  });

  it("fails the run before loading anything when the cursor lookup throws or returns garbage -- never a fallback window", async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      for (const lookup of [
        async () => { throw new Error(RAW_SECRET); },
        async () => ({ messageId: "not-a-uuid", createdAt: CREATED_AT }),
        async () => ({ messageId: MESSAGE_ID, createdAt: "not-a-date" }),
        async () => ({ messageId: MESSAGE_ID, createdAt: CREATED_AT, extra: RAW_SECRET }),
        async () => "RAW",
      ]) {
        const test = harness();
        test.options.store = { ...test.store, lastSucceededCursor: lookup as never };
        assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
          status: "failed", runId: null, diagnosticCode: "invalid_source",
        });
        assert.deepEqual(test.calls, []);
      }
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 5);
    assert.deepEqual(logged[0], ["[memory-v3-dialogue-cursor-lookup-failed]"]);
    assert.equal(JSON.stringify(logged).includes(RAW_SECRET), false);
  });

  it("treats a store without lastSucceededCursor as invalid before any database or provider work", async () => {
    const test = harness();
    test.options.store = {
      reserve: test.store.reserve,
      fail: test.store.fail,
      compareAndSwap: test.store.compareAndSwap,
    } as never;
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: null, diagnosticCode: "invalid_source",
    });
    assert.deepEqual(test.calls, []);
    assert.deepEqual(test.cursorInputs, []);
  });

  it("never calls the extractor when nothing new arrived since the cursor, and still ends as a succeeded no-op", async () => {
    const test = withCursor(harness({
      async loadMessages() {
        test.calls.push("messages");
        return { context: [PRIOR, NEW], delta: [], latestMessageId: MESSAGE_ID };
      },
    }), NEW_CURSOR);
    const logged: unknown[] = [];
    const result = await runMemoryV3DialogueShadow(test.options, undefined, async (input) => { logged.push(input); });
    assert.deepEqual(result, {
      status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0, transitionCount: 0, stateRevision: 0,
    });
    assert.deepEqual(test.calls, ["cursor", "messages", "reserve", "cas"]);
    const reserved = test.reserveInputs[0] as { sourceLastMessageId: string; sourceLastCreatedAt: string };
    assert.equal(reserved.sourceLastMessageId, MESSAGE_ID);
    assert.equal(reserved.sourceLastCreatedAt, CREATED_AT);
    assert.deepEqual(test.casInputs, [{
      runId: RUN_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      expectedStateRevision: 0,
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      changed: false,
      extraction: {
        run: {
          caseId: `memory-v3-shadow:${USER_ID}:${CONVERSATION_ID}`,
          extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
        },
        items: [],
        evidence: [],
      },
      operations: [],
      transitions: [],
      extractorUsage: null,
      reconcilerUsage: null,
    }]);
    assert.deepEqual(logged, []);
    assert.deepEqual(test.failInputs, []);
  });

  it("rejects an extraction citing a leading-context message exactly like an unknown id, before the reconciler", async () => {
    // The harness extractor cites MESSAGE_ID, which is a context message here.
    const test = withCursor(harness({
      async loadMessages() {
        test.calls.push("messages");
        return { context: [PRIOR, NEW], delta: [LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), NEW_CURSOR);
    assert.deepEqual(await runMemoryV3DialogueShadow(test.options), {
      status: "failed", runId: RUN_ID, diagnosticCode: "extractor_contract_invalid",
    });
    assert.equal(test.calls.includes("reconcilerFactory"), false);
    assert.equal(test.calls.at(-1), "fail:extractor_contract_invalid");
  });

  it("chunks a single oversized undrained message across several extractor calls and merges the results, instead of truncating it", async () => {
    // Deliberately large enough to need more than one chunk under the real
    // 20KB cap (the system instruction + schema overhead alone eats a
    // meaningful share of it), but well under the 5-chunk safety ceiling.
    const HUGE: Message = { ...NEW, text: `Я люблю утренние прогулки ${"x".repeat(21_000)}` };
    let calls = 0;
    const sentRequests: unknown[] = [];
    const test = withCursor(harness({
      async loadMessages() {
        return { context: [PRIOR], delta: [HUGE, LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
      extractorAdapterFactory: () => async (request: unknown) => {
        calls += 1;
        sentRequests.push(request);
        return {
          content: extractorContent(`Claim ${calls}`),
          usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.0001 },
        };
      },
      // The canned proposalContent handles exactly one candidate; this run's
      // merged extraction has one per chunk, so answer "ignore" for every
      // candidate the reconciler request actually lists.
      reconcilerAdapterFactory: () => async (request: unknown) => ({
        rawContent: JSON.stringify({
          operations: (request as { input: { candidates: Array<{ candidateRef: string }> } })
            .input.candidates.map(({ candidateRef }) => ({
              type: "ignore", candidateRef, targetMemoryRef: null, topic: null, supersedesMemoryRef: null,
            })),
        }),
        usage: null,
      }),
    }), PRIOR_CURSOR);
    const original = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    let status: string;
    try {
      status = (await runMemoryV3DialogueShadow(test.options)).status;
    } finally {
      console.warn = original;
    }
    assert.equal(status, "succeeded");
    assert.deepEqual(warned, [["[memory-v3-dialogue-delta-message-chunked]"]]);
    assert.equal(calls > 1, true);
    // Every chunk still only cites the real, whole message's id.
    assert.deepEqual(sentRequests.map((request) => sentIds(request)), Array.from({ length: calls }, () => [PRIOR_MESSAGE_ID, MESSAGE_ID]));
    assert.equal(sentRequests.every((request) =>
      new TextEncoder().encode(JSON.stringify(request)).byteLength <= 20_000), true);
    // Every chunk's text is a real slice of the original, and none of them is
    // the full, untruncated message by itself.
    const chunkTexts = sentRequests.map((request) =>
      (request as { input: { messages: Array<{ id: string; text: string }> } })
        .input.messages.find((message) => message.id === MESSAGE_ID)!.text);
    for (const text of chunkTexts) assert.equal(text.length < HUGE.text.length, true);
    const cas = test.casInputs[0] as {
      extraction: { items: unknown[] };
      extractorUsage: { promptTokens: number; completionTokens: number; costUsd: number };
    };
    // Nothing is merged away: one distinct item (distinct claim) per chunk.
    assert.equal(cas.extraction.items.length, calls);
    // Usage is the true sum of every chunk's call, not just the last one.
    assert.equal(cas.extractorUsage.promptTokens, calls * 100);
    assert.equal(cas.extractorUsage.completionTokens, calls * 10);
    assert.equal(Math.round(cas.extractorUsage.costUsd * 1e8), Math.round(calls * 0.0001 * 1e8));
    assert.equal((test.reserveInputs[0] as { sourceLastMessageId: string }).sourceLastMessageId, MESSAGE_ID);
  });

  it("falls back to sending as-is at the extractor when a message would need more chunks than the safety ceiling allows", async () => {
    const GIGANTIC: Message = { ...NEW, text: "я".repeat(80_000) };
    const test = withCursor(harness({
      async loadMessages() {
        return { context: [PRIOR], delta: [GIGANTIC, LATER], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    const original = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    let result: Awaited<ReturnType<typeof runMemoryV3DialogueShadow>>;
    try {
      result = await runMemoryV3DialogueShadow(test.options);
    } finally {
      console.warn = original;
    }
    // The extractor layer's own 5-chunk ceiling is reached first, so it
    // falls back to sending the oldest message as-is -- bounded to exactly
    // one call, never unbounded chunking -- but a message this size is also
    // too large for the reconciler's own, separate, pre-existing 80KB cap
    // (evidence-only mode still sends that one cited message's full text),
    // so the run still ends up failing there. That failure, and the
    // repeated-failure risk it carries for a conversation that keeps
    // receiving a message this large, is the same already-deferred
    // territory as the reviewer's Finding #1 -- this fix only bounds the
    // extractor's own wasted cost on a message already this hopeless.
    assert.deepEqual(warned, [["[memory-v3-dialogue-delta-over-byte-cap]"]]);
    assert.equal(test.extractorRequests.length, 1);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
    assert.deepEqual(result, { status: "failed", runId: RUN_ID, diagnosticCode: "reconciler_request_too_large" });
  });

  it("falls back to sending as-is when even the context block alone exceeds the byte cap and chunking cannot fit it", async () => {
    const HUGE_CONTEXT: Message = { ...PRIOR, text: "я".repeat(30_000) };
    const test = withCursor(harness({
      async loadMessages() {
        return { context: [HUGE_CONTEXT], delta: [NEW], latestMessageId: OTHER_MESSAGE_ID };
      },
    }), PRIOR_CURSOR);
    const original = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    let status: string;
    try {
      status = (await runMemoryV3DialogueShadow(test.options)).status;
    } finally {
      console.warn = original;
    }
    assert.equal(status, "succeeded");
    assert.deepEqual(warned, [["[memory-v3-dialogue-delta-over-byte-cap]"]]);
    assert.deepEqual(sentIds(test.extractorRequests[0]), [PRIOR_MESSAGE_ID, MESSAGE_ID]);
  });

  it("computes a literal, pinned SHA-256 input hash for a first run (golden value -- proves the delta identity fold leaves it unchanged)", async () => {
    const test = harness({
      async loadMessages() {
        return [{
          id: "00000000-0000-4000-8000-000000000001",
          role: "user" as const,
          text: "Golden hash fixture message",
          createdAt: "2026-01-01T00:00:00.000Z",
        }];
      },
    });
    // The canned extractor response's evidence cites a different, fixed
    // message id, so this particular run fails downstream -- irrelevant
    // here: reserve() (and its inputHash) runs first, before the extractor.
    await runMemoryV3DialogueShadow(test.options);
    assert.equal(test.reserveInputs.length, 1);
    assert.equal(
      (test.reserveInputs[0] as { inputHash: string }).inputHash,
      "5882c85d0bc5232883610362313b44e97671dd5bbcf6275de225b72a2bbe6d6d",
    );
  });

  it("folds the conversation's latest message into a delta run's input identity, so a failed window can be retried once anything new is written", async () => {
    const hashes: string[] = [];
    for (const latestMessageId of [MESSAGE_ID, MESSAGE_ID, OTHER_MESSAGE_ID]) {
      const test = withCursor(harness({
        async loadMessages() {
          return { context: [PRIOR], delta: [NEW], latestMessageId };
        },
      }), PRIOR_CURSOR);
      assert.equal((await runMemoryV3DialogueShadow(test.options)).status, "succeeded");
      hashes.push((test.reserveInputs[0] as { inputHash: string }).inputHash);
    }
    // Same window, same conversation state: a genuine duplicate.
    assert.equal(hashes[0], hashes[1]);
    // Same window, but something newer was written since: a distinct identity
    // the reservation accepts, even though the window itself is identical.
    assert.notEqual(hashes[1], hashes[2]);
  });

  it("advances the delta cursor only on succeeded runs (fail, succeed, fail, then read)", async () => {
    const conversation: Message[] = Array.from({ length: 8 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "user",
      text: `Сообщение ${index + 1}`,
      createdAt: `2026-09-15T10:0${index}:00Z`,
    }));
    const tracked = trackingStore();
    const seenCursors: unknown[] = [];
    let visible = 0;
    let extractorFails = false;
    const options = {
      ...harness().options,
      store: tracked.store,
      loadMessages: windowLoader(() => conversation.slice(0, visible), seenCursors),
      extractorAdapterFactory: () => async () => {
        if (extractorFails) throw new Error("provider down");
        return { content: emptyExtractorContent, usage: null };
      },
    };
    for (const step of [
      { visible: 2, fails: true, status: "failed" },
      { visible: 4, fails: false, status: "succeeded" },
      { visible: 6, fails: true, status: "failed" },
      { visible: 8, fails: false, status: "succeeded" },
    ]) {
      visible = step.visible;
      extractorFails = step.fails;
      assert.equal((await runMemoryV3DialogueShadow(options)).status, step.status);
    }
    assert.deepEqual(tracked.runs.map((run) => run.status), ["failed", "succeeded", "failed", "succeeded"]);
    const afterRun2 = { messageId: conversation[3].id, createdAt: conversation[3].createdAt };
    // Run 3 failed after covering messages 5-6, so run 4 must still read from
    // run 2 -- and re-offer 5-6 ahead of 7-8.
    assert.deepEqual(seenCursors, [null, null, afterRun2, afterRun2]);
    assert.deepEqual(tracked.runs.map((run) => run.messageId), [1, 3, 5, 7].map((index) => conversation[index].id));
  });

  it("drains a 150-message backlog oldest-first across runs: every message reaches exactly one extractor window, none skipped", async () => {
    // Cursor seeded on message 1, then 150 undrained messages, each big enough
    // that the 20 KB extractor cap -- not the 55-message chunk -- sizes every
    // window.
    const conversation: Message[] = Array.from({ length: 151 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `${index + 1}: ${"я".repeat(300)}`,
      createdAt: new Date(Date.UTC(2026, 8, 15, 10, 0, index)).toISOString(),
    }));
    const position = (id: string) => conversation.findIndex((message) => message.id === id);
    const tracked = trackingStore({ messageId: conversation[0].id, createdAt: conversation[0].createdAt });
    const seenCursors: unknown[] = [];
    const sent: string[][] = [];
    const options = {
      ...harness().options,
      store: tracked.store,
      loadMessages: windowLoader(() => conversation, seenCursors),
      extractorAdapterFactory: () => async (request: unknown) => {
        sent.push(sentIds(request));
        return { content: emptyExtractorContent, usage: null };
      },
    };
    const drained: string[] = [];
    for (let attempt = 1; ; attempt += 1) {
      assert.equal(attempt <= 40, true);
      const windowsBefore = sent.length;
      assert.equal((await runMemoryV3DialogueShadow(options)).status, "succeeded");
      if (sent.length === windowsBefore) break; // the empty-delta run: no extractor call at all
      const cursorId = (seenCursors.at(-1) as { messageId: string }).messageId;
      const ids = sent[sent.length - 1];
      const contextEnd = ids.indexOf(cursorId);
      assert.equal(contextEnd >= 0 && contextEnd <= 4, true);
      const delta = ids.slice(contextEnd + 1);
      // Each delta starts right after the cursor: no gap at the seam.
      assert.equal(position(delta[0]), position(cursorId) + 1);
      drained.push(...delta);
    }
    // Every undrained message was sent in exactly one run's delta, in order.
    assert.deepEqual(drained, conversation.slice(1).map(({ id }) => id));
    // The byte cap sized the windows, so the backlog took several runs.
    assert.equal(sent.length > 2, true);
    assert.equal(sent.every((ids) => ids.length < 60), true);
    // Each run's stored source position is the last message it actually sent,
    // and the closing no-op run leaves the cursor on the final message.
    assert.deepEqual(tracked.runs.slice(1, 1 + sent.length).map((run) => run.messageId), sent.map((ids) => ids[ids.length - 1]));
    assert.equal(tracked.runs[tracked.runs.length - 1].messageId, conversation[150].id);
    assert.equal(tracked.runs.every((run) => run.status === "succeeded"), true);
  });
});

describe("Memory V3 dialogue background isolation", () => {
  it("logs only a closed diagnostic for failed and malformed results", async () => {
    const logged: string[] = [];
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => ({ status: "failed", runId: RUN_ID, diagnosticCode: "extractor_parse_invalid" }),
      (code) => logged.push(code),
    );
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => ({ status: "failed", runId: RUN_ID, diagnosticCode: RAW_SECRET } as never),
      (code) => logged.push(code),
    );
    assert.deepEqual(logged, ["extractor_parse_invalid", "unknown_failure"]);
    assert.equal(JSON.stringify(logged).includes(RAW_SECRET), false);
  });

  it("never rejects when run or logging throws", async () => {
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => { throw new Error(RAW_SECRET); },
      () => { throw new Error(RAW_SECRET); },
    );
  });

  it("rejects malformed safe-result shapes without trusting their diagnostic", async () => {
    const logged: string[] = [];
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => ({ status: "failed", runId: "not-a-uuid", diagnosticCode: "extractor_parse_invalid" }),
      (code) => logged.push(code),
    );
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => ({ status: "succeeded", runId: RUN_ID, itemCount: -1, evidenceCount: 0,
        transitionCount: 0, stateRevision: 0 }),
      (code) => logged.push(code),
    );
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => ({ status: "failed", runId: null, diagnosticCode: "state_conflict" }),
      (code) => logged.push(code),
    );
    await runMemoryV3DialogueShadowBackgroundSafely(
      async () => ({ status: "succeeded", runId: RUN_ID, itemCount: 101, evidenceCount: 0,
        transitionCount: 0, stateRevision: 0 }),
      (code) => logged.push(code),
    );
    assert.deepEqual(logged, ["unknown_failure", "unknown_failure", "unknown_failure", "unknown_failure"]);
  });
});

describe("Memory V3 dialogue source isolation", () => {
  it("passes an empty trusted-forget list and never imports a legacy writer", () => {
    const source = readFileSync(new URL("./dialogueShadowRunner.ts", import.meta.url), "utf8");
    assert.match(source, /from "\.\/dialogueExtractorPrompt\.ts"/);
    assert.doesNotMatch(source, /from "\.\/prompt\.ts"/);
    assert.doesNotMatch(source, /lifecycleExtractorPrompt/);
    assert.match(source, /trustedForgetMemoryKeys:\s*\[\]/);
    assert.equal(source.includes("conversation_summary"), false);
    assert.equal(source.includes("user_memory"), false);
    assert.equal(source.includes("shadowStore"), false);
    assert.equal(source.includes("globalThis.fetch"), false);
    assert.equal(source.includes("process.env"), false);
    assert.equal(source.includes("Deno.env"), false);
  });
});
