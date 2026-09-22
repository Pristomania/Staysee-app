import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runLifecycleModelBenchmarkFromArgv } from './lifecycle-model-benchmark-cli.ts';
import {
  LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
  getLifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';
import {
  prepareLifecycleModelBenchmarkCases,
  type PreparedLifecycleModelCase,
} from './lifecycle-model-benchmark-dataset.ts';
import {
  buildMemoryV3LifecycleReconcileRequest,
  type MemoryV3LifecycleReconcileRequest,
} from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';

const DATASET_PATH = new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url);
const CLI_PATH = new URL('./lifecycle-model-benchmark-cli.ts', import.meta.url);
const profile = getLifecycleModelBenchmarkProfile(LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID);
const API_KEY = 'test-key-lifecycle-cli';
const ENV_PATH = 'C:\\synthetic\\lifecycle.env';
const RAW_SENTINEL = 'RAW_LIFECYCLE_CLI_SECRET_SENTINEL';

function loadDataset(): unknown {
  return JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
}

function dryArgv(): string[] {
  return [
    '--profile', LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
    '--model', profile.model,
    '--max-budget-usd', '0.36',
  ];
}

function executeArgv(): string[] {
  return [
    ...dryArgv(),
    '--env-file', ENV_PATH,
    '--execute-twelve-paid-requests',
  ];
}

function wireOperations(testCase: PreparedLifecycleModelCase) {
  const bundle = buildMemoryV3LifecycleReconcileRequest({
    userId: testCase.userId,
    conversationId: testCase.conversationId,
    messages: testCase.messages,
    state: testCase.state,
    extraction: testCase.extraction,
  });
  return testCase.expectedProposal.map((operation) => ({
    type: operation.type,
    candidateRef: bundle.bindings.candidates.find(
      (binding) => binding.localItemKey === operation.candidateLocalItemKey,
    )?.candidateRef,
    targetMemoryRef: operation.targetMemoryKey === null
      ? null
      : bundle.bindings.memories.find(
        (binding) => binding.memoryKey === operation.targetMemoryKey,
      )?.memoryRef,
  }));
}

async function responseFixtures(dataset: unknown) {
  const prepared = await prepareLifecycleModelBenchmarkCases({
    profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
    dataset,
  });
  return new Map(prepared.map((testCase) => [
    testCase.conversationId,
    { stepId: testCase.stepId, operations: wireOperations(testCase) },
  ]));
}

function officialBody(content: string) {
  return {
    id: 'synthetic-response',
    object: 'chat.completion',
    created: 1,
    model: profile.model,
    provider: 'synthetic',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      native_finish_reason: 'STOP',
      message: { role: 'assistant', content, refusal: null },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 25, cost: 0.0001 },
  };
}

async function exactFetch(dataset: unknown) {
  const fixtures = await responseFixtures(dataset);
  let active = 0;
  let maxActive = 0;
  const starts: string[] = [];
  const ends: string[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const safeInit = init ?? {};
    calls.push({ url: String(url), init: safeInit });
    const body = JSON.parse(String(safeInit.body));
    const requestInput = JSON.parse(String(body.messages[1].content)) as MemoryV3LifecycleReconcileRequest['input'];
    const fixture = fixtures.get(requestInput.session.conversationId);
    assert.ok(fixture, 'HTTP request must belong to an approved synthetic case');
    starts.push(fixture.stepId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    try {
      return new Response(JSON.stringify(officialBody(JSON.stringify({
        operations: fixture.operations,
      }))), { status: 200 });
    } finally {
      active -= 1;
      ends.push(fixture.stepId);
    }
  }) as typeof fetch & {
    readonly calls: Array<{ url: string; init: RequestInit }>;
    readonly starts: string[];
    readonly ends: string[];
    readonly maxActive: number;
  };
  Object.defineProperties(fetchImpl, {
    calls: { value: calls, enumerable: true },
    starts: { value: starts, enumerable: true },
    ends: { value: ends, enumerable: true },
    maxActive: { get: () => maxActive, enumerable: true },
  });
  return fetchImpl;
}

