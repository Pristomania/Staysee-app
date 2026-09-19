import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildLifecycleModelReviewPacket,
  createAtMostTwelveLifecycleAdapter,
  runLifecycleModelBenchmark,
} from './lifecycle-model-benchmark.ts';
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
import type {
  MemoryV3LifecycleModelAdapter,
  MemoryV3LifecycleTransportResult,
} from '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts';

const DATASET_PATH = new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url);
const ENGINE_PATH = new URL('./lifecycle-model-benchmark.ts', import.meta.url);
const profile = getLifecycleModelBenchmarkProfile(LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID);
type BenchmarkOptions = Parameters<typeof runLifecycleModelBenchmark>[0];

function loadDataset(): unknown {
  return JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
}

function exactBudget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseCount: 12,
    maxInputTokensPerCase: 32_768,
    maxOutputTokensPerCase: 1_200,
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    maxRequests: 12,
    maxBudgetUsd: 0.36,
    ...overrides,
  };
}

function benchmarkOptions(overrides: Record<string, unknown> = {}): BenchmarkOptions {
  return {
    profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
    dataset: loadDataset(),
    model: profile.model,
    budget: exactBudget(),
    execute: false,
    ...overrides,
  } as unknown as BenchmarkOptions;
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

type WireOperation = ReturnType<typeof wireOperations>[number];

async function expectedWireByConversation(dataset: unknown) {
  const prepared = await prepareLifecycleModelBenchmarkCases({
    profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
    dataset,
  });
  return new Map(prepared.map((testCase) => [
    testCase.conversationId,
    { testCase, operations: wireOperations(testCase) },
  ]));
}

async function exactAdapter(dataset: unknown, options: {
  failConversationId?: string;
  usage?: MemoryV3LifecycleTransportResult['usage'];
  mutate?: (operations: WireOperation[], request: MemoryV3LifecycleReconcileRequest) => WireOperation[];
  rawContent?: (operations: WireOperation[], request: MemoryV3LifecycleReconcileRequest) => string;
} = {}) {
  const fixtures = await expectedWireByConversation(dataset);
  let active = 0;
  let maxActive = 0;
  const starts: string[] = [];
  const ends: string[] = [];
  const adapter = (async (request: MemoryV3LifecycleReconcileRequest) => {
    const conversationId = request.input.session.conversationId;
    const fixture = fixtures.get(conversationId);
    assert.ok(fixture, 'request conversation must belong to the selected fixture set');
    starts.push(fixture.testCase.stepId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    try {
      if (conversationId === options.failConversationId) throw new Error('RAW_ADAPTER_SECRET');
      const operations = options.mutate
        ? options.mutate(structuredClone(fixture.operations), request)
        : fixture.operations;
      return {
        rawContent: options.rawContent
          ? options.rawContent(structuredClone(operations), request)
          : JSON.stringify({ operations }),
        usage: options.usage ?? null,
      };
    } finally {
      active -= 1;
      ends.push(fixture.testCase.stepId);
    }
  }) as MemoryV3LifecycleModelAdapter & {
    readonly starts: string[];
    readonly ends: string[];
    readonly maxActive: number;
  };
  Object.defineProperties(adapter, {
    starts: { value: starts, enumerable: true },
    ends: { value: ends, enumerable: true },
    maxActive: { get: () => maxActive, enumerable: true },
  });
  return { adapter, fixtures };
}

describe('lifecycle model benchmark dry-run and preflight', () => {
  it('returns the exact twelve-case dry-run without touching the adapter', async () => {
    let calls = 0;
    const result = await runLifecycleModelBenchmark(benchmarkOptions({
      adapter: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    }));
    assert.deepEqual(result.stepIds, [...profile.stepIds]);
    assert.equal(result.attemptedCount, 0);
    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 0);
    assert.equal(result.providerHttpCalls, 0);
    assert.equal(result.maxActive, 1);
    assert.equal(result.aggregate, null);
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    assert.equal(result.qualityGate, 'NOT_RUN');
    assert.equal(calls, 0);
  });

  it('rejects profile, model, dataset, and exact-budget drift before adapter calls', async () => {
    const mutations = [
      { profileId: 'unknown-profile' },
      { profileId: { ...profile } },
      { model: 'openai/not-approved' },
      { dataset: { datasetId: 'wrong' } },
      { budget: exactBudget({ maxBudgetUsd: 0.35 }) },
      { budget: { ...exactBudget(), extra: true } },
    ];
    for (const mutation of mutations) {
      let calls = 0;
      await assert.rejects(() => runLifecycleModelBenchmark(benchmarkOptions({
        ...mutation,
        execute: true,
        adapter: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      })));
      assert.equal(calls, 0);
    }
  });

  it('rejects accessors, symbols, cycles, sparse data, and revoked proxies without leaks', async () => {
    let getterCalls = 0;
    const getterOptions = benchmarkOptions();
    Object.defineProperty(getterOptions, 'model', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_GETTER_SENTINEL');
      },
    });
    const symbolOptions = benchmarkOptions();
    (symbolOptions as BenchmarkOptions & Record<symbol, unknown>)[Symbol('RAW_SYMBOL_SENTINEL')] = true;
    const cyclicBudget = exactBudget();
    cyclicBudget.caseCount = cyclicBudget;
    const sparseDataset = loadDataset() as { scenarios: unknown[] };
    delete sparseDataset.scenarios[1];
    const revocable = Proxy.revocable(benchmarkOptions(), {});
    revocable.revoke();
    for (const value of [
      getterOptions,
      symbolOptions,
      benchmarkOptions({ budget: cyclicBudget }),
      benchmarkOptions({ dataset: sparseDataset }),
      revocable.proxy,
    ]) {
      let error: unknown;
      try {
        await runLifecycleModelBenchmark(value as unknown as BenchmarkOptions);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof Error);
      const serialized = JSON.stringify(error);
      assert.equal(error.cause, undefined);
      assert.equal(`${error.message}${serialized}`.includes('RAW_'), false);
    }
    assert.equal(getterCalls, 0);
  });

  it('checks prompt bytes and budget before validating execute credentials', async () => {
    const invalidOffline = benchmarkOptions({
      dataset: { datasetId: 'wrong' },
      execute: true,
      adapter: 123,
    });
    await assert.rejects(() => runLifecycleModelBenchmark(invalidOffline), /dataset/);

    const OriginalTextEncoder = globalThis.TextEncoder;
    class OversizedTextEncoder {
      encode(value = '') {
        if (value.includes('memory-v3-lifecycle-reconcile-request-v1')) {
          return new Uint8Array(profile.maxPromptRequestBytesPerCase + 1);
        }
        return new OriginalTextEncoder().encode(value);
      }
    }
    Object.defineProperty(globalThis, 'TextEncoder', {
      value: OversizedTextEncoder,
      writable: true,
      configurable: true,
    });
    try {
      await assert.rejects(() => runLifecycleModelBenchmark(benchmarkOptions({
        execute: true,
        adapter: 123,
      })), /prompt/);
    } finally {
      Object.defineProperty(globalThis, 'TextEncoder', {
        value: OriginalTextEncoder,
        writable: true,
        configurable: true,
      });
    }

    await assert.rejects(() => runLifecycleModelBenchmark(benchmarkOptions({
      execute: true,
      adapter: 123,
    })), /adapter/);
  });
});

