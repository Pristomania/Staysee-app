/**
 * Memory V3 Task 3C — live-smoke unit tests.
 * Fake fetch only. No live OpenRouter, env printing, or paid calls.
 * Run: node --test scripts/memory-v3-pilot/live-smoke.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createOnceOpenRouterFetch,
  parseOpenRouterApiKeyFromEnvText,
  runLiveSmokeFromArgv,
  runOneCaseLiveSmoke,
} from './live-smoke.mjs';

const CASE_ID = 'memv3-ru-counterexample-04';
const MODEL = 'openai/gpt-5.6-luna';
const EXTRACTOR_VERSION = 'memory-v3-openrouter-luna-smoke-v1';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = 'test-memory-v3-openrouter-key';
const ENV_SENTINEL = 'RAW_ENV_FILE_SECRET_SENTINEL';
const AUTH_SENTINEL = 'Bearer RAW_AUTHORIZATION_SECRET';

const SENTINELS = Object.freeze({
  key: API_KEY,
  env: ENV_SENTINEL,
  auth: AUTH_SENTINEL,
  system: 'RAW_SYSTEM_PROMPT_SENTINEL',
  messages: 'RAW_LIVE_MESSAGES_SENTINEL',
  response: 'RAW_PROVIDER_RESPONSE_SENTINEL',
  fetch: 'GLOBAL_FETCH_SENTINEL',
  providerMessage: 'RAW_PROVIDER_MESSAGE_SENTINEL',
  providerMetadata: 'RAW_PROVIDER_METADATA_SENTINEL',
});

const VALID_CONTENT = JSON.stringify({
  items: [
    {
      itemRef: 'item-1',
      kind: 'event',
      claim: 'Всю жизнь живёт в одном городе',
      status: 'active',
      sensitivity: 'normal',
      eventTimeStart: null,
      eventTimeEnd: null,
      alternative: null,
    },
  ],
  evidence: [
    {
      itemRef: 'item-1',
      sourceMessageId: 'm3',
      episodeKey: 'same-city-life',
      relation: 'supports',
    },
  ],
});

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v1.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function allowedBudget(overrides = {}) {
  return {
    caseCount: 1,
    maxInputTokensPerCase: 16384,
    maxOutputTokensPerCase: 1200,
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.2,
    maxRequests: 1,
    maxBudgetUsd: 0.005,
    ...overrides,
  };
}

function officialOpenRouterHttpBody(content = VALID_CONTENT) {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1677652288,
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content },
      },
    ],
    usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
    secretProbe: SENTINELS.response,
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
    if (typeof payload === 'function') return payload(url, init);
    return payload;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function validOptions(overrides = {}) {
  return {
    dataset: overrides.dataset ?? loadGoldenDataset(),
    caseId: overrides.caseId ?? CASE_ID,
    apiKey: overrides.apiKey ?? API_KEY,
    fetchImpl: overrides.fetchImpl ?? recordingFetch(),
    model: overrides.model ?? MODEL,
    extractorVersion: overrides.extractorVersion ?? EXTRACTOR_VERSION,
    reasoningEffort: overrides.reasoningEffort ?? 'none',
    maxOutputTokens: overrides.maxOutputTokens ?? 1200,
    timeoutMs: overrides.timeoutMs ?? 60000,
    maxResponseBytes: overrides.maxResponseBytes ?? 1_000_000,
    maxPromptRequestBytesPerCase: overrides.maxPromptRequestBytesPerCase ?? 20000,
    budget: overrides.budget ?? allowedBudget(),
    executeOnePaidRequest: overrides.executeOnePaidRequest ?? false,
  };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `result leaked ${sentinel}`);
  }
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('OPENROUTER_API_KEY'), false);
}

async function assertFetchZero(fn, fetchImpl) {
  await assert.rejects(fn, (error) => {
    assert.match(String(error.message), /^\[memory-v3:live-smoke]/);
    assert.equal(error.cause == null, true);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0);
}

describe('runOneCaseLiveSmoke gates', () => {
  it('does not call fetch without the execute flag', async () => {
    const fetchImpl = recordingFetch();
    const snapshot = structuredClone(loadGoldenDataset());
    const options = validOptions({ fetchImpl, executeOnePaidRequest: false });
    const result = await runOneCaseLiveSmoke(options);
    assert.equal(result.providerHttpCalls, 0);
    assert.equal(result.caseId, CASE_ID);
    assert.equal(result.model, MODEL);
    assert.equal(result.configuredBudget.absoluteCostUsd, '0.0047168');
    assert.equal(result.configuredBudget.maxBudgetUsd, 0.005);
    assert.equal(result.configuredBudget.gate, 'PASS');
    assert.equal(result.promptRequestBytes.total < 20000, true);
    assert.equal(result.keyPresent, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'diagnosticCode'), false);
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(options.dataset, snapshot);
    assertNoSecrets(result);
  });

  it('does not call fetch for a disallowed caseId', async () => {
    const fetchImpl = recordingFetch();
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            caseId: 'memv3-ru-event-01',
          }),
        ),
      fetchImpl,
    );
  });

  it('does not call fetch for a disallowed model', async () => {
    const fetchImpl = recordingFetch();
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            model: 'openai/gpt-4o',
          }),
        ),
      fetchImpl,
    );
  });

  it('does not call fetch when budget exceeds $0.005 or mismatches', async () => {
    const fetchImpl = recordingFetch();
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            budget: allowedBudget({ maxBudgetUsd: 0.01 }),
          }),
        ),
      fetchImpl,
    );
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            budget: allowedBudget({ caseCount: 2, maxRequests: 2 }),
          }),
        ),
      fetchImpl,
    );
  });

  it('does not call fetch when the budget gate fails', async () => {
    const fetchImpl = recordingFetch();
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            budget: allowedBudget({ maxBudgetUsd: 0.002 }),
          }),
        ),
      fetchImpl,
    );
  });

  it('does not call fetch when the prompt byte cap fails', async () => {
    const fetchImpl = recordingFetch();
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            maxPromptRequestBytesPerCase: 16,
          }),
        ),
      fetchImpl,
    );
  });

  it('does not call fetch when the api key is empty or missing', async () => {
    const fetchImpl = recordingFetch();
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            apiKey: '',
          }),
        ),
      fetchImpl,
    );
    await assertFetchZero(
      () =>
        runOneCaseLiveSmoke(
          validOptions({
            fetchImpl,
            executeOnePaidRequest: true,
            apiKey: '   ',
          }),
        ),
      fetchImpl,
    );
  });
});

describe('runOneCaseLiveSmoke fake fetch', () => {
  it('makes exactly one counted POST on success and evaluates one synthetic case', async () => {
    const previous = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    try {
      const fetchImpl = recordingFetch();
      const dataset = loadGoldenDataset();
      const snapshot = structuredClone(dataset);
      const result = await runOneCaseLiveSmoke(
        validOptions({
          dataset,
          fetchImpl,
          executeOnePaidRequest: true,
        }),
      );
      assert.equal(globalFetchCalls, 0);
      assert.equal(fetchImpl.calls.length, 1);
      assert.equal(fetchImpl.calls[0].url, OPENROUTER_URL);
      assert.equal(fetchImpl.calls[0].init.method, 'POST');
      const httpBody = JSON.parse(fetchImpl.calls[0].init.body);
      assert.equal('reasoning' in httpBody, false);
      assert.equal('reasoning_effort' in httpBody, false);
      assert.equal(httpBody.provider.allow_fallbacks, false);
      assert.equal(httpBody.provider.require_parameters, true);
      assert.equal(httpBody.provider.data_collection, 'deny');
      assert.equal(httpBody.provider.zdr, true);
      assert.equal(result.providerHttpCalls, 1);
      assert.equal(result.successCount, 1);
      assert.equal(result.failureCount, 0);
      assert.equal(result.caseId, CASE_ID);
      assert.equal(result.evaluation.caseId, CASE_ID);
      assert.equal(Array.isArray(result.items), true);
      assert.equal(Array.isArray(result.evidence), true);
      assert.equal(result.items.length, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'diagnosticCode'), false);
      assert.deepEqual(dataset, snapshot);
      assertNoSecrets(result);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('blocks a second fetch before the second HTTP call', async () => {
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createOnceOpenRouterFetch(inner);
    await guarded(OPENROUTER_URL, { method: 'POST' });
    assert.equal(innerCalls, 1);
    await assert.rejects(
      () => guarded(OPENROUTER_URL, { method: 'POST' }),
      /\[memory-v3:live-smoke]/,
    );
    assert.equal(innerCalls, 1);
  });

  it('does not retry a provider or fetch error', async () => {
    const fetchImpl = recordingFetch(async () => {
      throw new Error(SENTINELS.response);
    });
    const result = await runOneCaseLiveSmoke(
      validOptions({
        fetchImpl,
        executeOnePaidRequest: true,
      }),
    );
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(result.providerHttpCalls, 1);
    assert.equal(result.ok, false);
    assert.equal(typeof result.stage, 'string');
    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 1);
    assert.equal(result.diagnosticCode, 'transport_request_failed');
    assertNoSecrets(result);
  });
});

describe('runOneCaseLiveSmoke safe diagnostics', () => {
  function providerErrorBody() {
    return {
      error: {
        message: SENTINELS.providerMessage,
        code: 400,
        metadata: { raw: SENTINELS.providerMetadata },
      },
    };
  }

  async function smokeStatus(status, body = providerErrorBody()) {
    const fetchImpl = recordingFetch(jsonResponse(body, status));
    const result = await runOneCaseLiveSmoke(
      validOptions({ fetchImpl, executeOnePaidRequest: true }),
    );
    return { fetchImpl, result };
  }

  async function smokeFinish(finishReason) {
    const body = officialOpenRouterHttpBody();
    if (finishReason === undefined) {
      delete body.choices[0].finish_reason;
    } else {
      body.choices[0].finish_reason = finishReason;
    }
    const fetchImpl = recordingFetch(jsonResponse(body));
    const result = await runOneCaseLiveSmoke(
      validOptions({ fetchImpl, executeOnePaidRequest: true }),
    );
    return { fetchImpl, result };
  }

  function assertFailedDiagnostic(result, fetchImpl, code) {
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'adapter');
    assert.equal(result.diagnosticCode, code);
    assert.equal(result.cause == null, true);
    assert.equal('cause' in result, false);
    assertNoSecrets(result);
  }

  it('maps a realistic HTTP 400 envelope to openrouter_http_400 without leaking provider text', async () => {
    const { fetchImpl, result } = await smokeStatus(400);
    assertFailedDiagnostic(result, fetchImpl, 'openrouter_http_400');
  });

  it('maps HTTP 402, 403, 429, and 500 to aggregated codes', async () => {
    const cases = [
      [402, 'openrouter_http_402'],
      [403, 'openrouter_http_403'],
      [429, 'openrouter_http_429'],
      [500, 'openrouter_http_5xx'],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl, result } = await smokeStatus(status);
      assertFailedDiagnostic(result, fetchImpl, code);
    }
  });

  it('maps finish_reason values to allowlisted codes', async () => {
    const { result: lengthResult, fetchImpl: lengthFetch } = await smokeFinish('length');
    assertFailedDiagnostic(lengthResult, lengthFetch, 'openrouter_finish_length');
    const { result: errorResult, fetchImpl: errorFetch } = await smokeFinish('error');
    assertFailedDiagnostic(errorResult, errorFetch, 'openrouter_finish_error');
    const { result: toolResult, fetchImpl: toolFetch } = await smokeFinish('tool_calls');
    assertFailedDiagnostic(toolResult, toolFetch, 'openrouter_finish_tool_calls');
    const { result: missingResult, fetchImpl: missingFetch } = await smokeFinish(undefined);
    assertFailedDiagnostic(missingResult, missingFetch, 'openrouter_finish_missing');
    const { result: nullResult, fetchImpl: nullFetch } = await smokeFinish(null);
    assertFailedDiagnostic(nullResult, nullFetch, 'openrouter_finish_missing');
    const { result: otherResult, fetchImpl: otherFetch } = await smokeFinish('content_filter');
    assertFailedDiagnostic(otherResult, otherFetch, 'openrouter_finish_other');
  });

  it('maps HTTP 200 provider and message failures to allowlisted codes', async () => {
    const top = await smokeStatus(200, {
      error: { message: SENTINELS.providerMessage },
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: VALID_CONTENT },
        },
      ],
    });
    assertFailedDiagnostic(top.result, top.fetchImpl, 'openrouter_top_level_error');

    const choice = await smokeStatus(200, {
      choices: [
        {
          finish_reason: 'stop',
          error: { message: SENTINELS.providerMessage },
          message: { role: 'assistant', content: VALID_CONTENT },
        },
      ],
    });
    assertFailedDiagnostic(choice.result, choice.fetchImpl, 'openrouter_choice_error');

    const missing = await smokeStatus(200, {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant' } }],
    });
    assertFailedDiagnostic(missing.result, missing.fetchImpl, 'openrouter_missing_content');

    const empty = await smokeStatus(200, {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
    });
    assertFailedDiagnostic(empty.result, empty.fetchImpl, 'openrouter_missing_content');

    const refusal = await smokeStatus(200, {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: VALID_CONTENT,
            refusal: SENTINELS.providerMessage,
          },
        },
      ],
    });
    assertFailedDiagnostic(refusal.result, refusal.fetchImpl, 'openrouter_refusal');

    const toolCall = await smokeStatus(200, {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: VALID_CONTENT,
            tool_calls: [{ id: 't1' }],
          },
        },
      ],
    });
    assertFailedDiagnostic(toolCall.result, toolCall.fetchImpl, 'openrouter_tool_call');

    const functionCall = await smokeStatus(200, {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: VALID_CONTENT,
            function_call: { name: 'x' },
          },
        },
      ],
    });
    assertFailedDiagnostic(functionCall.result, functionCall.fetchImpl, 'openrouter_function_call');

    const role = await smokeStatus(200, {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'user', content: VALID_CONTENT },
        },
      ],
    });
    assertFailedDiagnostic(role.result, role.fetchImpl, 'openrouter_non_assistant_role');

    const shape = await smokeStatus(200, { choices: 'not-an-array' });
    assertFailedDiagnostic(shape.result, shape.fetchImpl, 'openrouter_response_invalid_shape');
  });

  it('does not trust a spoofed transport diagnosticCode', async () => {
    let getterCalls = 0;
    const fetchImpl = recordingFetch(() => {
      const error = new Error(SENTINELS.providerMessage);
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
    });
    const result = await runOneCaseLiveSmoke(
      validOptions({ fetchImpl, executeOnePaidRequest: true }),
    );
    assert.equal(getterCalls, 0);
    assertFailedDiagnostic(result, fetchImpl, 'transport_request_failed');
  });

  it('keeps throwing proxy and getter messages out of diagnostic results', async () => {
    const fetchImpl = recordingFetch(() => {
      throw new Proxy(
        {},
        {
          get() {
            throw new Error(SENTINELS.providerMessage);
          },
          ownKeys() {
            throw new Error(SENTINELS.providerMetadata);
          },
        },
      );
    });
    const result = await runOneCaseLiveSmoke(
      validOptions({ fetchImpl, executeOnePaidRequest: true }),
    );
    assertFailedDiagnostic(result, fetchImpl, 'transport_request_failed');
  });
});

describe('parseOpenRouterApiKeyFromEnvText', () => {
  it('extracts only OPENROUTER_API_KEY and supports quotes and whitespace', () => {
    const parsed = parseOpenRouterApiKeyFromEnvText(
      `OTHER=1\n  OPENROUTER_API_KEY = "${API_KEY}" \nOPENROUTER_API_KEY_BACKUP=${ENV_SENTINEL}\n`,
    );
    assert.equal(parsed, API_KEY);
    const single = parseOpenRouterApiKeyFromEnvText(`OPENROUTER_API_KEY='${API_KEY}'`);
    assert.equal(single, API_KEY);
    const similarOnly = parseOpenRouterApiKeyFromEnvText(
      `OPENROUTER_API_KEYS=${ENV_SENTINEL}\nOPENROUTER_API_KEY_TEST=${ENV_SENTINEL}\n`,
    );
    assert.equal(similarOnly, undefined);
  });

  it('stops safely on duplicate keys or malformed lines without leaking values', () => {
    assert.throws(
      () =>
        parseOpenRouterApiKeyFromEnvText(
          `OPENROUTER_API_KEY=${API_KEY}\nOPENROUTER_API_KEY=${ENV_SENTINEL}\n`,
        ),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:live-smoke]/);
        assert.equal(String(error.message).includes(API_KEY), false);
        assert.equal(String(error.message).includes(ENV_SENTINEL), false);
        return true;
      },
    );
    assert.throws(
      () => parseOpenRouterApiKeyFromEnvText(`this is not an env assignment ${ENV_SENTINEL}`),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:live-smoke]/);
        assert.equal(String(error.message).includes(ENV_SENTINEL), false);
        return true;
      },
    );
  });
});

describe('runLiveSmokeFromArgv', () => {
  it('dry-runs without execute and does not mutate process env', async () => {
    const fetchImpl = recordingFetch();
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await runLiveSmokeFromArgv(
        [
          '--case-id',
          CASE_ID,
          '--model',
          MODEL,
          '--max-budget-usd',
          '0.005',
          '--env-file',
          'masked.env',
        ],
        {
          env: {},
          readFileSync: () => `OPENROUTER_API_KEY=${API_KEY}\nOTHER=${ENV_SENTINEL}\n`,
          fetchImpl,
          dataset: loadGoldenDataset(),
        },
      );
      assert.equal(result.providerHttpCalls, 0);
      assert.equal(result.configuredBudget.absoluteCostUsd, '0.0047168');
      assert.equal(result.configuredBudget.maxBudgetUsd, 0.005);
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(process.env.OPENROUTER_API_KEY, undefined);
      assert.equal(result.keyPresent, true);
      assertNoSecrets(result);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it('rejects the stale --max-budget-usd 0.003 allowlist value', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runLiveSmokeFromArgv(
          [
            '--case-id',
            CASE_ID,
            '--model',
            MODEL,
            '--max-budget-usd',
            '0.003',
            '--env-file',
            'masked.env',
          ],
          {
            env: {},
            readFileSync: () => `OPENROUTER_API_KEY=${API_KEY}\n`,
            fetchImpl,
            dataset: loadGoldenDataset(),
          },
        ),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:live-smoke]/);
        assert.equal(fetchImpl.calls.length, 0);
        return true;
      },
    );
  });
});