function noIo() {
  let envCalls = 0;
  let fetchCalls = 0;
  return {
    io: {
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('GLOBAL_OR_INJECTED_FETCH_MUST_NOT_RUN');
      }) as typeof fetch,
      readEnvText: async () => {
        envCalls += 1;
        throw new Error('ENV_MUST_NOT_BE_READ');
      },
    },
    get envCalls() { return envCalls; },
    get fetchCalls() { return fetchCalls; },
  };
}

async function captureError(action: () => Promise<unknown>, sentinels: string[] = []) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  const publicText = `${caught.name}${caught.message}${JSON.stringify(caught)}`;
  assert.equal('cause' in caught, false);
  for (const sentinel of sentinels) assert.equal(publicText.includes(sentinel), false);
  return caught;
}

describe('lifecycle model benchmark CLI dry-run', () => {
  it('returns the exact offline plan with zero env, injected fetch, and global fetch calls', async () => {
    const io = noIo();
    let globalCalls = 0;
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      globalCalls += 1;
      throw new Error('GLOBAL_FETCH_SENTINEL');
    }) as typeof fetch;
    try {
      const output = await runLifecycleModelBenchmarkFromArgv({
        argv: dryArgv(),
        dataset: loadDataset(),
        ...io.io,
      });
      assert.deepEqual(output.benchmarkResult.stepIds, [...profile.stepIds]);
      assert.equal(output.benchmarkResult.providerHttpCalls, 0);
      assert.equal(output.benchmarkResult.attemptedCount, 0);
      assert.equal(output.benchmarkResult.configuredBudget.absoluteCostUsd, '0.348912');
      assert.equal(output.semanticReviewPacket, null);
      assert.equal(Object.hasOwn(output, 'keyPresent'), false);
      assert.equal(JSON.stringify(output).includes('keyPresent'), false);
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
    assert.equal(io.envCalls, 0);
    assert.equal(io.fetchCalls, 0);
    assert.equal(globalCalls, 0);
  });
});

describe('lifecycle model benchmark CLI argv contract', () => {
  it('rejects unknown, duplicate, alias, conflicting, incomplete, and unsafe flags before I/O', async () => {
    const invalidArgv: unknown[] = [
      [...dryArgv(), '--unknown'],
      [...dryArgv(), '--model', profile.model],
      ['--profile', LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID, '--model'],
      ['-p', LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID, '--model', profile.model, '--max-budget-usd', '0.36'],
      [...dryArgv(), '--api-key', API_KEY],
      [...dryArgv(), '--execute'],
      [...dryArgv(), '--env-file', ENV_PATH],
      [...dryArgv(), '--execute-twelve-paid-requests'],
      ['--profile', 'wrong', '--model', profile.model, '--max-budget-usd', '0.36'],
      ['--profile', LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID, '--model', 'wrong', '--max-budget-usd', '0.36'],
      ['--profile', LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID, '--model', profile.model, '--max-budget-usd', '0.35'],
    ];
    for (const argv of invalidArgv) {
      const io = noIo();
      await captureError(() => runLifecycleModelBenchmarkFromArgv({
        argv,
        dataset: loadDataset(),
        ...io.io,
      }), [API_KEY, ENV_PATH]);
      assert.equal(io.envCalls, 0);
      assert.equal(io.fetchCalls, 0);
    }
  });

  it('rejects sparse, symbol, accessor, and non-string argv without executing getters', async () => {
    let getterCalls = 0;
    const getterArgv = dryArgv();
    Object.defineProperty(getterArgv, 1, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(RAW_SENTINEL);
      },
    });
    const symbolArgv = dryArgv();
    (symbolArgv as string[] & Record<symbol, unknown>)[Symbol(RAW_SENTINEL)] = true;
    const sparseArgv = dryArgv();
    delete sparseArgv[1];
    for (const argv of [getterArgv, symbolArgv, sparseArgv, [...dryArgv(), 123] as unknown[]]) {
      const io = noIo();
      await captureError(() => runLifecycleModelBenchmarkFromArgv({
        argv,
        dataset: loadDataset(),
        ...io.io,
      }), [RAW_SENTINEL]);
      assert.equal(io.envCalls, 0);
      assert.equal(io.fetchCalls, 0);
    }
    assert.equal(getterCalls, 0);
  });
});

