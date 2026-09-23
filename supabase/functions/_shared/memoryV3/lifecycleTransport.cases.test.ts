import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION,
  type MemoryV3LifecycleReconcileRequest,
} from "./lifecyclePrompt.ts";
import {
  createMemoryV3LifecycleOpenRouterAdapter,
  projectSafeMemoryV3LifecycleTransportDiagnostic,
} from "./lifecycleTransport.ts";

const API_KEY = "test-key";
const RAW_SECRET = "RAW_LIFECYCLE_PROVIDER_SECRET_SENTINEL";
const RAW_CONTENT = JSON.stringify({ operations: [] });

const EXPECTED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "candidateRef", "targetMemoryRef", "topic"],
        properties: {
          type: {
            type: "string",
            enum: ["create", "confirm", "revise", "mark_stale", "reject", "ignore"],
          },
          candidateRef: { type: "string" },
          targetMemoryRef: { type: ["string", "null"] },
          topic: { type: ["string", "null"], enum: ["life_context", "communication", "preference", null] },
        },
      },
    },
  },
};

function request(): MemoryV3LifecycleReconcileRequest {
  return {
    system: MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION,
    input: {
      schemaVersion: "memory-v3-lifecycle-reconcile-request-v1",
      userLanguage: "ru",
      session: {
        conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sourceLastMessageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceLastCreatedAt: "2026-09-05T10:00:00.000Z",
      },
      messages: [{
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        role: "user",
        text: "Когда мне страшно, я шучу.",
        createdAt: "2026-09-05T10:00:00.000Z",
      }],
      currentItems: [],
      candidates: [],
    },
  };
}

function officialBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-response",
    object: "chat.completion",
    created: 1,
    model: "google/gemini-3.7-flash",
    provider: "synthetic",
    choices: [{
      index: 0,
      finish_reason: "stop",
      native_finish_reason: "STOP",
      message: { role: "assistant", content: RAW_CONTENT, refusal: null },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 25, cost: 0.0001 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function recordingFetch(
  responseFactory: () => Promise<Response> | Response = () => jsonResponse(officialBody()),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return await responseFactory();
  };
  return Object.assign(fetchImpl as typeof fetch, { calls });
}

async function captureError(action: () => Promise<unknown>) {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "MemoryV3LifecycleTransportError");
  assert.match(caught.message, /^\[memory-v3:lifecycle-transport\]/);
  assert.equal("cause" in caught, false);
  assert.equal(caught.message.includes(RAW_SECRET), false);
  assert.equal(JSON.stringify(caught).includes(RAW_SECRET), false);
  return caught;
}