describe('createAtMostTwelveLifecycleAdapter', () => {
  it('allows twelve attempts, blocks the thirteenth, and counts inner rejection once', async () => {
    let innerCalls = 0;
    const bounded = createAtMostTwelveLifecycleAdapter({
      adapter: async () => {
        innerCalls += 1;
        if (innerCalls === 4) throw new Error('inner rejection');
        return { rawContent: '{"operations":[]}', usage: null };
      },
    });
    const request = { input: { session: { conversationId: 'x' } } } as unknown as MemoryV3LifecycleReconcileRequest;
    for (let index = 1; index <= 12; index += 1) {
      if (index === 4) await assert.rejects(() => bounded(request));
      else await bounded(request);
    }
    assert.equal(bounded.callCount, 12);
    assert.equal(innerCalls, 12);
    await assert.rejects(() => bounded(request), /thirteenth provider call is not allowed/);
    assert.equal(bounded.callCount, 12);
    assert.equal(innerCalls, 12);
    const descriptor = Object.getOwnPropertyDescriptor(bounded, 'callCount');
    assert.equal(descriptor?.enumerable, true);
    assert.equal(typeof descriptor?.get, 'function');
  });

  it('rejects accessor and proxy options without invoking the inner adapter', () => {
    let getterCalls = 0;
    const options = {};
    Object.defineProperty(options, 'adapter', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => ({ rawContent: '{}', usage: null });
      },
    });
    assert.throws(() => createAtMostTwelveLifecycleAdapter(
      options as unknown as Parameters<typeof createAtMostTwelveLifecycleAdapter>[0],
    ));
    assert.equal(getterCalls, 0);
    const revoked = Proxy.revocable({ adapter: async () => ({ rawContent: '{}', usage: null }) }, {});
    revoked.revoke();
    assert.throws(() => createAtMostTwelveLifecycleAdapter(
      revoked.proxy as unknown as Parameters<typeof createAtMostTwelveLifecycleAdapter>[0],
    ));
  });
});