describe('lifecycle model benchmark CLI fake execute', () => {
  it('reads one env file and performs twelve sequential privacy-locked POSTs without retry', async () => {
    const dataset = loadDataset();
    const fetchImpl = await exactFetch(dataset);
    const envPaths: string[] = [];
    const output = await runLifecycleModelBenchmarkFromArgv({
      argv: executeArgv(),
      dataset,
      fetchImpl,
      readEnvText: async (path) => {
        envPaths.push(path);
        return `OPENROUTER_API_KEY=${API_KEY}`;
      },
    });
    assert.deepEqual(envPaths, [ENV_PATH]);
    assert.equal(fetchImpl.calls.length, 12);
    assert.equal(fetchImpl.maxActive, 1);
    assert.deepEqual(fetchImpl.starts, [...profile.stepIds]);
    assert.deepEqual(fetchImpl.ends, [...profile.stepIds]);
    assert.equal(output.benchmarkResult.attemptedCount, 12);
    assert.equal(output.benchmarkResult.successCount, 12);
    assert.equal(output.benchmarkResult.failureCount, 0);
    assert.equal(output.benchmarkResult.retryCount, 0);
    assert.equal(output.semanticReviewPacket?.cases.length, 12);
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes('Authorization'), false);
    assert.equal(serialized.includes('synthetic-response'), false);
  });
});

describe('lifecycle model benchmark CLI env and failure privacy', () => {
  it('rejects missing, malformed, and duplicate keys without fetch or secret leakage', async () => {
    const envCases = [
      '',
      `OTHER_KEY=${RAW_SENTINEL}`,
      `not an assignment ${RAW_SENTINEL}`,
      `OPENROUTER_API_KEY=${API_KEY}\nOPENROUTER_API_KEY=${RAW_SENTINEL}`,
    ];
    for (const envText of envCases) {
      let fetchCalls = 0;
      let envCalls = 0;
      await captureError(() => runLifecycleModelBenchmarkFromArgv({
        argv: executeArgv(),
        dataset: loadDataset(),
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error('FETCH_MUST_NOT_RUN');
        }) as typeof fetch,
        readEnvText: async () => {
          envCalls += 1;
          return envText;
        },
      }), [API_KEY, RAW_SENTINEL, ENV_PATH]);
      assert.equal(envCalls, 1);
      assert.equal(fetchCalls, 0);
    }
  });

  it('sanitizes injected fetch failures, counts twelve attempts, and never retries', async () => {
    let fetchCalls = 0;
    const output = await runLifecycleModelBenchmarkFromArgv({
      argv: executeArgv(),
      dataset: loadDataset(),
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error(RAW_SENTINEL);
      }) as typeof fetch,
      readEnvText: async () => `OPENROUTER_API_KEY=${API_KEY}`,
    });
    assert.equal(fetchCalls, 12);
    assert.equal(output.benchmarkResult.attemptedCount, 12);
    assert.equal(output.benchmarkResult.successCount, 0);
    assert.equal(output.benchmarkResult.failureCount, 12);
    assert.equal(output.benchmarkResult.retryCount, 0);
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes(RAW_SENTINEL), false);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(ENV_PATH), false);
  });

  it('keeps the CLI source free of fs, process env, global fetch, auto-exec, and output writes', () => {
    const source = readFileSync(CLI_PATH, 'utf8');
    for (const forbidden of [
      'node:fs', 'process.env', 'globalThis.fetch', 'Deno.env',
      'writeFile', 'import.meta.main', 'OPENROUTER_URL',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden CLI dependency: ${forbidden}`);
    }
  });
});
