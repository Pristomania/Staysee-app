import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOpenRouterAdapter } from "../../../../scripts/memory-v3-pilot/openrouter-adapter.mjs";
import { buildMemoryV3ExtractorRequest } from "./prompt.ts";
import {
  createMemoryV3OpenRouterAdapter,
  projectSafeMemoryV3TransportDiagnostic,
} from "./transport.ts";

const API_KEY = "test-key";
const RAW_SECRET = "RAW_PROVIDER_BODY_SECRET_SENTINEL";

function dialogue() {
  return {
    caseId: "memory-v3-shadow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    messages: [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      role: "user",
      text: "Когда мне страшно, я шучу.",
      createdAt: "2026-09-05T10:00:00.000Z",
    }],
  };
}

const validLayeredResponse = {
  layerDecisions: [
    { kind: "event", decision: "omit", itemRefs: [] },
    { kind: "recurrence", decision: "omit", itemRefs: [] },
    { kind: "hypothesis", decision: "omit", itemRefs: [] },
  ],
  items: [],
  evidence: [],
};

function officialBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-response",
    object: "chat.completion",
    created: 1,
    model: "google/gemini-3.7-flash",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify(validLayeredResponse),
        refusal: null,
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request() {
  return buildMemoryV3ExtractorRequest(dialogue());
}

function recordingFetch(responseFactory: () => Promise<Response> | Response = () => jsonResponse(officialBody())) {
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
  assert.match(caught.message, /^\[memory-v3:transport\]/);
  assert.equal("cause" in caught, false);
  return caught;
}