describe('lifecycle model benchmark execution and quality', () => {
  it('runs twelve production-boundary cases sequentially and passes every exact gate', async () => {
    const dataset = loadDataset();
    const fake = await exactAdapter(dataset);
    const result = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: fake.adapter,
    }));
    assert.equal(result.attemptedCount, 12);
    assert.equal(result.successCount, 12, JSON.stringify(result.failures));
    assert.equal(result.failureCount, 0);
    assert.equal(result.providerHttpCalls, 12);
    assert.equal(result.maxActive, 1);
    assert.deepEqual(fake.adapter.starts, [...profile.stepIds]);
    assert.deepEqual(fake.adapter.ends, [...profile.stepIds]);
    assert.equal(fake.adapter.maxActive, 1);
    assert.equal(result.qualityGate, 'PASS');
    assert.equal(result.cases.every((entry) =>
      'operationExact' in entry && entry.operationExact && entry.stateExact), true);
    assert.equal(result.failures.length, 0);
    assert.equal(result.aggregate.counts.exactStateMatchedCount, 12);
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
  });

  it('treats reordered independent operations as the same exact proposal', async () => {
    const dataset = loadDataset();
    const reordered = await exactAdapter(dataset, {
      mutate(operations) {
        return operations.length === 3 ? operations.reverse() : operations;
      },
    });
    const result = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: reordered.adapter,
    }));
    const layered = result.cases.find((entry) => entry.stepId === 'layered-coexistence-s01');
    assert.equal(layered && 'stateExact' in layered ? layered.stateExact : undefined, true);
    assert.equal(layered && 'operationExact' in layered ? layered.operationExact : undefined, true);
    assert.equal(result.qualityGate, 'PASS');
  });

  it('continues after case six fails, never retries, and exposes only a safe failure', async () => {
    const dataset = loadDataset();
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset,
    });
    const fake = await exactAdapter(dataset, { failConversationId: prepared[5].conversationId });
    const result = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: fake.adapter,
    }));
    assert.equal(result.attemptedCount, 12);
    assert.equal(result.successCount, 11, JSON.stringify(result.failures));
    assert.equal(result.failureCount, 1);
    assert.equal(result.providerHttpCalls, 12);
    assert.equal(result.qualityGate, 'FAIL');
    assert.deepEqual(result.failures, [{
      stepId: profile.stepIds[5],
      stage: 'transport',
      diagnosticCode: 'lifecycle_model_transport_failed',
    }]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('RAW_ADAPTER_SECRET'), false);
    assert.equal(serialized.includes('cause'), false);
  });

  it('fails the quality gate for a wrong operation and aggregates complete trusted usage only', async () => {
    const dataset = loadDataset();
    let changed = false;
    const wrong = await exactAdapter(dataset, {
      mutate(operations) {
        if (!changed) {
          changed = true;
          operations[0] = { ...operations[0], type: 'ignore', targetMemoryRef: null };
        }
        return operations;
      },
    });
    const failed = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: wrong.adapter,
    }));
    assert.equal(failed.qualityGate, 'FAIL');
    assert.equal(failed.cases.some((entry) =>
      'operationExact' in entry && entry.operationExact === false), true);

    const metered = await exactAdapter(dataset, {
      usage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 },
    });
    const measured = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: metered.adapter,
    }));
    assert.deepEqual(
      measured.actualUsage,
      { promptTokens: 120, completionTokens: 24 },
      JSON.stringify(measured.failures),
    );
    assert.equal(measured.actualCostUsd, 0.012);

    let malformedReturned = false;
    const partiallyMalformed = await exactAdapter(dataset, {
      usage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 },
      rawContent(operations) {
        if (!malformedReturned) {
          malformedReturned = true;
          return '{';
        }
        return JSON.stringify({ operations });
      },
    });
    const incompleteTelemetry = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: partiallyMalformed.adapter,
    }));
    assert.equal(incompleteTelemetry.failureCount, 1);
    assert.equal(incompleteTelemetry.successCount, 11);
    assert.deepEqual(incompleteTelemetry.actualUsage, {
      promptTokens: 120,
      completionTokens: 24,
    });
    assert.equal(incompleteTelemetry.actualCostUsd, 0.012);
  });

  it('maps parse and contract failures to allowlisted diagnostics without raw content', async () => {
    const dataset = loadDataset();
    const rawSentinel = 'RAW_PROVIDER_BODY_SENTINEL';
    const adapter: MemoryV3LifecycleModelAdapter = async () => ({
      rawContent: `{${rawSentinel}`,
      usage: null,
    });
    const result = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter,
    }));
    assert.equal(result.failureCount, 12);
    assert.equal(result.failures.every((failure) =>
      failure.stage === 'parse' && failure.diagnosticCode === 'lifecycle_model_parse_invalid'), true);
    assert.equal(JSON.stringify(result).includes(rawSentinel), false);

    const contractSentinel = 'RAW_CONTRACT_SENTINEL';
    const invalidContract: MemoryV3LifecycleModelAdapter = async () => ({
      rawContent: JSON.stringify({
        operations: [{
          type: 'ignore',
          candidateRef: contractSentinel,
          targetMemoryRef: null,
        }],
      }),
      usage: null,
    });
    const contractResult = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: invalidContract,
    }));
    assert.equal(contractResult.failureCount, 12);
    assert.equal(contractResult.failures.every((failure) =>
      failure.stage === 'contract' &&
      failure.diagnosticCode === 'lifecycle_model_contract_invalid'), true);
    assert.equal(JSON.stringify(contractResult).includes(contractSentinel), false);
  });
});

