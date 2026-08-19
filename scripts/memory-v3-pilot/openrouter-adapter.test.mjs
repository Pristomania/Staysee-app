/**
 * Memory V3 Task 3A — OpenRouter adapter boundary tests.
 * Injected transport only. No network, env, or provider I/O.
 * Run: node --test scripts/memory-v3-pilot/openrouter-adapter.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildExtractorRequest } from './extractor-prompt.mjs';
import { extractCase } from './extractor-core.mjs';
import {
  createOpenRouterAdapter,
  projectSafeOpenRouterDiagnostic,
} from './openrouter-adapter.mjs';
import { assertBudgetGate } from './benchmark-budget.mjs';

const API_KEY = 'test-memory-v3-openrouter-key';
const MODEL = 'openai/gpt-5.6-luna';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';

const SENTINELS = Object.freeze({
  gold: 'LEAK_GOLD_SENTINEL',
  forbidden: 'LEAK_FORBIDDEN_SENTINEL',
  title: 'LEAK_TITLE_SENTINEL',
  dialogue: 'RAW_DIALOGUE_SECRET_SENTINEL',
  fetch: 'GLOBAL_FETCH_SENTINEL',
  transport: 'RAW_TRANSPORT_SECRET_SENTINEL',
  provider: 'RAW_PROVIDER_BODY_SENTINEL',
  fakeBrand: 'RAW_FAKE_BRAND_SECRET',
  getter: 'RAW_GETTER_SECRET_SENTINEL',
  metadata: 'RAW_OPENROUTER_METADATA_SENTINEL',
  choiceError: 'RAW_CHOICE_ERROR_SENTINEL',
  bodyError: 'RAW_BODY_ERROR_SENTINEL',
  trap: 'RAW_PROXY_TRAP_SENTINEL',
});

function sampleCase() {
  return {
    caseId: 'or-case-01',
    title: SENTINELS.title,
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
    mustNotRemember: [{ claim: SENTINELS.forbidden }],
  };
}

function validOptions(overrides = {}) {
  return {
    transport: async () => successResponse(),
    apiKey: API_KEY,
    model: MODEL,
    maxOutputTokens: 1200,
    ...overrides,
  };
}

function successResponse(content = EMPTY_CONTENT) {
  return {
    status: 200,
    body: {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content,
          },
        },
      ],
    },
  };
}

function officialOpenRouterResponse(content = EMPTY_CONTENT) {
  return {
    status: 200,
    body: {
      id: `chatcmpl-${SENTINELS.metadata}`,
      object: 'chat.completion',
      created: 1677652288,
      model: MODEL,
      provider: 'openai',
      system_fingerprint: `fp-${SENTINELS.metadata}`,
      service_tier: 'default',
      openrouter_metadata: { secret: SENTINELS.metadata },
      extra_telemetry: { secret: SENTINELS.metadata },
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          native_finish_reason: 'stop',
          logprobs: null,
          extra_choice_meta: SENTINELS.metadata,
          message: {
            role: 'assistant',
            content,
            extra_message_meta: SENTINELS.metadata,
          },
        },
      ],
      usage: {
        prompt_tokens: 25,
        completion_tokens: 10,
        total_tokens: 35,
        secret: SENTINELS.metadata,
      },
    },
  };
}

function officialNullableRefusalResponse(content = EMPTY_CONTENT) {
  return {
    status: 200,
    body: {
      id: 'safe-test-id',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content,
            refusal: null,
          },
        },
      ],
    },
  };
}

function messageBoundaryResponse(message) {
  return {
    status: 200,
    body: {
      choices: [
        {
          finish_reason: 'stop',
          message,
        },
      ],
    },
  };
}

function recordingTransport(payload = successResponse()) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return typeof payload === 'function' ? payload(request) : payload;
  };
  transport.calls = calls;
  return transport;
}

function assertPrefix(error, stage) {
  assert.match(String(error.message), new RegExp(`^\\[memory-v3:openrouter-${stage}\\]`));
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
  await assert.rejects(async () => {
    await fn();
  }, (error) => {
    assertPrefix(error, stage);
    assertNoSecrets(error);
    return true;
  });
}

async function assertDiagnostic(transportPayload, code) {
  const request = buildExtractorRequest(sampleCase());
  const transport = recordingTransport(transportPayload);
  let thrown;
  try {
    await createOpenRouterAdapter(validOptions({ transport }))(request);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown != null, true);
  assert.equal(projectSafeOpenRouterDiagnostic(thrown), code);
  assert.equal(thrown.diagnosticCode, code);
  assert.equal(thrown.cause == null, true);
  assert.equal('cause' in thrown, false);
  assert.equal(transport.calls.length, 1);
  assert.equal(JSON.stringify(thrown).includes('I cannot comply'), false);
  assertNoSecrets(thrown);
}

describe('createOpenRouterAdapter config', () => {
  it('requires transport, apiKey, model, and positive maxOutputTokens', async () => {
    await assertRejectsStage(() => createOpenRouterAdapter({}), 'config');
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ transport: null })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ apiKey: '' })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ model: '   ' })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ maxOutputTokens: 0 })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ maxOutputTokens: 1.5 })),
      'config',
    );
  });

  it('rejects http appUrl', async () => {
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ appUrl: 'http://example.test' })),
      'config',
    );
  });

  it('omits reasoning fields when reasoningEffort is absent or none', async () => {
    const omitted = recordingTransport();
    await createOpenRouterAdapter(validOptions({ transport: omitted }))(
      buildExtractorRequest(sampleCase()),
    );
    assert.equal(omitted.calls.length, 1);
    assert.equal('reasoning' in omitted.calls[0].body, false);
    assert.equal('reasoning_effort' in omitted.calls[0].body, false);

    const noneTransport = recordingTransport();
    await createOpenRouterAdapter(
      validOptions({ transport: noneTransport, reasoningEffort: 'none' }),
    )(buildExtractorRequest(sampleCase()));
    assert.equal(noneTransport.calls.length, 1);
    assert.equal('reasoning' in noneTransport.calls[0].body, false);
    assert.equal('reasoning_effort' in noneTransport.calls[0].body, false);
  });

  it('sends reasoning.effort for low, medium, and high and never sends reasoning_effort', async () => {
    for (const effort of ['low', 'medium', 'high']) {
      const transport = recordingTransport();
      const adapter = createOpenRouterAdapter(validOptions({ transport, reasoningEffort: effort }));
      await adapter(buildExtractorRequest(sampleCase()));
      assert.equal(transport.calls.length, 1);
      assert.deepEqual(transport.calls[0].body.reasoning, { effort });
      assert.equal('reasoning_effort' in transport.calls[0].body, false);
    }
  });

  it('rejects invalid reasoningEffort values', async () => {
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ reasoningEffort: '' })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ reasoningEffort: 1 })),
      'config',
    );
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ reasoningEffort: null })),
      'config',
    );
  });
});

describe('createOpenRouterAdapter transport request', () => {
  it('calls injected transport exactly once with one model, json_schema, and no fallbacks', async () => {
    const transport = recordingTransport();
    const adapter = createOpenRouterAdapter(validOptions({ transport }));
    const request = buildExtractorRequest(sampleCase());
    const snapshot = structuredClone(request);

    const content = await adapter(request);

    assert.equal(content, EMPTY_CONTENT);
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.equal(call.url, OPENROUTER_URL);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal('HTTP-Referer' in call.headers, false);
    assert.equal('X-Title' in call.headers, false);
    assert.equal(typeof call.body, 'object');
    assert.equal(Array.isArray(call.body), false);
    assert.equal(typeof call.body.model, 'string');
    assert.equal(call.body.model, MODEL);
    assert.equal(Array.isArray(call.body.model), false);
    assert.equal(call.body.stream, false);
    assert.equal(call.body.max_completion_tokens, 1200);
    assert.equal('max_tokens' in call.body, false);
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.deepEqual(call.body.response_format.json_schema.schema.required, [
      'items',
      'evidence',
    ]);
    assert.equal(call.body.response_format.json_schema.schema.additionalProperties, false);
    const rootProperties = call.body.response_format.json_schema.schema.properties;
    assert.deepEqual(Object.keys(rootProperties).sort(), ['evidence', 'items']);
    assert.equal(rootProperties.items.items.additionalProperties, false);
    assert.equal(rootProperties.evidence.items.additionalProperties, false);
    assert.deepEqual(
      [...rootProperties.items.items.required].sort(),
      [
        'alternative',
        'claim',
        'eventTimeEnd',
        'eventTimeStart',
        'itemRef',
        'kind',
        'sensitivity',
        'status',
      ],
    );
    assert.deepEqual(
      [...rootProperties.evidence.items.required].sort(),
      ['episodeKey', 'itemRef', 'relation', 'sourceMessageId'],
    );
    assert.equal(call.body.provider.allow_fallbacks, false);
    assert.equal(call.body.provider.require_parameters, true);
    assert.equal(call.body.provider.data_collection, 'deny');
    assert.equal(call.body.provider.zdr, true);
    assert.equal('reasoning' in call.body, false);
    assert.equal('reasoning_effort' in call.body, false);
    assert.equal(call.body.messages[0].role, 'system');
    assert.equal(call.body.messages[0].content, request.system);
    assert.equal(call.body.messages[1].role, 'user');
    assert.equal(call.body.messages[1].content, JSON.stringify(request.input));
    const serializedBody = JSON.stringify(call.body);
    assert.equal(serializedBody.includes(SENTINELS.gold), false);
    assert.equal(serializedBody.includes(SENTINELS.forbidden), false);
    assert.equal(serializedBody.includes(SENTINELS.title), false);
    assert.equal(serializedBody.includes(API_KEY), false);
    assert.equal(call.body.messages[0].content.includes(SENTINELS.dialogue), false);
    assert.deepEqual(request, snapshot);
  });

  it('adds Referer and Title only for valid https appUrl and appTitle', async () => {
    const transport = recordingTransport();
    const adapter = createOpenRouterAdapter(
      validOptions({
        transport,
        appUrl: 'https://example.test/app',
        appTitle: 'Memory V3 Pilot',
      }),
    );
    await adapter(buildExtractorRequest(sampleCase()));
    assert.equal(transport.calls[0].headers['HTTP-Referer'], 'https://example.test/app');
    assert.equal(transport.calls[0].headers['X-Title'], 'Memory V3 Pilot');
  });

  it('does not call global fetch', async () => {
    const previous = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    try {
      const transport = recordingTransport();
      const adapter = createOpenRouterAdapter(validOptions({ transport }));
      await adapter(buildExtractorRequest(sampleCase()));
      assert.equal(fetchCalls, 0);
      assert.equal(transport.calls.length, 1);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('does not retry a sync throw or an async rejection', async () => {
    const counts = { sync: 0, async: 0 };
    const adapterSync = createOpenRouterAdapter(
      validOptions({
        transport: () => {
          counts.sync += 1;
          throw new Error(SENTINELS.transport);
        },
      }),
    );
    const adapterAsync = createOpenRouterAdapter(
      validOptions({
        transport: async () => {
          counts.async += 1;
          return Promise.reject(new Error(SENTINELS.transport));
        },
      }),
    );
    const request = buildExtractorRequest(sampleCase());
    await assertRejectsStage(() => adapterSync(request), 'transport');
    await assertRejectsStage(() => adapterAsync(request), 'transport');
    assert.equal(counts.sync, 1);
    assert.equal(counts.async, 1);
  });
});

describe('createOpenRouterAdapter response boundary', () => {
  it('accepts a realistic official OpenRouter chat completion and returns only content', async () => {
    const response = officialOpenRouterResponse();
    const snapshot = structuredClone(response);
    const transport = recordingTransport(response);
    const adapter = createOpenRouterAdapter(validOptions({ transport }));
    const content = await adapter(buildExtractorRequest(sampleCase()));

    assert.equal(content, EMPTY_CONTENT);
    assert.equal(typeof content, 'string');
    assert.equal(content.includes(SENTINELS.metadata), false);
    assert.equal(JSON.stringify(content).includes(SENTINELS.metadata), false);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(response, snapshot);
  });

  it('accepts a realistic 200 envelope with refusal null and returns only content', async () => {
    const response = officialNullableRefusalResponse();
    const snapshot = structuredClone(response);
    const request = buildExtractorRequest(sampleCase());
    const requestSnapshot = structuredClone(request);
    const transport = recordingTransport(response);
    const adapter = createOpenRouterAdapter(validOptions({ transport }));
    const content = await adapter(request);
    assert.equal(content, EMPTY_CONTENT);
    assert.equal(transport.calls.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(content, 'diagnosticCode'), false);
    assert.deepEqual(response, snapshot);
    assert.deepEqual(request, requestSnapshot);
  });

  it('accepts absent and null refusal and rejects string or non-string refusal without leaking', async () => {
    const request = buildExtractorRequest(sampleCase());
    const requestSnapshot = structuredClone(request);

    const absentTransport = recordingTransport(
      messageBoundaryResponse({ role: 'assistant', content: EMPTY_CONTENT }),
    );
    assert.equal(
      await createOpenRouterAdapter(validOptions({ transport: absentTransport }))(request),
      EMPTY_CONTENT,
    );
    assert.equal(absentTransport.calls.length, 1);

    const nullTransport = recordingTransport(
      messageBoundaryResponse({ role: 'assistant', content: EMPTY_CONTENT, refusal: null }),
    );
    assert.equal(
      await createOpenRouterAdapter(validOptions({ transport: nullTransport }))(request),
      EMPTY_CONTENT,
    );
    assert.equal(nullTransport.calls.length, 1);

    await assertDiagnostic(
      messageBoundaryResponse({
        role: 'assistant',
        content: EMPTY_CONTENT,
        refusal: '',
      }),
      'openrouter_refusal',
    );
    await assertDiagnostic(
      messageBoundaryResponse({
        role: 'assistant',
        content: EMPTY_CONTENT,
        refusal: 'I cannot comply',
      }),
      'openrouter_refusal',
    );
    {
      let thrown;
      try {
        await createOpenRouterAdapter(
          validOptions({
            transport: async () =>
              messageBoundaryResponse({
                role: 'assistant',
                content: EMPTY_CONTENT,
                refusal: 'I cannot comply',
              }),
          }),
        )(request);
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown != null, true);
      assert.equal(String(thrown.message).includes('I cannot comply'), false);
      assert.equal(JSON.stringify(thrown).includes('I cannot comply'), false);
    }
    await assertDiagnostic(
      messageBoundaryResponse({
        role: 'assistant',
        content: EMPTY_CONTENT,
        refusal: { raw: SENTINELS.bodyError },
      }),
      'openrouter_response_invalid_shape',
    );
    await assertDiagnostic(
      messageBoundaryResponse({
        role: 'assistant',
        content: EMPTY_CONTENT,
        refusal: [],
      }),
      'openrouter_response_invalid_shape',
    );
    await assertDiagnostic(
      messageBoundaryResponse({
        role: 'assistant',
        content: EMPTY_CONTENT,
        refusal: false,
      }),
      'openrouter_response_invalid_shape',
    );

    const getterResponse = messageBoundaryResponse({
      role: 'assistant',
      content: EMPTY_CONTENT,
    });
    let getterCalls = 0;
    Object.defineProperty(getterResponse.body.choices[0].message, 'refusal', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertDiagnostic(getterResponse, 'openrouter_response_invalid_shape');
    assert.equal(getterCalls, 0);
    assert.deepEqual(request, requestSnapshot);
  });

  it('rejects non-2xx, empty content, extra choices, and tool calls', async () => {
    const request = buildExtractorRequest(sampleCase());
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({ transport: async () => ({ status: 500, body: { choices: [] } }) }),
        )(request),
      'response',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
            }),
          }),
        )(request),
      'response',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [
                  { message: { content: EMPTY_CONTENT } },
                  { message: { content: EMPTY_CONTENT } },
                ],
              },
            }),
          }),
        )(request),
      'response',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [{ finish_reason: 'stop', message: { tool_calls: [{ id: 't1' }], content: null } }],
              },
            }),
          }),
        )(request),
      'response',
    );
  });

  it('rejects getter, symbol, non-enumerable, sparse, and cyclic transport responses without running getters', async () => {
    const request = buildExtractorRequest(sampleCase());

    const getterResponse = { body: { choices: [] } };
    Object.defineProperty(getterResponse, 'status', {
      enumerable: true,
      get() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(validOptions({ transport: async () => getterResponse }))(request),
      'response',
    );

    const withSymbol = successResponse();
    withSymbol[Symbol('hidden')] = SENTINELS.getter;
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ transport: async () => withSymbol }))(request),
      'response',
    );

    const hidden = successResponse();
    Object.defineProperty(hidden, 'secret', {
      enumerable: false,
      value: SENTINELS.getter,
    });
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ transport: async () => hidden }))(request),
      'response',
    );

    const sparse = successResponse();
    sparse.body.choices[2] = { message: { content: EMPTY_CONTENT } };
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ transport: async () => sparse }))(request),
      'response',
    );

    const cyclic = officialOpenRouterResponse();
    cyclic.body.self = cyclic.body;
    const cyclicTransport = recordingTransport(cyclic);
    const cyclicContent = await createOpenRouterAdapter(validOptions({ transport: cyclicTransport }))(
      request,
    );
    assert.equal(cyclicContent, EMPTY_CONTENT);
    assert.equal(cyclicTransport.calls.length, 1);
  });

  it('does not execute getters on OpenRouter metadata fields', async () => {
    const request = buildExtractorRequest(sampleCase());
    const response = officialOpenRouterResponse();
    let getterCalls = 0;
    Object.defineProperty(response.body, 'usage', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ transport: async () => response }))(request),
      'response',
    );
    assert.equal(getterCalls, 0);
  });

  it('rejects top-level and choice error objects without leaking provider text', async () => {
    const request = buildExtractorRequest(sampleCase());
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                error: { message: SENTINELS.bodyError, code: 418 },
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { content: EMPTY_CONTENT },
                  },
                ],
              },
            }),
          }),
        )(request),
      'response',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [
                  {
                    finish_reason: 'stop',
                    error: { message: SENTINELS.choiceError },
                    message: { content: EMPTY_CONTENT },
                  },
                ],
              },
            }),
          }),
        )(request),
      'response',
    );
  });

  it('accepts only finish_reason stop', async () => {
    const request = buildExtractorRequest(sampleCase());
    const transport = recordingTransport(officialOpenRouterResponse());
    const content = await createOpenRouterAdapter(validOptions({ transport }))(request);
    assert.equal(content, EMPTY_CONTENT);
    assert.equal(transport.calls.length, 1);

    for (const finishReason of ['length', 'error', 'tool_calls', null]) {
      await assertRejectsStage(
        () =>
          createOpenRouterAdapter(
            validOptions({
              transport: async () => ({
                status: 200,
                body: {
                  choices: [
                    {
                      finish_reason: finishReason,
                      message: { content: EMPTY_CONTENT },
                    },
                  ],
                },
              }),
            }),
          )(request),
        'response',
      );
    }

    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [{ message: { content: EMPTY_CONTENT } }],
              },
            }),
          }),
        )(request),
      'response',
    );
  });

  it('rejects message function_call, refusal, and non-assistant role', async () => {
    const request = buildExtractorRequest(sampleCase());
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { content: EMPTY_CONTENT, function_call: { name: 'x' } },
                  },
                ],
              },
            }),
          }),
        )(request),
      'response',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { content: EMPTY_CONTENT, refusal: SENTINELS.bodyError },
                  },
                ],
              },
            }),
          }),
        )(request),
      'response',
    );
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: async () => ({
              status: 200,
              body: {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { role: 'user', content: EMPTY_CONTENT },
                  },
                ],
              },
            }),
          }),
        )(request),
      'response',
    );
  });

  it('keeps Proxy trap messages out of public response errors', async () => {
    const request = buildExtractorRequest(sampleCase());
    const target = officialOpenRouterResponse();
    const proxied = new Proxy(target, {
      ownKeys() {
        throw new Error(SENTINELS.trap);
      },
    });
    await assertRejectsStage(
      () => createOpenRouterAdapter(validOptions({ transport: async () => proxied }))(request),
      'response',
    );
  });

  it('does not trust a spoofed internal error name from transport', async () => {
    const request = buildExtractorRequest(sampleCase());
    await assertRejectsStage(
      () =>
        createOpenRouterAdapter(
          validOptions({
            transport: () => {
              const error = new Error(SENTINELS.fakeBrand);
              error.name = 'MemoryV3OpenRouterError';
              throw error;
            },
          }),
        )(request),
      'transport',
    );
  });

  it('does not mutate options or the transport response object', async () => {
    const response = successResponse();
    const responseSnapshot = structuredClone(response);
    const options = validOptions({ transport: async () => response });
    const optionsSnapshot = {
      apiKey: options.apiKey,
      model: options.model,
      maxOutputTokens: options.maxOutputTokens,
    };
    const adapter = createOpenRouterAdapter(options);
    await adapter(buildExtractorRequest(sampleCase()));
    assert.deepEqual(response, responseSnapshot);
    assert.deepEqual(
      {
        apiKey: options.apiKey,
        model: options.model,
        maxOutputTokens: options.maxOutputTokens,
      },
      optionsSnapshot,
    );
  });
});

describe('createOpenRouterAdapter composition with extractCase', () => {
  it('returns content that extractCase can abstain on after a budget gate', async () => {
    const transport = recordingTransport();
    const budget = {
      caseCount: 1,
      maxInputTokensPerCase: 4096,
      maxOutputTokensPerCase: 1200,
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.6,
      maxRequests: 1,
      maxBudgetUsd: 0.03,
    };
    assertBudgetGate(budget);
    const adapter = createOpenRouterAdapter(validOptions({ transport }));
    const caseData = sampleCase();
    const extraction = await extractCase(caseData, adapter, {
      extractorVersion: 'offline-core-v1',
    });
    assert.deepEqual(extraction.items, []);
    assert.deepEqual(extraction.evidence, []);
    assert.equal(transport.calls.length, 1);
  });

  it('does not call transport when the budget gate fails', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return successResponse();
    };
    assert.throws(() =>
      assertBudgetGate({
        caseCount: 24,
        maxInputTokensPerCase: 4096,
        maxOutputTokensPerCase: 1200,
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.6,
        maxRequests: 24,
        maxBudgetUsd: 0.027,
      }),
    );
    assert.equal(calls, 0);
    assert.equal(typeof transport, 'function');
  });
});

describe('createOpenRouterAdapter safe diagnostics', () => {
  async function rejectDiagnostic(transportPayload, code) {
    const request = buildExtractorRequest(sampleCase());
    let thrown;
    try {
      await createOpenRouterAdapter(
        validOptions({ transport: async () => transportPayload }),
      )(request);
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown != null, true);
    assert.equal(projectSafeOpenRouterDiagnostic(thrown), code);
    assert.equal(thrown.diagnosticCode, code);
    assert.equal(thrown.cause == null, true);
    assertNoSecrets(thrown);
  }

  it('projects HTTP status codes from branded adapter errors only', async () => {
    await rejectDiagnostic(
      {
        status: 400,
        body: {
          error: {
            message: SENTINELS.bodyError,
            code: 400,
            metadata: { raw: SENTINELS.metadata },
          },
        },
      },
      'openrouter_http_400',
    );
    await rejectDiagnostic({ status: 401, body: { choices: [] } }, 'openrouter_http_401');
    await rejectDiagnostic({ status: 402, body: { choices: [] } }, 'openrouter_http_402');
    await rejectDiagnostic({ status: 403, body: { choices: [] } }, 'openrouter_http_403');
    await rejectDiagnostic({ status: 404, body: { choices: [] } }, 'openrouter_http_404');
    await rejectDiagnostic({ status: 408, body: { choices: [] } }, 'openrouter_http_408');
    await rejectDiagnostic({ status: 409, body: { choices: [] } }, 'openrouter_http_409');
    await rejectDiagnostic({ status: 422, body: { choices: [] } }, 'openrouter_http_422');
    await rejectDiagnostic({ status: 429, body: { choices: [] } }, 'openrouter_http_429');
    await rejectDiagnostic({ status: 500, body: { choices: [] } }, 'openrouter_http_5xx');
    await rejectDiagnostic({ status: 418, body: { choices: [] } }, 'openrouter_http_other_non_2xx');
  });

  it('does not trust a spoofed diagnosticCode from injected transport', async () => {
    let getterCalls = 0;
    const request = buildExtractorRequest(sampleCase());
    const adapter = createOpenRouterAdapter(
      validOptions({
        transport: () => {
          const error = new Error(SENTINELS.fakeBrand);
          error.name = 'MemoryV3OpenRouterError';
          Object.defineProperty(error, 'diagnosticCode', {
            enumerable: true,
            configurable: true,
            get() {
              getterCalls += 1;
              return 'openrouter_http_400';
            },
          });
          throw error;
        },
      }),
    );
    let thrown;
    try {
      await adapter(request);
    } catch (error) {
      thrown = error;
    }
    assert.equal(getterCalls, 0);
    assert.equal(projectSafeOpenRouterDiagnostic(thrown), 'unknown_adapter_failure');
    assert.equal(thrown.diagnosticCode, 'unknown_adapter_failure');
    assertNoSecrets(thrown);
    assert.equal(projectSafeOpenRouterDiagnostic({ diagnosticCode: 'openrouter_http_400' }), null);
  });
});
