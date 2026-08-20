/**
 * Memory V3 six-case live-benchmark CLI boundary tests.
 * Injected dataset, fetch, and readEnvText only. No live OpenRouter, real .env, or paid calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-six-cli.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SIX_CASE_BENCHMARK_CASE_IDS } from './live-benchmark-six.mjs';
import { runSixCaseBenchmarkFromArgv } from './live-benchmark-six-cli.mjs';

const MODEL = 'openai/gpt-5.6-luna';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = 'test-memory-v3-six-cli-key';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';
const ENV_PATH = 'masked-six.env';

const SENTINELS = Object.freeze({
  key: API_KEY,
  env: 'RAW_SIX_ENV_FILE_SECRET_SENTINEL',
  fetch: 'GLOBAL_FETCH_SENTINEL',
  providerMessage: 'RAW_PROVIDER_MESSAGE_SENTINEL',
  response: 'RAW_PROVIDER_RESPONSE_SENTINEL',
  getter: 'RAW_SIX_CLI_GETTER_SENTINEL',
});

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v1.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function dryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.032'];
}

function executeArgv() {
  return [...dryArgv(), '--env-file', ENV_PATH, '--execute-six-paid-requests'];
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-six-cli',
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
    assert.match(String(error.message), /^\[memory-v3:live-benchmark-six-cli]/);
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

describe('runSixCaseBenchmarkFromArgv dry-run', () => {
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
      const result = await runSixCaseBenchmarkFromArgv({
        argv: dryArgv(),
        dataset: loadGoldenDataset(),
        fetchImpl,
        readEnvText,
      });
      assert.equal(globalFetchCalls, 0);
      assert.equal(readEnvText.calls.length, 0);
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(result.providerHttpCalls, 0);
      assert.deepEqual(result.caseIds, [...SIX_CASE_BENCHMARK_CASE_IDS]);
      assert.equal(result.configuredBudget.absoluteCostUsd, '0.03113088');
      assert.equal(result.configuredBudget.maxBudgetUsd, 0.032);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'keyPresent'), false);
      assertNoSecrets(result);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('runSixCaseBenchmarkFromArgv execute fake fetch', () => {
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
      const result = await runSixCaseBenchmarkFromArgv({
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
      assert.deepEqual(order, [...SIX_CASE_BENCHMARK_CASE_IDS]);
      assert.equal(result.successCount, 6);
      assert.equal(process.env.OPENROUTER_API_KEY, undefined);
      assert.equal(JSON.stringify(result).includes(API_KEY), false);
      assertNoSecrets(result);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });
});

describe('runSixCaseBenchmarkFromArgv argv rejection', () => {
  it('rejects unknown, duplicate, and incomplete argv before env or HTTP', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const io = { dataset: loadGoldenDataset(), fetchImpl, readEnvText };

    await assertCliRejects(
      () => runSixCaseBenchmarkFromArgv({ ...io, argv: [...dryArgv(), '--unknown'] }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () => runSixCaseBenchmarkFromArgv({ ...io, argv: [...dryArgv(), '--model', MODEL] }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
          ...io,
          argv: [...executeArgv(), '--execute-six-paid-requests'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () => runSixCaseBenchmarkFromArgv({ ...io, argv: [...dryArgv(), '--execute'] }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
          ...io,
          argv: ['--model', 'openai/gpt-5-mini', '--max-budget-usd', '0.032'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
          ...io,
          argv: ['--model', MODEL, '--max-budget-usd', '0.03113088'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
          ...io,
          argv: ['--model', MODEL, '--max-budget-usd', '0.033'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
          ...io,
          argv: [...dryArgv(), '--execute-six-paid-requests'],
        }),
      { readEnvText, fetchImpl, expectedReads: 0 },
    );
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
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
        runSixCaseBenchmarkFromArgv({
          argv: executeArgv(),
          dataset,
          fetchImpl,
        }),
      { fetchImpl, expectedReads: 0 },
    );

    const readEnvText = recordingReadEnv();
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
          argv: executeArgv(),
          dataset,
          readEnvText,
        }),
      { readEnvText, expectedReads: 0 },
    );

    const malformed = recordingReadEnv(`this is not an env assignment ${SENTINELS.env}`);
    await assertCliRejects(
      () =>
        runSixCaseBenchmarkFromArgv({
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
        runSixCaseBenchmarkFromArgv({
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
        runSixCaseBenchmarkFromArgv({
          argv: executeArgv(),
          dataset,
          fetchImpl,
          readEnvText: empty,
        }),
      { readEnvText: empty, fetchImpl, expectedReads: 1 },
    );
  });
});

describe('runSixCaseBenchmarkFromArgv privacy', () => {
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
    const result = await runSixCaseBenchmarkFromArgv({
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
        runSixCaseBenchmarkFromArgv({
          argv,
          dataset: loadGoldenDataset(),
        }),
      /\[memory-v3:live-benchmark-six-cli]/,
    );
    assert.equal(getterCalls, 0);
  });
});