describe('lifecycle model benchmark review packet and source isolation', () => {
  it('builds a detached local packet with synthetic messages and null human verdicts', async () => {
    const dataset = loadDataset();
    const fake = await exactAdapter(dataset);
    const result = await runLifecycleModelBenchmark(benchmarkOptions({
      dataset,
      execute: true,
      adapter: fake.adapter,
    }));
    const packet = buildLifecycleModelReviewPacket({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset,
      benchmarkResult: result,
    });
    assert.equal(packet.cases.length, 12);
    assert.deepEqual(packet.cases.map((entry) => entry.stepId), [...profile.stepIds]);
    assert.equal(packet.cases.every((entry) =>
      entry.messages.length > 0 &&
      entry.semanticVerdict === null &&
      entry.forbiddenMeaningVerdict === null &&
      entry.reviewerNotes === null), true);
    const firstText = packet.cases[0].messages[0].text;
    packet.cases[0].messages[0].text = 'mutated packet';
    const packetAgain = buildLifecycleModelReviewPacket({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset,
      benchmarkResult: result,
    });
    assert.equal(packetAgain.cases[0].messages[0].text, firstText);
    assert.equal(JSON.stringify(result).includes(firstText), false);
    assert.throws(() => buildLifecycleModelReviewPacket({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset,
      benchmarkResult: structuredClone(result),
    }));
  });

  it('imports exactly the eight approved offline dependencies', () => {
    const source = readFileSync(ENGINE_PATH, 'utf8');
    const imports = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    assert.deepEqual(imports, [
      './lifecycle-model-benchmark-profile.ts',
      './lifecycle-model-benchmark-dataset.ts',
      './benchmark-budget.mjs',
      './lifecycle-evaluator.mjs',
      '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts',
      '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts',
      '../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts',
      '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts',
    ]);
    for (const forbidden of [
      'supabaseClient', 'lifecycleStore', 'shadowStore', 'node:fs',
      'process.env', 'Deno.env', 'globalThis.fetch', '_tmp-',
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
