/**
 * Memory V3 V2 six-case live-benchmark CLI boundary tests.
 * Injected dataset, fetch, and readEnvText only. No live OpenRouter, real .env, or paid calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-six-cli-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SIX_CASE_BENCHMARK_V2_CASE_IDS } from './live-benchmark-six-v2.mjs';
import { runSixCaseBenchmarkFromArgvV2 } from './live-benchmark-six-cli-v2.mjs';

const MODEL = 'google/gemini-3.7-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = 'test-key';
const EMPTY_CONTENT = '{"layerDecisions":[{"kind":"event","decision":"omit","itemRefs":[]},{"kind":"recurrence","decision":"omit","itemRefs":[]},{"kind":"hypothesis","decision":"omit","itemRefs":[]}],"items":[],"evidence":[]}';
const ENV_PATH = 'masked-six-v2.env';
const CLI_PREFIX = '[memory-v3:live-benchmark-six-cli-v2]';

const SENTINELS = Object.freeze({
  key: API_KEY,
  env: 'RAW_SIX_V2_ENV_FILE_SECRET_SENTINEL',
  fetch: 'GLOBAL_FETCH_SENTINEL',
  providerMessage: 'RAW_PROVIDER_MESSAGE_SENTINEL',
  response: 'RAW_PROVIDER_RESPONSE_SENTINEL',
  getter: 'RAW_SIX_CLI_V2_GETTER_SENTINEL',
});

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function dryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.11'];
}

function executeArgv() {
  return [...dryArgv(), '--env-file', ENV_PATH, '--execute-six-paid-requests'];
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-six-cli-v2',
    object: 'chat.completion',
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content, refusal: null },
      },
    ],
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

function recordingReadEnv(text = `OPENROUTER_API_KEY=${API_KEY}\nOTHER=${SENTINELS.env}\n`) {
  const calls = [];
  const readEnvText = async (path) => {
    calls.push(path);
    return text;
  };
  readEnvText.calls = calls;
  return readEnvText;
}

function caseIdFromRequest(init) {
  const body = JSON.parse(init.body);
  const input = JSON.parse(body.messages[1].content);
  return input.caseId;
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `leaked ${sentinel}`);
  }
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('OPENROUTER_API_KEY'), false);
}

async function assertCliRejects(fn, { readEnvText, fetchImpl, expectedReads = 0 }) {
  await assert.rejects(fn, (error) => {
    assert.match(String(error.message), /^\[memory-v3:live-benchmark-six-cli-v2]/);
    assert.equal(error.cause == null, true);
    assert.equal('cause' in error, false);
    assert.equal(String(error.message).includes(API_KEY), false);
    assert.equal(String(error.message).includes(SENTINELS.env), false);
    assertNoSecrets(error);
    return true;
  });
  if (readEnvText) assert.equal(readEnvText.calls.length, expectedReads);
  if (fetchImpl) assert.equal(fetchImpl.calls.length, 0);
}

describe('runSixCaseBenchmarkFromArgvV2 dry-run', () => {
  it('returns a six-case plan without reading env or calling fetch', async () => {
    const previous = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    try {
      const fetchImpl = recordingFetch();
      const readEnvText = recordingReadEnv();
      const result = await runSixCaseBenchmarkFromArgvV2({
        argv: dryArgv(),
        dataset: loadGoldenDataset(),
        fetchImpl,
        readEnvText,
      });
      assert.equal(globalFetchCalls, 0);
      assert.equal(readEnvText.calls.length, 0);
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(result.providerHttpCalls, 0);
      assert.equal(result.attemptedCount, 0);
      assert.deepEqual(result.caseIds, [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
      assert.equal(
        result.extractorVersion,
        'memory-v3-openrouter-gemini-3.7-flash-six-v2-layer-decision-r2',
      );
      assert.equal(result.configuredBudget.absoluteCostUsd, '0.100728');
      assert.equal(result.configuredBudget.maxBudgetUsd, 0.11);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'keyPresent'), false);
      assertNoSecrets(result);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('runSixCaseBenchmarkFromArgvV2 execute fake fetch', () => {
  it('makes six sequential POSTs after one env read and never leaks the key', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const fetchImpl = recordingFetch(async (url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const caseId = caseIdFromRequest(init);
      order.push(caseId);
      await Promise.resolve();
      active -= 1;
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const readEnvText = recordingReadEnv();
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await runSixCaseBenchmarkFromArgvV2({
        argv: executeArgv(),
        dataset: loadGoldenDataset(),
        fetchImpl,
        readEnvText,
      });
      assert.equal(readEnvText.calls.length, 1);
      assert.equal(readEnvText.calls[0], ENV_PATH);
      assert.equal(fetchImpl.calls.length, 6);
      assert.equal(result.providerHttpCalls, 6);
      assert.equal(result.maxActive, 1);
      assert.equal(maxActive, 1);
      assert.deepEqual(order, [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
      assert.equal(result.successCount, 6);
      assert.equal(
        result.extractorVersion,
        'memory-v3-openrouter-gemini-3.7-flash-six-v2-layer-decision-r2',
      );
      assert.equal(process.env.OPENROUTER_API_KEY, undefined);
      assert.equal(JSON.stringify(result).includes(API_KEY), false);
      for (const call of fetchImpl.calls) {
        assert.equal(call.url, OPENROUTER_URL);
        assert.equal(call.init.method, 'POST');
        const httpBody = JSON.parse(call.init.body);
        assert.equal(httpBody.model, MODEL);
        assert.equal(httpBody.max_tokens, 1200);
        assert.equal('max_completion_tokens' in httpBody, false);
        assert.equal(httpBody.provider.allow_fallbacks, true);
        assert.equal(httpBody.provider.require_parameters, true);
        assert.equal(httpBody.provider.data_collection, 'deny');
        assert.equal(httpBody.provider.zdr, true);
      }
      assertNoSecrets(result);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });
});

describe('runSixCaseBenchmarkFromArgvV2 argv rejection', () => {
  it('rejects unknown, duplicate, and incomplete argv before env or HTTP', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const io = { dataset: loadGoldenDataset(), fetchImpl, readEnvText };

    await assertCliRejects(
      () => runSixCaseBenchmarkFromArgvV2({ ...io, argv: [...dryArgv(), '--unknown'] }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () => runSixCaseBenchmarkFromArgvV2({ ...io, argv: [...dryArgv(), '--model', MODEL] }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          ...io,
          argv: [...executeArgv(), '--execute-six-paid-requests'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () => runSixCaseBenchmarkFromArgvV2({ ...io, argv: [...dryArgv(), '--execute'] }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          ...io,
          argv: ['--model', 'openai/gpt-5.6-luna', '--max-budget-usd', '0.11'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          ...io,
          argv: ['--model', MODEL, '--max-budget-usd', '0.100728'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          ...io,
          argv: ['--model', MODEL, '--max-budget-usd', '0.12'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          ...io,
          argv: [...dryArgv(), '--execute-six-paid-requests'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          ...io,
          argv: [...executeArgv(), '--api-key', API_KEY],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
  });

  it('rejects missing execute dependencies and unsafe env text before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();

    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          argv: executeArgv(),
          dataset,
          fetchImpl,
        }),
      { fetchImpl, expectedReads: 0 },
    );

    const readEnvText = recordingReadEnv();
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          argv: executeArgv(),
          dataset,
          readEnvText,
        }),
      { readEnvText, expectedReads: 0 },
    );

    const malformed = recordingReadEnv(`this is not an env assignment ${SENTINELS.env}`);
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          argv: executeArgv(),
          dataset,
          fetchImpl,
          readEnvText: malformed,
        }),
      { readEnvText: malformed, fetchImpl, expectedReads: 1 },
    );

    const duplicated = recordingReadEnv(
      `OPENROUTER_API_KEY=${API_KEY}\nOPENROUTER_API_KEY=${SENTINELS.env}\n`,
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          argv: executeArgv(),
          dataset,
          fetchImpl,
          readEnvText: duplicated,
        }),
      { readEnvText: duplicated, fetchImpl, expectedReads: 1 },
    );

    const empty = recordingReadEnv('OPENROUTER_API_KEY=\n');
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          argv: executeArgv(),
          dataset,
          fetchImpl,
          readEnvText: empty,
        }),
      { readEnvText: empty, fetchImpl, expectedReads: 1 },
    );
  });
});

describe('runSixCaseBenchmarkFromArgvV2 privacy and source isolation', () => {
  it('does not trust spoofed diagnostics or execute getters', async () => {
    const fetchImpl = recordingFetch(async () => {
      const error = new Error(SENTINELS.providerMessage);
      error.name = 'MemoryV3OpenRouterError';
      Object.defineProperty(error, 'diagnosticCode', {
        value: 'openrouter_http_402',
        enumerable: true,
      });
      throw error;
    });
    const readEnvText = recordingReadEnv();
    const result = await runSixCaseBenchmarkFromArgvV2({
      argv: executeArgv(),
      dataset: loadGoldenDataset(),
      fetchImpl,
      readEnvText,
    });
    assert.equal(result.failureCount, 6);
    for (const entry of result.cases) {
      assert.equal(entry.diagnosticCode, 'transport_request_failed');
      assert.equal(entry.cause == null, true);
    }
    assertNoSecrets(result);

    let getterCalls = 0;
    const argv = dryArgv();
    Object.defineProperty(argv, '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assert.rejects(
      () =>
        runSixCaseBenchmarkFromArgvV2({
          argv,
          dataset: loadGoldenDataset(),
        }),
      (error) => String(error.message).startsWith(CLI_PREFIX),
    );
    assert.equal(getterCalls, 0);
  });

  it('does not import V1 harness, CLI, or evaluator modules', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-six-cli-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.equal(/from '\.\/live-benchmark-six\.mjs'/.test(source), false);
    assert.equal(/from '\.\/live-benchmark-six-cli\.mjs'/.test(source), false);
    assert.equal(/from '\.\/evaluator\.mjs'/.test(source), false);
    assert.equal(/runSixCaseLiveBenchmark(?!V2)\(/.test(source), false);
    assert.match(source, /runSixCaseLiveBenchmarkV2/);
    assert.equal(/import\s+.*\bfs\b/.test(source), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('Deno.env'), false);
    assert.equal(source.includes('globalThis.fetch'), false);
  });
});
