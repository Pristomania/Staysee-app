/**
 * Memory V3 V2 hypothesis-four CLI wrapper tests.
 * Injected dataset, fetch, and readEnvText only. No live OpenRouter, real .env, or paid calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-hypothesis-four-cli-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';
import { runHypothesisFourBenchmarkFromArgvV2 } from './live-benchmark-hypothesis-four-cli-v2.mjs';

const MODEL = 'google/gemini-3.7-flash';
const API_KEY = 'test-memory-v3-profile-v2-key';
const ENV_PATH = 'masked-hypothesis-cli-v2.env';
const PREFIX = '[memory-v3:live-benchmark-hypothesis-four-cli-v2]';
const NAME = 'MemoryV3HypothesisFourBenchmarkCliV2Error';

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

function dryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.075'];
}

function executeArgv() {
  return [...dryArgv(), '--env-file', ENV_PATH, '--execute-hypothesis-four-paid-requests'];
}

function jsonResponse() {
  return {
    status: 200,
    async text() {
      return JSON.stringify({
        id: 'chatcmpl-hypothesis-cli-v2',
        object: 'chat.completion',
        created: 1,
        model: MODEL,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '{"layerDecisions":[{"kind":"event","decision":"omit","itemRefs":[]},{"kind":"recurrence","decision":"omit","itemRefs":[]},{"kind":"hypothesis","decision":"omit","itemRefs":[]}],"items":[],"evidence":[]}',
              refusal: null,
            },
          },
        ],
      });
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init);
    return jsonResponse();
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

describe('runHypothesisFourBenchmarkFromArgvV2 dry-run', () => {
  it('returns a four-case plan without reading env or calling fetch', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    const result = await runHypothesisFourBenchmarkFromArgvV2({
      argv: dryArgv(),
      dataset: loadGoldenDataset(),
      fetchImpl,
      readEnvText,
    });
    assert.equal(readEnvText.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(result.providerHttpCalls, 0);
    assert.deepEqual(result.caseIds, [...HYPOTHESIS_CASE_IDS]);
    assert.equal(
      result.extractorVersion,
      'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2-layer-decision-r2',
    );
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  });
});

describe('runHypothesisFourBenchmarkFromArgvV2 execute', () => {
  it('reads env once and posts four sequential requests', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = recordingFetch(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return jsonResponse();
    });
    const readEnvText = recordingReadEnv();
    const result = await runHypothesisFourBenchmarkFromArgvV2({
      argv: executeArgv(),
      dataset: loadGoldenDataset(),
      fetchImpl,
      readEnvText,
    });
    assert.equal(readEnvText.calls.length, 1);
    assert.equal(fetchImpl.calls.length, 4);
    assert.equal(result.providerHttpCalls, 4);
    assert.equal(result.maxActive, 1);
    assert.equal(maxActive, 1);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  });
});

describe('runHypothesisFourBenchmarkFromArgvV2 rejection', () => {
  it('rejects the six-case execute flag before env or HTTP', async () => {
    const fetchImpl = recordingFetch();
    const readEnvText = recordingReadEnv();
    await assert.rejects(
      () =>
        runHypothesisFourBenchmarkFromArgvV2({
          argv: [...dryArgv(), '--env-file', ENV_PATH, '--execute-six-paid-requests'],
          dataset: loadGoldenDataset(),
          fetchImpl,
          readEnvText,
        }),
      (error) => {
        assert.equal(error.name, NAME);
        assert.equal(String(error.message).startsWith(`${PREFIX} `), true);
        return true;
      },
    );
    assert.equal(readEnvText.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects caller profile or profileId fields', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runHypothesisFourBenchmarkFromArgvV2({
        argv: dryArgv(),
        dataset: loadGoldenDataset(),
        profileId: 'hypothesis-four-v2',
        fetchImpl,
      }),
    );
    await assert.rejects(() =>
      runHypothesisFourBenchmarkFromArgvV2({
        argv: dryArgv(),
        dataset: loadGoldenDataset(),
        profile: getLiveBenchmarkProfileV2('hypothesis-four-v2'),
        fetchImpl,
      }),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('runHypothesisFourBenchmarkFromArgvV2 source isolation', () => {
  it('imports only profiles and shared CLI and binds hypothesis-four-v2', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-hypothesis-four-cli-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.equal(source.includes("from './live-benchmark-profiles-v2.mjs'"), true);
    assert.equal(source.includes("from './live-benchmark-cli-v2.mjs'"), true);
    assert.equal(source.includes('live-benchmark-engine-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-v2.mjs'), false);
    assert.equal(source.includes('node:fs'), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('globalThis.fetch'), false);
    assert.equal(source.includes("'hypothesis-four-v2'"), true);
    assert.equal(source.includes('runProfileBenchmarkFromArgvV2'), true);
  });
});