describe("Memory V3 injected OpenRouter transport", () => {
  it("sends one exact privacy-locked POST and projects content plus trusted usage", async () => {
    const fetchImpl = recordingFetch();
    const adapter = createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY });
    const result = await adapter(request());
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(fetchImpl.calls[0].init.method, "POST");
    const headers = fetchImpl.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(String(fetchImpl.calls[0].init.body));
    assert.equal(body.model, "google/gemini-3.7-flash");
    assert.equal(body.max_tokens, 1200);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.deepEqual(body.provider, {
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
    });
    assert.equal(body.stream, false);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(result, {
      content: JSON.stringify(validLayeredResponse),
      usage: { promptTokens: 100, completionTokens: 50, costUsd: 0.0001 },
    });
  });

  it("uses the complete approved v2-layered response schema", async () => {
    let approvedBody: Record<string, unknown> | undefined;
    const approved = createOpenRouterAdapter({
      transport: async (transportRequest: Record<string, unknown>) => {
        approvedBody = transportRequest.body as Record<string, unknown>;
        return { status: 200, body: officialBody() };
      },
      apiKey: API_KEY,
      model: "google/gemini-3.7-flash",
      maxOutputTokens: 1200,
      reasoningEffort: "low",
      responseContract: "v2-layered",
      allowFallbacks: true,
      maxTokensParameter: "max_tokens",
    });
    await approved(request());
    const fetchImpl = recordingFetch();
    await createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request());
    const actualBody = JSON.parse(String(fetchImpl.calls[0].init.body));
    assert.deepEqual(actualBody.response_format, approvedBody!.response_format);
  });

  it("requires data-only config, injected fetch, key, and paired timer overrides", () => {
    let getterCalls = 0;
    const withGetter = { fetchImpl: recordingFetch(), apiKey: API_KEY };
    Object.defineProperty(withGetter, "apiKey", { enumerable: true, get() { getterCalls += 1; return API_KEY; } });
    for (const options of [
      {},
      { fetchImpl: 1, apiKey: API_KEY },
      { fetchImpl: recordingFetch(), apiKey: "" },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, timeoutMs: 0 },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, maxResponseBytes: 1.5 },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, setTimeoutImpl: () => 1 },
      { fetchImpl: recordingFetch(), apiKey: API_KEY, clearTimeoutImpl: () => {} },
      withGetter,
    ]) {
      assert.throws(() => createMemoryV3OpenRouterAdapter(options as never), /^MemoryV3TransportError: \[memory-v3:transport\]/);
    }
    assert.equal(getterCalls, 0);
  });

  for (const [status, diagnostic] of [[400, "provider_http_4xx"], [429, "provider_http_4xx"], [500, "provider_http_5xx"]] as const) {
    it(`maps HTTP ${status} to ${diagnostic} without reading provider text`, async () => {
      const fetchImpl = recordingFetch(() => new Response(RAW_SECRET, { status }));
      const error = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
      assert.equal(projectSafeMemoryV3TransportDiagnostic(error), diagnostic);
      assert.equal(error.message.includes(RAW_SECRET), false);
    });
  }

  it("does not misclassify a non-2xx status outside 4xx and 5xx", async () => {
    const fetchImpl = recordingFetch(() => new Response("", { status: 302 }));
    const error = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
    assert.equal(projectSafeMemoryV3TransportDiagnostic(error), "provider_response_invalid");
  });

  it("rejects invalid JSON and oversized UTF-8 bodies without leaking them", async () => {
    for (const [responseFactory, maxResponseBytes] of [
      [() => new Response(`not-json-${RAW_SECRET}`, { status: 200 }), 1_000_000],
      [() => new Response(`éé${RAW_SECRET}`, { status: 200 }), 3],
    ] as const) {
      const fetchImpl = recordingFetch(responseFactory);
      const error = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY, maxResponseBytes })(request()));
      assert.equal(projectSafeMemoryV3TransportDiagnostic(error), "provider_response_invalid");
      assert.equal(error.message.includes(RAW_SECRET), false);
    }
  });

  it("rejects provider, choice, finish, role, content, and refusal failures", async () => {
    const cases = [
      { error: { message: RAW_SECRET } },
      { choices: [{ error: { message: RAW_SECRET }, finish_reason: "stop", message: { role: "assistant", content: "{}" } }] },
      { choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "tool", content: "{}" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", refusal: RAW_SECRET } }] },
    ];
    for (const body of cases) {
      const fetchImpl = recordingFetch(() => jsonResponse(body));
      const error = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
      assert.equal(projectSafeMemoryV3TransportDiagnostic(error), "provider_response_invalid");
      assert.equal(JSON.stringify(error).includes(RAW_SECRET), false);
      assert.equal(fetchImpl.calls.length, 1);
    }
  });

  it("accepts refusal null and ignores inspected telemetry fields", async () => {
    const result = await createMemoryV3OpenRouterAdapter({
      fetchImpl: recordingFetch(() => jsonResponse(officialBody({ provider: "synthetic", service_tier: "test" }))),
      apiKey: API_KEY,
    })(request());
    assert.equal(result.content, JSON.stringify(validLayeredResponse));
  });

  it("returns null for missing or untrusted numeric usage", async () => {
    for (const usage of [undefined, null, { prompt_tokens: -1, completion_tokens: 2, cost: 0.1 }, { prompt_tokens: 1, completion_tokens: 2, cost: "0.1" }]) {
      const body = officialBody();
      if (usage === undefined) delete (body as Record<string, unknown>).usage;
      else (body as Record<string, unknown>).usage = usage;
      const result = await createMemoryV3OpenRouterAdapter({ fetchImpl: recordingFetch(() => jsonResponse(body)), apiKey: API_KEY })(request());
      assert.equal(result.usage, null);
    }
  });

  it("keeps one timer active through body read and clears it exactly once", async () => {
    const pending = new Map<unknown, () => void>();
    let nextHandle = 0;
    let clears = 0;
    const setTimeoutImpl = (handler: () => void) => { const handle = ++nextHandle; pending.set(handle, handler); return handle; };
    const clearTimeoutImpl = (handle: unknown) => { clears += 1; pending.delete(handle); };
    const response = jsonResponse(officialBody());
    const originalText = response.text.bind(response);
    Object.defineProperty(response, "text", { value: async () => {
      assert.equal(pending.size, 1);
      return await originalText();
    }, enumerable: false });
    await createMemoryV3OpenRouterAdapter({ fetchImpl: recordingFetch(() => response), apiKey: API_KEY, setTimeoutImpl, clearTimeoutImpl })(request());
    assert.equal(pending.size, 0);
    assert.equal(clears, 1);
  });

  it("clears a successfully installed timer even when its handle is undefined", async () => {
    let clears = 0;
    let clearedHandle: unknown = "not-called";
    await createMemoryV3OpenRouterAdapter({
      fetchImpl: recordingFetch(),
      apiKey: API_KEY,
      setTimeoutImpl: () => undefined,
      clearTimeoutImpl: (handle) => { clears += 1; clearedHandle = handle; },
    })(request());
    assert.equal(clears, 1);
    assert.equal(clearedHandle, undefined);
  });

  it("ignores a late timer callback after a successful response was cleaned up", async () => {
    let timeoutHandler: (() => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    let clears = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return await recordingFetch()(url, init);
    }) as typeof fetch;

    const result = await createMemoryV3OpenRouterAdapter({
      fetchImpl,
      apiKey: API_KEY,
      setTimeoutImpl: (handler) => { timeoutHandler = handler; return 1; },
      clearTimeoutImpl: () => { clears += 1; },
    })(request());

    assert.equal(result.content, JSON.stringify(validLayeredResponse));
    assert.equal(capturedSignal?.aborted, false);
    assert.equal(clears, 1);
    timeoutHandler!();
    assert.equal(capturedSignal?.aborted, false);
  });

  it("does not start HTTP when the injected timeout fires during installation", async () => {
    const fetchImpl = recordingFetch();
    let clears = 0;
    const operation = createMemoryV3OpenRouterAdapter({
      fetchImpl,
      apiKey: API_KEY,
      setTimeoutImpl: (handler) => { handler(); return undefined; },
      clearTimeoutImpl: () => { clears += 1; },
    })(request());
    const error = await captureError(() => operation);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(error), "transport_timeout");
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(clears, 1);
  });

  it("aborts once and rejects a hanging response body on timeout", async () => {
    let timeoutHandler: (() => void) | undefined;
    let clears = 0;
    let aborts = 0;
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = recordingFetch(() => {
      const response = new Response("unused");
      Object.defineProperty(response, "text", { value: () => new Promise<string>(() => {}), enumerable: false });
      return response;
    });
    const wrappedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return await fetchImpl(url, init);
    }) as typeof fetch;
    const operation = createMemoryV3OpenRouterAdapter({
      fetchImpl: wrappedFetch,
      apiKey: API_KEY,
      setTimeoutImpl: (handler) => { timeoutHandler = handler; return 1; },
      clearTimeoutImpl: () => { clears += 1; },
    })(request());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capturedSignal?.aborted, false);
    capturedSignal?.addEventListener("abort", () => { aborts += 1; });
    timeoutHandler!();
    timeoutHandler!();
    const error = await captureError(() => operation);
    assert.equal(capturedSignal?.aborted, true);
    assert.equal(aborts, 1);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(error), "transport_timeout");
    assert.equal(clears, 1);
  });

  it("does not retry fetch failures or trust spoofed diagnostics", async () => {
    const spoof = Object.assign(new Error(RAW_SECRET), { name: "MemoryV3TransportError", diagnosticCode: "provider_http_4xx" });
    const fetchImpl = recordingFetch(() => Promise.reject(spoof));
    const error = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: `${API_KEY}-${RAW_SECRET}` })(request()));
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(error), "transport_failed");
    assert.equal(error.message.includes(RAW_SECRET), false);
    assert.equal(JSON.stringify(error).includes(RAW_SECRET), false);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(spoof), null);
  });

  it("does not trust a real branded error when an external fetch or body rethrows it", async () => {
    const first = await captureError(() => createMemoryV3OpenRouterAdapter({
      fetchImpl: recordingFetch(() => new Response("", { status: 400 })),
      apiKey: API_KEY,
    })(request()));
    assert.equal(projectSafeMemoryV3TransportDiagnostic(first), "provider_http_4xx");

    const fetchReject = recordingFetch(() => Promise.reject(first));
    const fetchError = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl: fetchReject, apiKey: API_KEY })(request()));
    assert.notEqual(fetchError, first);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(fetchError), "transport_failed");

    const response = jsonResponse(officialBody());
    Object.defineProperty(response, "text", { value: () => Promise.reject(first), enumerable: false });
    const bodyError = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl: recordingFetch(() => response), apiKey: API_KEY })(request()));
    assert.notEqual(bodyError, first);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(bodyError), "provider_response_invalid");
  });

  it("does not trust a real branded error thrown from config, request, or response Proxy traps", async () => {
    const branded = await captureError(() => createMemoryV3OpenRouterAdapter({
      fetchImpl: recordingFetch(() => new Response("", { status: 400 })),
      apiKey: API_KEY,
    })(request()));

    const malicious = () => new Proxy({}, { getPrototypeOf() { throw branded; } });
    let configError: unknown;
    try { createMemoryV3OpenRouterAdapter(malicious() as never); } catch (error) { configError = error; }
    assert.ok(configError instanceof Error);
    assert.notEqual(configError, branded);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(configError), null);

    const adapter = createMemoryV3OpenRouterAdapter({ fetchImpl: recordingFetch(), apiKey: API_KEY });
    const requestError = await captureError(() => adapter(malicious() as never));
    assert.notEqual(requestError, branded);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(requestError), null);

    const responseError = await captureError(() => createMemoryV3OpenRouterAdapter({
      fetchImpl: recordingFetch(() => malicious() as Response),
      apiKey: API_KEY,
    })(request()));
    assert.notEqual(responseError, branded);
    assert.equal(projectSafeMemoryV3TransportDiagnostic(responseError), "provider_response_invalid");
  });

  it("rejects accessor, Proxy, and revoked response objects without executing getters", async () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "status", { enumerable: true, get() { getterCalls += 1; return 200; } });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const [returned, expectedDiagnostic] of [
      [accessor, "provider_response_invalid"],
      [proxy, "transport_failed"],
    ] as const) {
      const fetchImpl = recordingFetch(() => returned as Response);
      const error = await captureError(() => createMemoryV3OpenRouterAdapter({ fetchImpl, apiKey: API_KEY })(request()));
      assert.equal(projectSafeMemoryV3TransportDiagnostic(error), expectedDiagnostic);
    }
    assert.equal(getterCalls, 0);
  });
});
