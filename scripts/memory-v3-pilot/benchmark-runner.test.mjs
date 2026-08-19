/**
 * Memory V3 Task 3B — offline benchmark runner tests.
 * Injected adapter only. No network, filesystem, env, or live OpenRouter.
 * Run: node --test scripts/memory-v3-pilot/benchmark-runner.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runOfflineBenchmark } from './benchmark-runner.mjs';
import { buildExtractorRequest } from './extractor-prompt.mjs';
import { createOpenRouterAdapter } from './openrouter-adapter.mjs';
import { createOpenRouterFetchTransport } from './openrouter-fetch-transport.mjs';

const EMPTY_CONTENT = '{"items":[],"evidence":[]}';
const EXTRACTOR_VERSION = 'offline-core-v1';
const SENTINELS = Object.freeze({
  dialogue: 'RAW_RUNNER_DIALOGUE_SENTINEL',
  gold: 'LEAK_RUNNER_GOLD_SENTINEL',
  title: 'LEAK_RUNNER_TITLE_SENTINEL',
  getter: 'RAW_RUNNER_GETTER_SENTINEL',
  adapter: 'RAW_RUNNER_ADAPTER_SENTINEL',
  spoof: 'RAW_SECRET',
});

function sampleCase(caseId = 'run-case-01') {
  return {
    caseId,
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
    mustNotRemember: [],
  };
}

function sampleDataset(cases) {
  return {
    datasetId: 'memory-v3-runner-fixture',
    version: '1.0.0',
    language: 'ru',
    privacy: 'synthetic-only',
    cases,
  };
}

function passingBudget(caseCount, overrides = {}) {
  return {
    caseCount,
    maxInputTokensPerCase: 4096,
    maxOutputTokensPerCase: 1200,
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.6,
    maxRequests: caseCount,
    maxBudgetUsd: 0.03,
    ...overrides,
  };
}

function conservativeBudget(caseCount) {
  return {
    caseCount,
    maxInputTokensPerCase: 16384,
    maxOutputTokensPerCase: 1200,
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.2,
    maxRequests: caseCount,
    maxBudgetUsd: caseCount === 24 ? 0.1132032 : 0.0283008,
  };
}

function abstainingAdapter() {
  const calls = [];
  const modelAdapter = async (request) => {
    calls.push(request);
    return EMPTY_CONTENT;
  };
  modelAdapter.calls = calls;
  return modelAdapter;
}

function requestBytes(caseData) {
  return new TextEncoder().encode(JSON.stringify(buildExtractorRequest(caseData))).byteLength;
}

function validRunnerOptions(overrides = {}) {
  const cases = overrides.cases ?? [sampleCase()];
  const adapter = overrides.modelAdapter ?? abstainingAdapter();
  return {
    dataset: overrides.dataset ?? sampleDataset(cases),
    modelAdapter: adapter,
    budget: overrides.budget ?? passingBudget(cases.length),
    extractorVersion: overrides.extractorVersion ?? EXTRACTOR_VERSION,
    maxPromptRequestBytesPerCase: overrides.maxPromptRequestBytesPerCase ?? 1_000_000,
  };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `report leaked ${sentinel}`);
  }
  assert.equal(serialized.includes('biographical'), false);
  assert.equal(serialized.includes('messages'), false);
  assert.equal(serialized.includes('category'), false);
}

async function assertPreflightReject(fn, adapter) {
  await assert.rejects(async () => {
    await fn();
  }, (error) => {
    assert.match(String(error.message), /^\[memory-v3:(benchmark-config|budget-gate)\]/);
    assert.equal(error.cause == null, true);
    return true;
  });
  assert.equal(adapter.calls.length, 0);
}

describe('runOfflineBenchmark preflight', () => {
  it('does not call the adapter for an invalid case', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([{ caseId: 'bad-case' }]),
          }),
        ),
      adapter,
    );
  });

  it('does not call the adapter for duplicate caseId', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            cases: [sampleCase('run-case-01'), sampleCase('run-case-01')],
          }),
        ),
      adapter,
    );
  });

  it('does not call the adapter when budget caseCount mismatches', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            budget: passingBudget(2),
          }),
        ),
      adapter,
    );
  });

  it('does not call the adapter when the budget gate fails', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            budget: passingBudget(1, { maxRequests: 0 }),
          }),
        ),
      adapter,
    );
  });

  it('does not call the adapter when a prompt request exceeds the byte cap', async () => {
    const adapter = abstainingAdapter();
    const caseData = sampleCase();
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            cases: [caseData],
            maxPromptRequestBytesPerCase: requestBytes(caseData) - 1,
          }),
        ),
      adapter,
    );
  });

  it('does not call the adapter for empty, sparse, or extended cases arrays', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([]),
            budget: passingBudget(0, { maxBudgetUsd: 0 }),
          }),
        ),
      adapter,
    );

    const sparse = [];
    sparse[0] = sampleCase('run-case-01');
    sparse[2] = sampleCase('run-case-03');
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset(sparse),
            budget: passingBudget(3),
          }),
        ),
      adapter,
    );

    const extended = [sampleCase()];
    extended.extra = sampleCase('run-case-extra');
    await assertPreflightReject(
      () =>
        runOfflineBenchmark(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset(extended),
          }),
        ),
      adapter,
    );
  });

  it('does not execute getters on options or dataset', async () => {
    const adapter = abstainingAdapter();
    let getterCalls = 0;
    const options = validRunnerOptions({ modelAdapter: adapter });
    Object.defineProperty(options, 'maxPromptRequestBytesPerCase', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertPreflightReject(() => runOfflineBenchmark(options), adapter);
    assert.equal(getterCalls, 0);

    const dataset = sampleDataset([sampleCase()]);
    Object.defineProperty(dataset, 'cases', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertPreflightReject(
      () => runOfflineBenchmark(validRunnerOptions({ modelAdapter: adapter, dataset })),
      adapter,
    );
    assert.equal(getterCalls, 0);
  });
});

describe('runOfflineBenchmark execution', () => {
  it('runs cases sequentially with maxActive 1', async () => {
    const dataset = sampleDataset([
      sampleCase('run-case-01'),
      sampleCase('run-case-02'),
      sampleCase('run-case-03'),
    ]);
    let active = 0;
    let maxActive = 0;
    const order = [];
    const modelAdapter = async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${request.input.caseId}`);
      await Promise.resolve();
      order.push(`end:${request.input.caseId}`);
      active -= 1;
      return EMPTY_CONTENT;
    };
    const report = await runOfflineBenchmark(
      validRunnerOptions({
        dataset,
        modelAdapter,
        budget: passingBudget(3),
      }),
    );
    assert.equal(maxActive, 1);
    assert.deepEqual(order, [
      'start:run-case-01',
      'end:run-case-01',
      'start:run-case-02',
      'end:run-case-02',
      'start:run-case-03',
      'end:run-case-03',
    ]);
    assert.equal(report.attemptedCount, 3);
    assert.equal(report.successCount, 3);
    assert.equal(report.failureCount, 0);
  });

  it('continues after a middle-case failure without retry', async () => {
    const calls = [];
    const modelAdapter = async (request) => {
      calls.push(request.input.caseId);
      if (request.input.caseId === 'run-case-02') {
        throw new Error(`[memory-v3:adapter] ${SENTINELS.spoof}`);
      }
      return EMPTY_CONTENT;
    };
    const dataset = sampleDataset([
      sampleCase('run-case-01'),
      sampleCase('run-case-02'),
      sampleCase('run-case-03'),
    ]);
    const snapshot = structuredClone(dataset);
    const report = await runOfflineBenchmark(
      validRunnerOptions({
        dataset,
        modelAdapter,
        budget: passingBudget(3),
      }),
    );
    assert.deepEqual(calls, ['run-case-01', 'run-case-02', 'run-case-03']);
    assert.equal(report.caseCount, 3);
    assert.equal(report.attemptedCount, 3);
    assert.equal(report.successCount, 2);
    assert.equal(report.failureCount, 1);
    assert.deepEqual(
      report.runs.map((entry) => entry.caseId),
      ['run-case-01', 'run-case-03'],
    );
    assert.deepEqual(report.failures, [{ caseId: 'run-case-02', stage: 'adapter' }]);
    assert.equal('evaluation' in report, false);
    assertNoSecrets(report);
    assert.deepEqual(dataset, snapshot);

    const again = await runOfflineBenchmark(
      validRunnerOptions({
        dataset,
        modelAdapter,
        budget: passingBudget(3),
      }),
    );
    assert.deepEqual(again, report);
  });
});

describe('runOfflineBenchmark conservative budget snapshot 2026-08-19', () => {
  it('passes the 24-case ceiling at the exact total $0.1132032', async () => {
    const cases = Array.from({ length: 24 }, (_, index) =>
      sampleCase(`run-case-${String(index + 1).padStart(2, '0')}`),
    );
    const adapter = abstainingAdapter();
    const report = await runOfflineBenchmark(
      validRunnerOptions({
        dataset: sampleDataset(cases),
        modelAdapter: adapter,
        budget: conservativeBudget(24),
      }),
    );
    assert.equal(adapter.calls.length, 24);
    assert.equal(report.budget.absoluteInputTokens, 393216);
    assert.equal(report.budget.absoluteOutputTokens, 28800);
    assert.equal(report.budget.inputCostUsd, '0.0786432');
    assert.equal(report.budget.outputCostUsd, '0.03456');
    assert.equal(report.budget.absoluteCostUsd, '0.1132032');
    assert.equal(report.budget.gate, 'PASS');
    assert.equal(report.successCount, 24);
  });

  it('passes the 6-case ceiling at the exact total $0.0283008', async () => {
    const cases = Array.from({ length: 6 }, (_, index) =>
      sampleCase(`run-case-${String(index + 1).padStart(2, '0')}`),
    );
    const adapter = abstainingAdapter();
    const report = await runOfflineBenchmark(
      validRunnerOptions({
        dataset: sampleDataset(cases),
        modelAdapter: adapter,
        budget: conservativeBudget(6),
      }),
    );
    assert.equal(adapter.calls.length, 6);
    assert.equal(report.budget.absoluteCostUsd, '0.0283008');
    assert.equal(report.budget.gate, 'PASS');
  });
});

describe('runOfflineBenchmark composition with fetch transport', () => {
  it('wires fake fetch through adapter without calling global fetch', async () => {
    const previous = globalThis.fetch;
    let globalFetchCalls = 0;
    let fakeFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error('GLOBAL_FETCH_SENTINEL');
    };
    try {
      const fetchImpl = async () => {
        fakeFetchCalls += 1;
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion',
              created: 1,
              model: 'openai/gpt-5.6-luna',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: EMPTY_CONTENT },
                },
              ],
            });
          },
        };
      };
      const transport = createOpenRouterFetchTransport({
        fetchImpl,
        timeoutMs: 1000,
        maxResponseBytes: 1_000_000,
      });
      const modelAdapter = createOpenRouterAdapter({
        transport,
        apiKey: 'test-memory-v3-openrouter-key',
        model: 'openai/gpt-5.6-luna',
        maxOutputTokens: 1200,
      });
      const report = await runOfflineBenchmark(
        validRunnerOptions({
          modelAdapter,
          cases: [sampleCase('run-case-01'), sampleCase('run-case-02')],
          budget: passingBudget(2),
        }),
      );
      assert.equal(globalFetchCalls, 0);
      assert.equal(fakeFetchCalls, 2);
      assert.equal(report.successCount, 2);
      assert.equal(report.failureCount, 0);
      assertNoSecrets(report);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
