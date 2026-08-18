/**
 * Memory V3 Task 3B — injected HTTP fetch transport tests.
 * Fake fetchImpl only. No network, env, or provider I/O.
 * Run: node --test scripts/memory-v3-pilot/openrouter-fetch-transport.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpenRouterFetchTransport } from './openrouter-fetch-transport.mjs';
import { createOpenRouterAdapter } from './openrouter-adapter.mjs';
import { buildExtractorRequest } from './extractor-prompt.mjs';
import { extractCase } from './extractor-core.mjs';

const API_KEY = 'test-memory-v3-openrouter-key';
const MODEL = 'openai/gpt-5.6-luna';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';

const SENTINELS = Object.freeze({
  fetch: 'GLOBAL_FETCH_SENTINEL',
  body: 'RAW_FETCH_BODY_SENTINEL',
  getter: 'RAW_FETCH_GETTER_SENTINEL',
  trap: 'RAW_FETCH_TRAP_SENTINEL',
  fakeBrand: 'RAW_FAKE_FETCH_BRAND',
  dialogue: 'RAW_DIALOGUE_SECRET_SENTINEL',
  gold: 'LEAK_GOLD_SENTINEL',
});

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1677652288,
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
    usage: {
      prompt_tokens: 25,
      completion_tokens: 10,
      total_tokens: 35,
    },
  };
}

function validTransportRequest(overrides = {}) {
  return {
    url: OPENROUTER_URL,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: MODEL,
      messages: [
        { role: 'system', content: 'system-text' },
        { role: 'user', content: '{"caseId":"c1"}' },
      ],
      stream: false,
      max_tokens: 1200,
      secretProbe: SENTINELS.body,
    },
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    async text() {
      return text;
    },
  };
}

function recordingFetch(payload = jsonResponse(officialOpenRouterHttpBody())) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof payload === 'function' ? payload(url, init) : payload;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createFakeClock() {
  let nextId = 0;
  const pending = new Map();
  let cleared = 0;
  return {
    setTimeoutImpl(fn) {
      const id = (nextId += 1);
      pending.set(id, fn);
      return id;
    },
    clearTimeoutImpl(id) {
      cleared += 1;
      pending.delete(id);
    },
    fireAll() {
      for (const fn of [...pending.values()]) fn();
    },
    get pendingCount() {
      return pending.size;
    },
    get clearedCount() {
      return cleared;
    },
  };
}

function validOptions(overrides = {}) {
  return {
    fetchImpl: recordingFetch(),
    timeoutMs: 1000,
    maxResponseBytes: 1_000_000,
    ...overrides,
  };
}

function assertPrefix(error, stage) {
  assert.match(String(error.message), new RegExp(`^\\[memory-v3:fetch-${stage}\\]`));
}

function assertNoSecrets(error) {
  const message = String(error && error.message);
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(message.includes(sentinel), false, `error leaked ${sentinel}`);
    assert.equal(serialized.includes(sentinel), false, `error serialization leaked ${sentinel}`);
  }
  assert.equal(message.includes(API_KEY), false);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(error.cause == null, true);
}

async function assertRejectsStage(fn, stage) {
  await assert.rejects(
    async () => {
      await fn();
    },
    (error) => {
      assertPrefix(error, stage);
      assertNoSecrets(error);
      return true;
    },
  );
}

describe('createOpenRouterFetchTransport config', () => {
  it('requires fetchImpl, positive timeoutMs, and safe maxResponseBytes', async () => {
    await assertRejectsStage(() => createOpenRouterFetchTransport({}), 'config');
    await assertRejectsStage(
      () => createOpenRouterFetchTransport(validOptions({ fetchImpl: null })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterFetchTransport(validOptions({ timeoutMs: 0 })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterFetchTransport(validOptions({ timeoutMs: 1.5 })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterFetchTransport(validOptions({ maxResponseBytes: 0 })),
      'config',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterFetchTransport(
          validOptions({ maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }),
        ),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterFetchTransport(validOptions({ setTimeoutImpl: () => 1 })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterFetchTransport(validOptions({ clearTimeoutImpl: () => {} })),
      'config',
    );
  });
});

describe('createOpenRouterFetchTransport request', () => {
  it('calls fetchImpl once with serialized JSON body and AbortSignal', async () => {
    const fetchImpl = recordingFetch();
    const transport = createOpenRouterFetchTransport(validOptions({ fetchImpl }));
    const request = validTransportRequest();
    const snapshot = structuredClone(request);

    const result = await transport(request);

    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(call.url, OPENROUTER_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(typeof call.init.body, 'string');
    assert.equal(call.init.body, JSON.stringify(request.body));
    assert.equal(call.init.body.includes(API_KEY), false);
    assert.ok(call.init.signal);
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, EMPTY_CONTENT);
    assert.deepEqual(request, snapshot);
  });

  it('does not call global fetch and does not retry', async () => {
    const previous = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    const counts = { sync: 0, async: 0 };
    try {
      const ok = recordingFetch();
      await createOpenRouterFetchTransport(validOptions({ fetchImpl: ok }))(validTransportRequest());
      assert.equal(fetchCalls, 0);
      assert.equal(ok.calls.length, 1);

      const adapterSync = createOpenRouterFetchTransport(
        validOptions({
          fetchImpl: () => {
            counts.sync += 1;
            throw new Error(SENTINELS.body);
          },
        }),
      );
      const adapterAsync = createOpenRouterFetchTransport(
        validOptions({
          fetchImpl: async () => {
            counts.async += 1;
            return Promise.reject(new Error(SENTINELS.body));
          },
        }),
      );
      await assertRejectsStage(() => adapterSync(validTransportRequest()), 'transport');
      await assertRejectsStage(() => adapterAsync(validTransportRequest()), 'transport');
      assert.equal(counts.sync, 1);
      assert.equal(counts.async, 1);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('rejects non-OpenRouter urls, non-POST methods, and string bodies', async () => {
    const transport = createOpenRouterFetchTransport(validOptions());
    await assertRejectsStage(
      () => transport(validTransportRequest({ url: 'https://example.test/v1' })),
      'request',
    );
    await assertRejectsStage(
      () => transport(validTransportRequest({ method: 'GET' })),
      'request',
    );
    await assertRejectsStage(
      () => transport(validTransportRequest({ body: JSON.stringify({ model: MODEL }) })),
      'request',
    );
  });

  it('rejects getter, symbol, and non-enumerable request fields without running getters', async () => {
    const transport = createOpenRouterFetchTransport(validOptions());
    const getterRequest = validTransportRequest();
    let getterCalls = 0;
    Object.defineProperty(getterRequest, 'url', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertRejectsStage(() => transport(getterRequest), 'request');
    assert.equal(getterCalls, 0);

    const withSymbol = validTransportRequest();
    withSymbol[Symbol('hidden')] = SENTINELS.getter;
    await assertRejectsStage(() => transport(withSymbol), 'request');

    const hidden = validTransportRequest();
    Object.defineProperty(hidden, 'secret', {
      enumerable: false,
      value: SENTINELS.getter,
    });
    await assertRejectsStage(() => transport(hidden), 'request');
  });
});

describe('createOpenRouterFetchTransport response and timeout', () => {
  it('rejects oversized and non-JSON HTTP bodies without leaking content', async () => {
    const oversized = 'x'.repeat(64);
    const transportOversize = createOpenRouterFetchTransport(
      validOptions({
        maxResponseBytes: 16,
        fetchImpl: recordingFetch(jsonResponse(oversized)),
      }),
    );
    await assertRejectsStage(() => transportOversize(validTransportRequest()), 'response');

    const transportInvalid = createOpenRouterFetchTransport(
      validOptions({
        fetchImpl: recordingFetch(jsonResponse(`not-json ${SENTINELS.body}`)),
      }),
    );
    await assertRejectsStage(() => transportInvalid(validTransportRequest()), 'response');
  });

  it('times out a hanging response.text after headers with a fake clock', async () => {
    const clock = createFakeClock();
    let fetchCalls = 0;
    let textCalls = 0;
    const transport = createOpenRouterFetchTransport(
      validOptions({
        timeoutMs: 50,
        setTimeoutImpl: clock.setTimeoutImpl,
        clearTimeoutImpl: clock.clearTimeoutImpl,
        fetchImpl: async (url, init) => {
          fetchCalls += 1;
          return {
            status: 200,
            text() {
              textCalls += 1;
              return new Promise((_, reject) => {
                init.signal.addEventListener('abort', () => {
                  const error = new Error('Aborted');
                  error.name = 'AbortError';
                  reject(error);
                });
              });
            },
          };
        },
      }),
    );
    const pending = transport(validTransportRequest());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchCalls, 1);
    assert.equal(textCalls, 1);
    assert.equal(clock.pendingCount, 1);
    clock.fireAll();
    await assertRejectsStage(() => pending, 'timeout');
    assert.equal(fetchCalls, 1);
    assert.equal(textCalls, 1);
    assert.equal(clock.clearedCount, 1);
    assert.equal(clock.pendingCount, 0);
  });

  it('does not trust a spoofed internal error name from fetchImpl', async () => {
    const transport = createOpenRouterFetchTransport(
      validOptions({
        fetchImpl: () => {
          const error = new Error(SENTINELS.fakeBrand);
          error.name = 'MemoryV3FetchError';
          throw error;
        },
      }),
    );
    await assertRejectsStage(() => transport(validTransportRequest()), 'transport');
  });

  it('keeps Proxy trap messages out of public errors', async () => {
    const transport = createOpenRouterFetchTransport(validOptions());
    const proxied = new Proxy(validTransportRequest(), {
      ownKeys() {
        throw new Error(SENTINELS.trap);
      },
    });
    await assertRejectsStage(() => transport(proxied), 'request');
  });
});

describe('createOpenRouterFetchTransport composition', () => {
  it('feeds adapter and extractCase from a fake HTTP JSON body', async () => {
    const fetchImpl = recordingFetch(jsonResponse(officialOpenRouterHttpBody()));
    const transport = createOpenRouterFetchTransport(validOptions({ fetchImpl }));
    const adapter = createOpenRouterAdapter({
      transport,
      apiKey: API_KEY,
      model: MODEL,
      maxOutputTokens: 1200,
    });
    const caseData = {
      caseId: 'fetch-case-01',
      title: SENTINELS.gold,
      category: 'biographical',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: `${SENTINELS.dialogue} Переехала в Казань.`,
          createdAt: '2024-01-10T10:00:00.000Z',
        },
      ],
      gold: {
        events: [{ claim: SENTINELS.gold, supportMessageIds: ['m1'] }],
        recurrences: [],
        hypotheses: [],
      },
      mustNotRemember: [],
    };
    const extraction = await extractCase(caseData, adapter, {
      extractorVersion: 'offline-core-v1',
    });
    assert.deepEqual(extraction.items, []);
    assert.deepEqual(extraction.evidence, []);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, OPENROUTER_URL);
    const serialized = JSON.stringify(fetchImpl.calls[0].init.body);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(buildExtractorRequest(caseData).system.includes(SENTINELS.dialogue), false);
  });
});