describe("Memory V3 lifecycle injected OpenRouter transport", () => {
  it("sends one exact privacy-locked POST and projects only content plus trusted usage", async () => {
    const input = request();
    const snapshot = structuredClone(input);
    const fetchImpl = recordingFetch();
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("GLOBAL_FETCH_SENTINEL"); }) as typeof fetch;
    try {
      const result = await createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(input);
      assert.deepEqual(result, {
        rawContent: RAW_CONTENT,
        usage: { promptTokens: 100, completionTokens: 25, costUsd: 0.0001 },
      });
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(fetchImpl.calls[0].init.method, "POST");
    const headers = fetchImpl.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(String(fetchImpl.calls[0].init.body));
    assert.equal(body.model, "google/gemini-3.7-flash");
    assert.equal(body.max_tokens, 1200);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
    assert.deepEqual(body.provider, {
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
    });
    assert.equal(body.stream, false);
    assert.deepEqual(body.usage, { include: true });
    assert.deepEqual(body.messages, [
      { role: "system", content: input.system },
      { role: "user", content: JSON.stringify(input.input) },
    ]);
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: {
        name: "memory_v3_lifecycle_reconcile_response",
        strict: true,
        schema: EXPECTED_SCHEMA,
      },
    });
    assert.equal(
      Object.hasOwn(body.response_format.json_schema.schema.properties.operations, "maxItems"),
      false,
    );
    assert.deepEqual(input, snapshot);
  });

  it("requires topic as a fourth key on every reconciler operation, scoped to the lifecycle enum plus null", async () => {
    const fetchImpl = recordingFetch();
    await createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request());
    assert.equal(fetchImpl.calls.length, 1);
    const body = JSON.parse(String(fetchImpl.calls[0].init.body));
    const operationSchema = body.response_format.json_schema.schema.properties.operations.items;
    assert.deepEqual(operationSchema.required, ["type", "candidateRef", "targetMemoryRef", "topic"]);
    assert.deepEqual(operationSchema.properties.topic, {
      type: ["string", "null"],
      enum: ["life_context", "communication", "preference", null],
    });
  });

  it("accepts Task 3 evidence with mentionTime and preserves it in the serialized request", async () => {
    const input = request();
    input.input.candidates = [{
      candidateRef: "candidate:0001",
      kind: "event",
      claim: "Важный синтетический факт",
      status: "active",
      sensitivity: "normal",
      eventTimeStart: null,
      eventTimeEnd: null,
      alternative: null,
      evidence: [{
        sourceMessageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        relation: "supports",
        supportType: null,
        episodeKey: "episode:synthetic",
        mentionTime: "2026-09-05T10:00:00.000Z",
      }],
    }];
    const fetchImpl = recordingFetch();
    const result = await createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(input);
    assert.equal(result.rawContent, RAW_CONTENT);
    assert.equal(fetchImpl.calls.length, 1);
    const body = JSON.parse(String(fetchImpl.calls[0].init.body));
    const serializedInput = JSON.parse(body.messages[1].content);
    assert.equal(
      serializedInput.candidates[0].evidence[0].mentionTime,
      "2026-09-05T10:00:00.000Z",
    );
  });

  it("requires strict data-only configuration and never executes accessors", () => {
    let getterCalls = 0;
    const getterConfig = { fetchImpl: recordingFetch(), apiKey: API_KEY };
    Object.defineProperty(getterConfig, "apiKey", {
      enumerable: true,
      get() { getterCalls += 1; return API_KEY; },
    });
    const symbolConfig = { fetchImpl: recordingFetch(), apiKey: API_KEY, [Symbol("x")]: true };
    for (const options of [
      {},
      { fetchImpl: 1, apiKey: API_KEY },
      { fetchImpl: recordingFetch(), apiKey: "" },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, timeoutMs: 0 },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, maxResponseBytes: 1.5 },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, unknown: true },
      getterConfig,
      symbolConfig,
    ]) {
      assert.throws(
        () => createMemoryV3LifecycleOpenRouterAdapter(options as never),
        /^MemoryV3LifecycleTransportError: \[memory-v3:lifecycle-transport\]/,
      );
    }
    assert.equal(getterCalls, 0);
  });

  it("rejects malformed request records before HTTP without executing getters", async () => {
    let getterCalls = 0;
    const accessor = request();
    Object.defineProperty(accessor.input, "messages", {
      enumerable: true,
      get() { getterCalls += 1; return []; },
    });
    const { proxy, revoke } = Proxy.revocable(request(), {});
    revoke();
    const cyclic = request();
    (cyclic.input as unknown as Record<string, unknown>).cycle = cyclic.input;
    const symbol = request();
    (symbol.input as unknown as Record<PropertyKey, unknown>)[Symbol("x")] = true;
    const sparse = request();
    sparse.input.messages.length = 2;
    for (const invalid of [
      { ...request(), extra: true },
      accessor,
      proxy,
      cyclic,
      symbol,
      sparse,
    ]) {
      const fetchImpl = recordingFetch();
      await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(invalid as never));
      assert.equal(fetchImpl.calls.length, 0);
    }
    assert.equal(getterCalls, 0);
  });

  it("rejects a substituted system instruction before HTTP", async () => {
    const input = request();
    input.system = RAW_SECRET;
    const fetchImpl = recordingFetch();
    await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(input));
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("enforces aggregate evidence caps before HTTP", async () => {
    const input = request();
    const evidence = Array.from({ length: 251 }, (_unused, index) => ({
      sourceMessageId: `source-${index}`,
      relation: "supports",
      supportType: null,
      episodeKey: `episode-${index}`,
      mentionTime: "2026-09-05T10:00:00.000Z",
    }));
    input.input.currentItems = ["memory:0001", "memory:0002"].map((memoryRef) => ({
      memoryRef,
      kind: "event",
      claim: "Синтетический факт",
      status: "active",
      sensitivity: "normal",
      eventTimeStart: null,
      eventTimeEnd: null,
      alternative: null,
      revision: 1,
      evidence: structuredClone(evidence),
    }));
    const fetchImpl = recordingFetch();
    await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(input));
    assert.equal(fetchImpl.calls.length, 0);
  });

  for (const [status, diagnostic] of [
    [400, "provider_http_400"],
    [429, "provider_http_429"],
    [500, "provider_http_5xx"],
  ] as const) {
    it(`maps HTTP ${status} to ${diagnostic} without reading provider text`, async () => {
      const fetchImpl = recordingFetch(() => new Response(RAW_SECRET, { status }));
      const error = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
      assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(error), diagnostic);
      assert.equal(fetchImpl.calls.length, 1);
    });
  }

  it("classifies other non-2xx statuses as invalid provider responses", async () => {
    const error = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => new Response("", { status: 302 })),
      apiKey: API_KEY,
    })(request()));
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(error), "provider_response_invalid");
  });

  it("rejects malformed JSON and oversized UTF-8 bodies without leaking content", async () => {
    for (const [factory, cap] of [
      [() => new Response(`not-json-${RAW_SECRET}`, { status: 200 }), 1_000_000],
      [() => new Response(`ёё${RAW_SECRET}`, { status: 200 }), 3],
    ] as const) {
      const fetchImpl = recordingFetch(factory);
      const error = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
        fetchImpl,
        apiKey: API_KEY,
        maxResponseBytes: cap,
      })(request()));
      assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(error), "provider_response_invalid");
      assert.equal(fetchImpl.calls.length, 1);
    }
  });

  it("rejects provider errors, invalid choices, refusal, tools, functions, and missing content", async () => {
    const bodies = [
      { error: { message: RAW_SECRET } },
      { choices: [] },
      { choices: [{ finish_reason: "length", message: { role: "assistant", content: RAW_CONTENT } }] },
      { choices: [{ finish_reason: "stop", error: { message: RAW_SECRET }, message: { role: "assistant", content: RAW_CONTENT } }] },
      { choices: [{ finish_reason: "stop", message: { content: RAW_CONTENT } }] },
      { choices: [{ finish_reason: "stop", message: { role: "tool", content: RAW_CONTENT } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: RAW_CONTENT, refusal: RAW_SECRET } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: RAW_CONTENT, tool_calls: [] } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: RAW_CONTENT, function_call: {} } }] },
    ];
    for (const body of bodies) {
      const fetchImpl = recordingFetch(() => jsonResponse(body));
      const error = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
      assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(error), "provider_response_invalid");
      assert.equal(fetchImpl.calls.length, 1);
    }
  });

  it("accepts nullable refusal and telemetry but returns null for untrusted usage", async () => {
    const accepted = await createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => jsonResponse(officialBody({ service_tier: "test", openrouter_metadata: {} }))),
      apiKey: API_KEY,
    })(request());
    assert.equal(accepted.rawContent, RAW_CONTENT);

    for (const usage of [
      undefined,
      null,
      { prompt_tokens: -1, completion_tokens: 2, cost: 0.1 },
      { prompt_tokens: 1, completion_tokens: 2, cost: "0.1" },
    ]) {
      const body = officialBody();
      if (usage === undefined) delete (body as Record<string, unknown>).usage;
      else (body as Record<string, unknown>).usage = usage;
      const result = await createMemoryV3LifecycleOpenRouterAdapter({
        fetchImpl: recordingFetch(() => jsonResponse(body)),
        apiKey: API_KEY,
      })(request());
      assert.equal(result.usage, null);
    }
  });

  it("times out a hanging body with one abort and no retry", async () => {
    const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
    const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
    let timeoutHandler: (() => void) | undefined;
    let clears = 0;
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = recordingFetch(() => new Response(new ReadableStream<Uint8Array>({
      start() { /* deliberately never close the body */ },
    })));
    const wrappedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return await fetchImpl(url, init);
    }) as typeof fetch;

    try {
      Object.defineProperty(globalThis, "setTimeout", {
        ...setDescriptor,
        value: (handler: () => void) => { timeoutHandler = handler; return 1; },
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        ...clearDescriptor,
        value: () => { clears += 1; },
      });
      const operation = createMemoryV3LifecycleOpenRouterAdapter({
        fetchImpl: wrappedFetch,
        apiKey: API_KEY,
      })(request());
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(capturedSignal?.aborted, false);
      timeoutHandler!();
      timeoutHandler!();
      const error = await captureError(() => operation);
      assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(error), "transport_timeout");
      assert.equal(capturedSignal?.aborted, true);
    } finally {
      Object.defineProperty(globalThis, "setTimeout", setDescriptor);
      Object.defineProperty(globalThis, "clearTimeout", clearDescriptor);
    }
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(clears, 1);
  });

  it("does not retry fetch rejection or trust spoofed diagnostics", async () => {
    const spoof = Object.assign(new Error(RAW_SECRET), {
      name: "MemoryV3LifecycleTransportError",
      diagnosticCode: "provider_http_4xx",
    });
    const fetchImpl = recordingFetch(() => Promise.reject(spoof));
    const error = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl,
      apiKey: `${API_KEY}-${RAW_SECRET}`,
    })(request()));
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(error), "transport_failed");
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(spoof), null);
  });

  it("does not trust a stolen branded error from fetch or response traps", async () => {
    const first = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => new Response("", { status: 400 })),
      apiKey: API_KEY,
    })(request()));
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(first), "provider_http_400");

    const fetchImpl = recordingFetch(() => Promise.reject(first));
    const second = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
    assert.notEqual(second, first);
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(second), "transport_failed");

    const malicious = new Proxy({}, { getPrototypeOf() { throw first; } });
    const third = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => malicious as Response),
      apiKey: API_KEY,
    })(request()));
    assert.notEqual(third, first);
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(third), "provider_response_invalid");
  });

  it("rejects accessor and revoked response objects without getter execution", async () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "status", {
      enumerable: true,
      get() { getterCalls += 1; return 200; },
    });
    const accessorError = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => accessor as Response),
      apiKey: API_KEY,
    })(request()));
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(accessorError), "provider_response_invalid");
    assert.equal(getterCalls, 0);

    const shadowed = jsonResponse(officialBody());
    Object.defineProperty(shadowed, "text", {
      configurable: true,
      get() { getterCalls += 1; throw new Error(RAW_SECRET); },
    });
    const accepted = await createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => shadowed),
      apiKey: API_KEY,
    })(request());
    assert.equal(accepted.rawContent, RAW_CONTENT);
    assert.equal(getterCalls, 0);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const revoked = await captureError(() => createMemoryV3LifecycleOpenRouterAdapter({
      fetchImpl: recordingFetch(() => proxy as Response),
      apiKey: API_KEY,
    })(request()));
    assert.equal(projectSafeMemoryV3LifecycleTransportDiagnostic(revoked), "transport_failed");
  });
});
