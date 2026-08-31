/**
 * Memory V3 V2 six-case composition-root tests.
 * Injected readFile/fetch/stdio only. No live OpenRouter, real .env, or paid calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-six-run-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SIX_CASE_BENCHMARK_V2_CASE_IDS } from './live-benchmark-six-v2.mjs';
import { main } from './live-benchmark-six-run-v2.mjs';

const MODEL = 'openai/gpt-5.6-luna';
const API_KEY = 'test-key';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';
const ENV_PATH = 'C:\\synthetic\\.env';
const SAFETY_03_ASSISTANT_TEXT = 'Наверное, в детстве тебя наказывали за любые просьбы.';
const GOLDEN_NAME = 'memory-v3-ru-golden.v2.json';
const RUN_PREFIX = '[memory-v3:live-benchmark-six-run-v2]';

const SENTINELS = Object.freeze({
  key: API_KEY,
  env: 'RAW_SIX_RUN_V2_ENV_SECRET_SENTINEL',
  dataset: 'RAW_SIX_RUN_V2_DATASET_SECRET_SENTINEL',
  fetch: 'GLOBAL_FETCH_SENTINEL',
  providerMessage: 'RAW_PROVIDER_MESSAGE_SENTINEL',
  response: 'RAW_PROVIDER_RESPONSE_SENTINEL',
  getter: 'RAW_SIX_RUN_V2_GETTER_SENTINEL',
});

const REAL_GOLDEN_TEXT = readFileSync(new URL('./memory-v3-ru-golden.v2.json', import.meta.url), 'utf8');

function dryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.032'];
}

function executeArgv() {
  return [...dryArgv(), '--env-file', ENV_PATH, '--execute-six-paid-requests'];
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-six-run-v2',
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

function recordingReadFile(options = {}) {
  const calls = [];
  const readFileImpl = async (path, encoding) => {
    calls.push({ path: String(path), encoding });
    const asString = String(path);
    if (asString.includes(ENV_PATH) || /(?:^|[\\/])\.env$/i.test(asString)) {
      if (options.rejectEnv) throw new Error(SENTINELS.env);
      return options.envText ?? `OPENROUTER_API_KEY=${API_KEY}\nOTHER=${SENTINELS.env}\n`;
    }
    if (options.rejectDataset) throw new Error(SENTINELS.dataset);
    return options.datasetText ?? REAL_GOLDEN_TEXT;
  };
  readFileImpl.calls = calls;
  return readFileImpl;
}

function recordingWriter() {
  const calls = [];
  const write = (chunk) => {
    calls.push(String(chunk));
  };
  write.calls = calls;
  return write;
}

function caseIdFromRequest(init) {
  const body = JSON.parse(init.body);
  const input = JSON.parse(body.messages[1].content);
  return input.caseId;
}

function datasetReads(readFileImpl) {
  return readFileImpl.calls.filter((entry) => entry.path.includes(GOLDEN_NAME));
}

function envReads(readFileImpl) {
  return readFileImpl.calls.filter((entry) => !entry.path.includes(GOLDEN_NAME));
}

function assertNoSecrets(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `leaked ${sentinel}`);
  }
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('OPENROUTER_API_KEY'), false);
  assert.equal(serialized.includes('You extract StaySEE Memory V3 V2 items'), false);
}

function parseStdoutJson(writeStdout) {
  assert.equal(writeStdout.calls.length, 1);
  const parsed = JSON.parse(writeStdout.calls[0]);
  assertNoSecrets(parsed);
  return parsed;
}

async function assertSafeFailure(fn, { readFileImpl, fetchImpl, writeStdout, writeStderr }) {
  await assert.rejects(fn, (error) => {
    assert.match(String(error.message), /^\[memory-v3:live-benchmark-six-run-v2]/);
    assert.equal(error.cause == null, true);
    assert.equal('cause' in error, false);
    assertNoSecrets(error);
    return true;
  });
  for (const chunk of writeStdout.calls) assertNoSecrets(chunk);
  for (const chunk of writeStderr.calls) assertNoSecrets(chunk);
  if (fetchImpl) assert.equal(fetchImpl.calls.length, 0);
  if (readFileImpl) {
    for (const call of readFileImpl.calls) {
      assert.equal(String(call.path).includes(SENTINELS.dataset), false);
      assert.equal(String(call.path).includes(SENTINELS.env), false);
    }
  }
}

describe('live-benchmark-six-run-v2 import safety', () => {
  it('does not run main on import', () => {
    const readFileImpl = recordingReadFile();
    const fetchImpl = recordingFetch();
    const writeStdout = recordingWriter();
    const writeStderr = recordingWriter();
    assert.equal(typeof main, 'function');
    assert.equal(readFileImpl.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(writeStdout.calls.length, 0);
    assert.equal(writeStderr.calls.length, 0);
  });

  it('does not import V1 harness, CLI, or V1 golden', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-six-run-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.equal(/from '\.\/live-benchmark-six\.mjs'/.test(source), false);
    assert.equal(/from '\.\/live-benchmark-six-cli\.mjs'/.test(source), false);
    assert.equal(/from '\.\/evaluator\.mjs'/.test(source), false);
    assert.equal(source.includes('memory-v3-ru-golden.v1.json'), false);
    assert.match(source, /memory-v3-ru-golden\.v2\.json/);
    assert.match(source, /runSixCaseBenchmarkFromArgvV2/);
    assert.match(source, /buildSixCaseSemanticReviewPacketV2/);
    assert.equal(/runSixCaseLiveBenchmark(?!V2)\(/.test(source), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('Deno.env'), false);
    assert.equal(source.includes('process.exit('), false);
  });
});

describe('live-benchmark-six-run-v2 dry-run', () => {
  it('loads golden once, skips env/fetch, and prints one safe JSON plan', async () => {
    const readFileImpl = recordingReadFile();
    const fetchImpl = recordingFetch();
    const writeStdout = recordingWriter();
    const writeStderr = recordingWriter();
    const returned = await main({
      argv: dryArgv(),
      readFileImpl,
      fetchImpl,
      writeStdout,
      writeStderr,
    });
    assert.equal(datasetReads(readFileImpl).length, 1);
    assert.equal(envReads(readFileImpl).length, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(writeStderr.calls.length, 0);
    const parsed = parseStdoutJson(writeStdout);
    assert.equal(parsed.semanticReviewPacket, null);
    assert.equal(parsed.benchmarkResult.providerHttpCalls, 0);
    assert.deepEqual(parsed.benchmarkResult.caseIds, [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
    assert.equal(parsed.benchmarkResult.extractorVersion, 'memory-v3-openrouter-luna-six-v2');
    assert.equal(parsed.benchmarkResult.configuredBudget.absoluteCostUsd, '0.03113088');
    assert.equal(parsed.benchmarkResult.configuredBudget.maxBudgetUsd, 0.032);
    assert.equal(returned.semanticReviewPacket, null);
    assertNoSecrets(returned);
  });
});

describe('live-benchmark-six-run-v2 fake execute', () => {
  it('reads golden and env once, posts six cases, and builds a synthetic review packet', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const fetchImpl = recordingFetch(async (url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(caseIdFromRequest(init));
      await Promise.resolve();
      active -= 1;
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const readFileImpl = recordingReadFile();
    const writeStdout = recordingWriter();
    const writeStderr = recordingWriter();
    const returned = await main({
      argv: executeArgv(),
      readFileImpl,
      fetchImpl,
      writeStdout,
      writeStderr,
    });
    assert.equal(datasetReads(readFileImpl).length, 1);
    assert.equal(envReads(readFileImpl).length, 1);
    assert.equal(envReads(readFileImpl)[0].path.includes('synthetic'), true);
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
    assert.equal(writeStderr.calls.length, 0);
    const parsed = parseStdoutJson(writeStdout);
    assert.equal(parsed.benchmarkResult.providerHttpCalls, 6);
    assert.equal(parsed.benchmarkResult.maxActive, 1);
    assert.equal(parsed.semanticReviewPacket.cases.length, 6);
    const safety03 = parsed.semanticReviewPacket.cases[5];
    assert.equal(safety03.caseId, 'memv3-ru-safety-03');
    assert.equal(
      safety03.messages.some(
        (message) => message.role === 'assistant' && message.text === SAFETY_03_ASSISTANT_TEXT,
      ),
      true,
    );
    assert.equal(JSON.stringify(parsed.benchmarkResult).includes(SAFETY_03_ASSISTANT_TEXT), false);
    assert.equal(JSON.stringify(parsed).includes(API_KEY), false);
    assert.equal(JSON.stringify(parsed).includes(SENTINELS.response), false);
    assert.equal(returned.benchmarkResult.providerHttpCalls, 6);
    assertNoSecrets(returned);
  });
});

describe('live-benchmark-six-run-v2 failure privacy', () => {
  it('keeps dataset, env, fetch, and spoofed errors out of public output', async () => {
    const malformedGolden = recordingReadFile({ datasetText: `{${SENTINELS.dataset}` });
    const writeStdout = recordingWriter();
    const writeStderr = recordingWriter();
    const fetchImpl = recordingFetch();
    await assertSafeFailure(
      () =>
        main({
          argv: dryArgv(),
          readFileImpl: malformedGolden,
          fetchImpl,
          writeStdout,
          writeStderr,
        }),
      { readFileImpl: malformedGolden, fetchImpl, writeStdout, writeStderr },
    );

    const rejectDataset = recordingReadFile({ rejectDataset: true });
    const rejectDatasetOut = recordingWriter();
    const rejectDatasetErr = recordingWriter();
    const rejectDatasetFetch = recordingFetch();
    await assertSafeFailure(
      () =>
        main({
          argv: dryArgv(),
          readFileImpl: rejectDataset,
          fetchImpl: rejectDatasetFetch,
          writeStdout: rejectDatasetOut,
          writeStderr: rejectDatasetErr,
        }),
      {
        readFileImpl: rejectDataset,
        fetchImpl: rejectDatasetFetch,
        writeStdout: rejectDatasetOut,
        writeStderr: rejectDatasetErr,
      },
    );

    const rejectEnv = recordingReadFile({ rejectEnv: true });
    const rejectEnvOut = recordingWriter();
    const rejectEnvErr = recordingWriter();
    const rejectEnvFetch = recordingFetch();
    await assertSafeFailure(
      () =>
        main({
          argv: executeArgv(),
          readFileImpl: rejectEnv,
          fetchImpl: rejectEnvFetch,
          writeStdout: rejectEnvOut,
          writeStderr: rejectEnvErr,
        }),
      {
        readFileImpl: rejectEnv,
        fetchImpl: rejectEnvFetch,
        writeStdout: rejectEnvOut,
        writeStderr: rejectEnvErr,
      },
    );

    const malformedEnv = recordingReadFile({
      envText: `this is not an env assignment ${SENTINELS.env}`,
    });
    const malformedEnvFetch = recordingFetch();
    const malformedEnvOut = recordingWriter();
    const malformedEnvErr = recordingWriter();
    await assertSafeFailure(
      () =>
        main({
          argv: executeArgv(),
          readFileImpl: malformedEnv,
          fetchImpl: malformedEnvFetch,
          writeStdout: malformedEnvOut,
          writeStderr: malformedEnvErr,
        }),
      {
        readFileImpl: malformedEnv,
        fetchImpl: malformedEnvFetch,
        writeStdout: malformedEnvOut,
        writeStderr: malformedEnvErr,
      },
    );
    assert.equal(malformedEnvFetch.calls.length, 0);

    const fetchReject = recordingFetch(async () => {
      const error = new Error(SENTINELS.providerMessage);
      error.name = 'MemoryV3OpenRouterError';
      Object.defineProperty(error, 'diagnosticCode', {
        value: 'openrouter_http_402',
        enumerable: true,
      });
      throw error;
    });
    const fetchOut = recordingWriter();
    const fetchErr = recordingWriter();
    const fetchResult = await main({
      argv: executeArgv(),
      readFileImpl: recordingReadFile(),
      fetchImpl: fetchReject,
      writeStdout: fetchOut,
      writeStderr: fetchErr,
    });
    assert.equal(fetchResult.benchmarkResult.failureCount, 6);
    assert.equal(fetchErr.calls.length, 0);
    assertNoSecrets(parseStdoutJson(fetchOut));
    for (const entry of fetchResult.benchmarkResult.cases) {
      assert.equal(entry.diagnosticCode, 'transport_request_failed');
      assert.equal(entry.cause == null, true);
    }

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
        main({
          argv,
          readFileImpl: recordingReadFile(),
          fetchImpl: recordingFetch(),
          writeStdout: recordingWriter(),
          writeStderr: recordingWriter(),
        }),
      (error) => String(error.message).startsWith(RUN_PREFIX),
    );
    assert.equal(getterCalls, 0);
  });
});

describe('live-benchmark-six-run-v2 direct dry-run command', () => {
  it('runs the executable dry-run without env, network, or execute', () => {
    const script = fileURLToPath(new URL('./live-benchmark-six-run-v2.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [script, '--model', MODEL, '--max-budget-usd', '0.032'],
      {
        encoding: 'utf8',
        env: { ...process.env, OPENROUTER_API_KEY: SENTINELS.key },
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.benchmarkResult.providerHttpCalls, 0);
    assert.equal(parsed.semanticReviewPacket, null);
    assert.deepEqual(parsed.benchmarkResult.caseIds, [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
    assert.equal(parsed.benchmarkResult.configuredBudget.absoluteCostUsd, '0.03113088');
    assertNoSecrets(parsed);
    assert.equal(result.stdout.includes(SAFETY_03_ASSISTANT_TEXT), false);
    assert.equal(result.stdout.includes(SENTINELS.key), false);
  });
});
