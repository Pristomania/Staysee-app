/**
 * Memory V3 V2 shared profile-driven live-benchmark CLI tests.
 * Injected dataset, fetch, and readEnvText only. No live OpenRouter, real .env, or paid calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-cli-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';
import { runProfileBenchmarkFromArgvV2 } from './live-benchmark-cli-v2.mjs';

const MODEL = 'google/gemini-3.7-flash';
const API_KEY = 'test-memory-v3-profile-v2-key';
const ENV_PATH = 'masked-cli-v2.env';
const SIX_PREFIX = '[memory-v3:live-benchmark-six-cli-v2]';
const SIX_NAME = 'MemoryV3SixCaseBenchmarkCliV2Error';
const HYPOTHESIS_PREFIX = '[memory-v3:live-benchmark-hypothesis-four-cli-v2]';
const HYPOTHESIS_NAME = 'MemoryV3HypothesisFourBenchmarkCliV2Error';
const SENTINEL = 'RAW_CLI_GETTER_SENTINEL';
const ATTACKER_ENV_NAME = 'ATTACKER_CONTROLLED_ENV_NAME';
const ATTACKER_ENV_VALUE = 'ATTACKER_CONTROLLED_ENV_VALUE';

const SIX_CASE_IDS = Object.freeze([
  'memv3-ru-event-03',
  'memv3-ru-correction-04',
  'memv3-ru-recurrence-02',
  'memv3-ru-hypothesis-01',
  'memv3-ru-counterexample-01',
  'memv3-ru-safety-03',
]);

const HYPOTHESIS_CASE_IDS = Object.freeze([
  'memv3-ru-hypothesis-01',
  'memv3-ru-hypothesis-02',
  'memv3-ru-hypothesis-03',
  'memv3-ru-hypothesis-04',
]);

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function sixDryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.11'];
}

function hypothesisDryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.075'];
}

function sixExecuteArgv() {
  return [...sixDryArgv(), '--env-file', ENV_PATH, '--execute-six-paid-requests'];
}

function hypothesisExecuteArgv() {
  return [...hypothesisDryArgv(), '--env-file', ENV_PATH, '--execute-hypothesis-four-paid-requests'];
}

function officialOpenRouterHttpBody(content = '{"items":[],"evidence":[]}') {
  return {
    id: 'chatcmpl-cli-v2',
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
  };
}

function jsonResponse(body) {
  return {
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init);
    return jsonResponse(officialOpenRouterHttpBody());
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function recordingReadEnv(text = `OPENROUTER_API_KEY=${API_KEY}\n`) {
  const calls = [];
  const readEnvText = async (path) => {
    calls.push(path);
    return text;
  };
  readEnvText.calls = calls;
  return readEnvText;
}

function withProfileIdDescriptor(baseOptions, profileId, kind, probe) {
  const options = Object.assign({}, baseOptions);
  delete options.profileId;
  if (kind === 'valid-own-enumerable-string') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: profileId,
    });
    return options;
  }
  if (kind === 'getter') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      get() {
        probe.getterCalls += 1;
        return profileId;
      },
    });
    return options;
  }
  if (kind === 'setter-only') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      set() {
        probe.setterCalls += 1;
      },
    });
    return options;
  }
  if (kind === 'non-enumerable') {
    Object.defineProperty(options, 'profileId', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: profileId,
    });
    return options;
  }
  if (kind === 'symbol-keyed') {
    Object.defineProperty(options, Symbol('profileId'), {
      enumerable: true,
      configurable: true,
      writable: true,
      value: profileId,
    });
    return options;
  }
  if (kind === 'inherited') {
    const proto = { profileId };
    return Object.assign(Object.create(proto), options);
  }
  if (kind === 'object-clone') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { ...getLiveBenchmarkProfileV2(profileId) },
    });
    return options;
  }
  throw new Error('unknown descriptor kind');
}

function stringifyError(error) {
  try {
    return JSON.stringify(error);
  } catch {
    return '';
  }
}

function assertCliBranded(error, prefix, name) {
  assert.equal(error.name, name);
  assert.equal(String(error.message).startsWith(`${prefix} `), true);
  assert.equal(error.cause == null, true);
  assert.equal('cause' in error, false);
  const text = `${String(error.message)}\n${stringifyError(error)}`;
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes(SENTINEL), false);
  assert.equal(text.includes(ENV_PATH), false);
  assert.equal(text.includes(ATTACKER_ENV_NAME), false);
  assert.equal(text.includes(ATTACKER_ENV_VALUE), false);
  assert.equal(text.includes('Maximum call stack'), false);
  assert.equal(error instanceof TypeError && error.name === 'TypeError', false);
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes('OPENROUTER_API_KEY'), false);
  assert.equal(serialized.includes(ENV_PATH), false);
  assert.equal(serialized.includes('Authorization'), false);
}

async function assertCliRejects(fn, { prefix, name, readEnvText, fetchImpl, expectedReads = 0 }) {
  await assert.rejects(fn, (error) => {
    assertCliBranded(error, prefix, name);
    assertNoSecrets(error);
    return true;
  });
  if (readEnvText) assert.equal(readEnvText.calls.length, expectedReads);
  if (fetchImpl) assert.equal(fetchImpl.calls.length, 0);
}

describe('runProfileBenchmarkFromArgvV2 dry-run', () => {
  it('six-category-v2 does not read env or fetch', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const result = await runProfileBenchmarkFromArgvV2({
      argv: sixDryArgv(),
      dataset: loadGoldenDataset(),
      profileId: 'six-category-v2',
      fetchImpl,
      readEnvText,
    });
    assert.equal(readEnvText.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(result.providerHttpCalls, 0);
    assert.deepEqual(result.caseIds, [...SIX_CASE_IDS]);
    assertNoSecrets(result);
  });

  it('hypothesis-four-v2 does not read env or fetch', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const result = await runProfileBenchmarkFromArgvV2({
      argv: hypothesisDryArgv(),
      dataset: loadGoldenDataset(),
      profileId: 'hypothesis-four-v2',
      fetchImpl,
      readEnvText,
    });
    assert.equal(readEnvText.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(result.providerHttpCalls, 0);
    assert.deepEqual(result.caseIds, [...HYPOTHESIS_CASE_IDS]);
    assertNoSecrets(result);
  });
});

describe('runProfileBenchmarkFromArgvV2 execute', () => {
  it('hypothesis-four reads env once, posts four cases sequentially, and hides secrets', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = recordingFetch(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const readEnvText = recordingReadEnv();
    const result = await runProfileBenchmarkFromArgvV2({
      argv: hypothesisExecuteArgv(),
      dataset: loadGoldenDataset(),
      profileId: 'hypothesis-four-v2',
      fetchImpl,
      readEnvText,
    });
    assert.equal(readEnvText.calls.length, 1);
    assert.equal(readEnvText.calls[0], ENV_PATH);
    assert.equal(fetchImpl.calls.length, 4);
    assert.equal(result.providerHttpCalls, 4);
    assert.equal(result.maxActive, 1);
    assert.equal(maxActive, 1);
    assertNoSecrets(result);
  });
});

describe('runProfileBenchmarkFromArgvV2 cross-profile flags', () => {
  it('rejects the other profile execute flag before env or HTTP', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const dataset = loadGoldenDataset();
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: [...sixDryArgv(), '--execute-hypothesis-four-paid-requests'],
          dataset,
          profileId: 'six-category-v2',
          fetchImpl,
          readEnvText,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: [...hypothesisDryArgv(), '--execute-six-paid-requests'],
          dataset,
          profileId: 'hypothesis-four-v2',
          fetchImpl,
          readEnvText,
        }),
      { prefix: HYPOTHESIS_PREFIX, name: HYPOTHESIS_NAME, readEnvText, fetchImpl },
    );
  });
});

describe('runProfileBenchmarkFromArgvV2 argv rejection', () => {
  it('rejects forbidden and malformed argv before env or HTTP', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const dataset = loadGoldenDataset();
    const io = { dataset, profileId: 'six-category-v2', fetchImpl, readEnvText };

    await assertCliRejects(
      () => runProfileBenchmarkFromArgvV2({ ...io, argv: [...sixDryArgv(), '--profile', 'six-category-v2'] }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () => runProfileBenchmarkFromArgvV2({ ...io, argv: [...sixExecuteArgv(), '--api-key', API_KEY] }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          ...io,
          argv: [...sixDryArgv(), `OPENROUTER_API_KEY=${API_KEY}`],
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () => runProfileBenchmarkFromArgvV2({ ...io, argv: [...sixDryArgv(), '--unknown'] }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () => runProfileBenchmarkFromArgvV2({ ...io, argv: [...sixDryArgv(), '--model', MODEL] }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          ...io,
          argv: ['--model', 'openai/gpt-5.6-luna', '--max-budget-usd', '0.11'],
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          ...io,
          argv: ['--model', MODEL, '--max-budget-usd', '0.100728'],
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          ...io,
          argv: ['--model', MODEL, '--max-budget-usd', '0.12'],
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          dataset,
          profileId: 'hypothesis-four-v2',
          fetchImpl,
          readEnvText,
          argv: ['--model', MODEL, '--max-budget-usd', '0.067152'],
        }),
      { prefix: HYPOTHESIS_PREFIX, name: HYPOTHESIS_NAME, readEnvText, fetchImpl },
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          dataset,
          profileId: 'hypothesis-four-v2',
          fetchImpl,
          readEnvText,
          argv: ['--model', MODEL],
        }),
      { prefix: HYPOTHESIS_PREFIX, name: HYPOTHESIS_NAME, readEnvText, fetchImpl },
    );
  });
});

describe('runProfileBenchmarkFromArgvV2 profileId descriptors', () => {
  it('rejects invalid profileId descriptors without env or HTTP', async () => {
    const fetchImpl = recordingFetch();
    let envReads = 0;
    const readEnvText = async () => {
      envReads += 1;
      return `OPENROUTER_API_KEY=${API_KEY}\n`;
    };
    const base = {
      argv: sixExecuteArgv(),
      dataset: loadGoldenDataset(),
      profileId: 'six-category-v2',
      fetchImpl,
      readEnvText,
    };
    for (const kind of [
      'getter',
      'setter-only',
      'non-enumerable',
      'symbol-keyed',
      'inherited',
      'object-clone',
    ]) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      await assert.rejects(() =>
        runProfileBenchmarkFromArgvV2(
          withProfileIdDescriptor(base, 'six-category-v2', kind, probe),
        ),
      );
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
    }
    assert.equal(envReads, 0);
    assert.equal(fetchImpl.calls.length, 0);

    const valid = withProfileIdDescriptor(
      {
        argv: sixDryArgv(),
        dataset: loadGoldenDataset(),
        profileId: 'six-category-v2',
        fetchImpl,
        readEnvText,
      },
      'six-category-v2',
      'valid-own-enumerable-string',
      { getterCalls: 0, setterCalls: 0 },
    );
    const dry = await runProfileBenchmarkFromArgvV2(valid);
    assert.equal(dry.providerHttpCalls, 0);
    assert.equal(envReads, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('runProfileBenchmarkFromArgvV2 JSON-data-only boundary', () => {
  it('rejects sparse argv, extra keys, getters, proxies, and cycles with branded errors', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const dataset = loadGoldenDataset();

    const sparseArgv = sixDryArgv();
    sparseArgv[2] = undefined;
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: sparseArgv,
          dataset,
          profileId: 'six-category-v2',
          fetchImpl,
          readEnvText,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );

    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: sixDryArgv(),
          dataset,
          profileId: 'six-category-v2',
          profile: getLiveBenchmarkProfileV2('six-category-v2'),
          fetchImpl,
          readEnvText,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );

    let argvGetterCalls = 0;
    const argvWithGetter = sixDryArgv();
    Object.defineProperty(argvWithGetter, '0', {
      enumerable: true,
      configurable: true,
      get() {
        argvGetterCalls += 1;
        throw new Error(SENTINEL);
      },
    });
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: argvWithGetter,
          dataset,
          profileId: 'six-category-v2',
          fetchImpl,
          readEnvText,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );
    assert.equal(argvGetterCalls, 0);

    const revoked = Proxy.revocable(sixDryArgv(), {});
    revoked.revoke();
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: revoked.proxy,
          dataset,
          profileId: 'six-category-v2',
          fetchImpl,
          readEnvText,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText, fetchImpl },
    );

    const cyclic = { argv: sixDryArgv(), dataset, profileId: 'six-category-v2' };
    cyclic.self = cyclic;
    await assertCliRejects(
      () => runProfileBenchmarkFromArgvV2(cyclic),
      { prefix: SIX_PREFIX, name: SIX_NAME, fetchImpl },
    );
  });

  it('does not execute a proxy get trap for argv.length', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    let lengthGetterCalls = 0;
    const argv = new Proxy(sixDryArgv(), {
      get(target, key, receiver) {
        if (key === 'length') {
          lengthGetterCalls += 1;
          throw new Error(SENTINEL);
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const result = await runProfileBenchmarkFromArgvV2({
      argv,
      dataset: loadGoldenDataset(),
      profileId: 'six-category-v2',
      fetchImpl,
      readEnvText,
    });
    assert.equal(lengthGetterCalls, 0);
    assert.equal(result.providerHttpCalls, 0);
    assert.equal(readEnvText.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('runProfileBenchmarkFromArgvV2 env parser', () => {
  it('parses env text safely and rejects malformed or missing keys', async () => {
    const dataset = loadGoldenDataset();

    const quotedFetch = recordingFetch();
    const quoted = recordingReadEnv(`export OPENROUTER_API_KEY='${API_KEY}'\n${ATTACKER_ENV_NAME}=${ATTACKER_ENV_VALUE}\n`);
    const result = await runProfileBenchmarkFromArgvV2({
      argv: sixExecuteArgv(),
      dataset,
      profileId: 'six-category-v2',
      fetchImpl: quotedFetch,
      readEnvText: quoted,
    });
    assert.equal(quoted.calls.length, 1);
    assert.equal(result.providerHttpCalls, 6);
    assertNoSecrets(result);

    const malformedFetch = recordingFetch();
    const malformed = recordingReadEnv(`not an assignment ${ATTACKER_ENV_VALUE}`);
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: sixExecuteArgv(),
          dataset,
          profileId: 'six-category-v2',
          fetchImpl: malformedFetch,
          readEnvText: malformed,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText: malformed, fetchImpl: malformedFetch, expectedReads: 1 },
    );

    const duplicatedFetch = recordingFetch();
    const duplicated = recordingReadEnv(
      `OPENROUTER_API_KEY=${API_KEY}\nOPENROUTER_API_KEY=${ATTACKER_ENV_VALUE}\n`,
    );
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: sixExecuteArgv(),
          dataset,
          profileId: 'six-category-v2',
          fetchImpl: duplicatedFetch,
          readEnvText: duplicated,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText: duplicated, fetchImpl: duplicatedFetch, expectedReads: 1 },
    );

    const blankFetch = recordingFetch();
    const blank = recordingReadEnv('OPENROUTER_API_KEY=\n');
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: sixExecuteArgv(),
          dataset,
          profileId: 'six-category-v2',
          fetchImpl: blankFetch,
          readEnvText: blank,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, readEnvText: blank, fetchImpl: blankFetch, expectedReads: 1 },
    );

    let envGetterCalls = 0;
    const getterFetch = recordingFetch();
    const getterEnv = async () => {
      envGetterCalls += 1;
      throw new Error(SENTINEL);
    };
    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: sixExecuteArgv(),
          dataset,
          profileId: 'six-category-v2',
          fetchImpl: getterFetch,
          readEnvText: getterEnv,
        }),
      { prefix: SIX_PREFIX, name: SIX_NAME, fetchImpl: getterFetch },
    );
    assert.equal(envGetterCalls, 1);
  });
});

describe('runProfileBenchmarkFromArgvV2 branding and spoof resistance', () => {
  it('uses profile CLI branding and does not trust spoofed diagnostics', async () => {
    const fetchImpl = recordingFetch(async () => {
      const error = new Error('provider failure');
      error.name = 'MemoryV3SixCaseBenchmarkCliV2Error';
      Object.defineProperty(error, 'diagnosticCode', {
        value: 'openrouter_http_402',
        enumerable: true,
      });
      throw error;
    });
    const readEnvText = recordingReadEnv();
    const result = await runProfileBenchmarkFromArgvV2({
      argv: sixExecuteArgv(),
      dataset: loadGoldenDataset(),
      profileId: 'six-category-v2',
      fetchImpl,
      readEnvText,
    });
    assert.equal(result.failureCount, 6);
    for (const entry of result.cases) {
      assert.equal(entry.diagnosticCode, 'transport_request_failed');
    }
    assertNoSecrets(result);

    await assertCliRejects(
      () =>
        runProfileBenchmarkFromArgvV2({
          argv: ['--model', MODEL],
          dataset: loadGoldenDataset(),
          profileId: 'hypothesis-four-v2',
        }),
      { prefix: HYPOTHESIS_PREFIX, name: HYPOTHESIS_NAME },
    );
  });
});

describe('live-benchmark-cli-v2 source isolation', () => {
  it('imports only profiles and shared engine', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-cli-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.equal(source.includes("from './live-benchmark-profiles-v2.mjs'"), true);
    assert.equal(source.includes("from './live-benchmark-engine-v2.mjs'"), true);
    assert.equal(source.includes('live-benchmark-six-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-hypothesis-four-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-run-v2.mjs'), false);
    assert.equal(source.includes('node:fs'), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('globalThis.fetch'), false);
  });
});
