/**
 * Memory V3 Task 6 — V2 offline benchmark runner tests.
 * Injected adapter only. No network, filesystem writes, env, or live OpenRouter.
 * Run: node --test scripts/memory-v3-pilot/benchmark-runner-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractCaseV2, projectSafeExtractorDiagnosticV2 } from './extractor-core-v2.mjs';
import { buildExtractorRequestV2 } from './extractor-prompt-v2.mjs';
import {
  projectOfflineBenchmarkFailureDiagnosticV2,
  runOfflineBenchmarkV2,
} from './benchmark-runner-v2.mjs';

const EMPTY_CONTENT = '{"items":[],"evidence":[]}';
const EXTRACTOR_VERSION = 'memory-v3-v2-runner-test';
const DATASET_ID = 'memory-v3-ru-golden-v2';
const DATASET_VERSION = '2.0.0';
const CONFIG_PREFIX = '[memory-v3:v2-benchmark-config]';
const RESULT_KEYS = Object.freeze([
  'attemptedCount',
  'caseCount',
  'extractorVersion',
  'failureCount',
  'failures',
  'runs',
  'successCount',
]);
const SENTINELS = Object.freeze({
  dialogue: 'RAW_RUNNER_V2_DIALOGUE_SENTINEL',
  gold: 'LEAK_RUNNER_V2_GOLD_SENTINEL',
  title: 'LEAK_RUNNER_V2_TITLE_SENTINEL',
  getter: 'RAW_RUNNER_V2_GETTER_SENTINEL',
  adapter: 'RAW_RUNNER_V2_ADAPTER_SENTINEL',
  budget: 'RAW_RUNNER_V2_BUDGET_SENTINEL',
  spoof: 'RAW_RUNNER_V2_SPOOF_SECRET',
  proxy: 'RAW_RUNNER_V2_PROXY_SENTINEL',
});
const GOLDEN_V2_URL = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
const RUNNER_MODULE_URL = new URL('./benchmark-runner-v2.mjs', import.meta.url);

function emptyGold() {
  return {
    required: { events: [], recurrences: [], hypotheses: [] },
    acceptable: { events: [], recurrences: [], hypotheses: [] },
  };
}

function sampleCase(caseId = 'run-v2-case-01') {
  return {
    caseId,
    title: SENTINELS.title,
    category: 'event',
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: `${SENTINELS.dialogue} Синтетический первый эпизод.`,
        createdAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'user',
        text: 'Синтетический второй эпизод.',
        createdAt: '2024-01-10T10:01:00.000Z',
      },
    ],
    gold: {
      required: {
        events: [
          {
            goldItemId: 'required-event-01',
            claim: SENTINELS.gold,
            supportMessageIds: ['m1'],
          },
        ],
        recurrences: [],
        hypotheses: [],
      },
      acceptable: { events: [], recurrences: [], hypotheses: [] },
    },
    mustNotRemember: [],
  };
}

function sampleDataset(cases, overrides = {}) {
  return {
    datasetId: overrides.datasetId ?? DATASET_ID,
    version: overrides.version ?? DATASET_VERSION,
    language: overrides.language ?? 'ru',
    privacy: overrides.privacy ?? 'synthetic-only',
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
  return new TextEncoder().encode(JSON.stringify(buildExtractorRequestV2(caseData))).byteLength;
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

function validEventItem(overrides = {}) {
  return {
    itemRef: 'item-1',
    kind: 'event',
    claim: 'Синтетическое событие',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: '2022-05-01',
    eventTimeEnd: '2022-05-31',
    alternative: null,
    ...overrides,
  };
}

function validEventEvidence(overrides = {}) {
  return {
    itemRef: 'item-1',
    sourceMessageId: 'm1',
    relation: 'supports',
    supportType: null,
    episodeKey: 'episode:m1',
    ...overrides,
  };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `report leaked ${sentinel}`);
  }
  assert.equal(serialized.includes('messages'), false);
  assert.equal(serialized.includes(SENTINELS.dialogue), false);
  assert.equal('cause' in (value || {}), false);
}

async function assertPreflightReject(fn, adapter) {
  await assert.rejects(async () => {
    await fn();
  }, (error) => {
    assert.match(String(error.message), new RegExp(`^${CONFIG_PREFIX.replace(/[[\]]/g, '\\$&')}`));
    assert.equal(error.cause == null, true);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const sentinel of Object.values(SENTINELS)) {
      assert.equal(String(error.message).includes(sentinel), false, `error leaked ${sentinel}`);
    }
    return true;
  });
  assert.equal(adapter.calls.length, 0);
}

function assertResultSchema(result) {
  assert.deepEqual(Object.keys(result).sort(), [...RESULT_KEYS]);
  assert.equal(result.attemptedCount, result.runs.length + result.failures.length);
  assert.equal('budget' in result, false);
  assert.equal('promptRequestBytes' in result, false);
  assert.equal('language' in result, false);
  assert.equal('privacy' in result, false);
  assert.equal('dataset' in result, false);
  assert.equal('evaluation' in result, false);
  assert.equal('actualUsage' in result, false);
  assert.equal('actualCostUsd' in result, false);
  for (const failure of result.failures) {
    assert.deepEqual(Object.keys(failure).sort(), ['caseId', 'diagnosticCode', 'stage']);
  }
  assertNoSecrets(result);
}

describe('V2 runner exports', () => {
  it('exports runOfflineBenchmarkV2 and projectOfflineBenchmarkFailureDiagnosticV2', () => {
    assert.equal(typeof runOfflineBenchmarkV2, 'function');
    assert.equal(typeof projectOfflineBenchmarkFailureDiagnosticV2, 'function');
  });
});

describe('runOfflineBenchmarkV2 strict options preflight', () => {
  it('rejects null, array, and primitive options with 0 adapter calls', async () => {
    const adapter = abstainingAdapter();
    for (const options of [null, [], 1, 'x', true, undefined]) {
      await assertPreflightReject(() => runOfflineBenchmarkV2(options), adapter);
    }
  });

  it('rejects missing, unknown, symbol, accessor, and non-enumerable fields with 0 getter calls', async () => {
    const adapter = abstainingAdapter();
    let getterCalls = 0;

    const missing = validRunnerOptions({ modelAdapter: adapter });
    delete missing.budget;
    await assertPreflightReject(() => runOfflineBenchmarkV2(missing), adapter);

    const unknown = validRunnerOptions({ modelAdapter: adapter });
    unknown.extra = true;
    await assertPreflightReject(() => runOfflineBenchmarkV2(unknown), adapter);

    const withSymbol = validRunnerOptions({ modelAdapter: adapter });
    withSymbol[Symbol('hidden')] = SENTINELS.getter;
    await assertPreflightReject(() => runOfflineBenchmarkV2(withSymbol), adapter);

    const getterOptions = validRunnerOptions({ modelAdapter: adapter });
    Object.defineProperty(getterOptions, 'maxPromptRequestBytesPerCase', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertPreflightReject(() => runOfflineBenchmarkV2(getterOptions), adapter);
    assert.equal(getterCalls, 0);

    const nonEnumerable = validRunnerOptions({ modelAdapter: adapter });
    Object.defineProperty(nonEnumerable, 'extractorVersion', {
      enumerable: false,
      configurable: true,
      value: EXTRACTOR_VERSION,
    });
    await assertPreflightReject(() => runOfflineBenchmarkV2(nonEnumerable), adapter);
    assert.equal(getterCalls, 0);
  });

  it('rejects a non-function adapter and empty extractorVersion with 0 calls', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () => runOfflineBenchmarkV2(validRunnerOptions({ modelAdapter: adapter, extractorVersion: '' })),
      adapter,
    );
    await assertPreflightReject(
      () => runOfflineBenchmarkV2(validRunnerOptions({ modelAdapter: adapter, extractorVersion: 12 })),
      adapter,
    );
    const calls = [];
    await assert.rejects(
      () =>
        runOfflineBenchmarkV2({
          ...validRunnerOptions(),
          modelAdapter: { calls },
        }),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:v2-benchmark-config\]/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it('rejects non-positive or non-safe maxPromptRequestBytesPerCase with 0 calls', async () => {
    const adapter = abstainingAdapter();
    for (const maxPromptRequestBytesPerCase of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await assertPreflightReject(
        () =>
          runOfflineBenchmarkV2(
            validRunnerOptions({ modelAdapter: adapter, maxPromptRequestBytesPerCase }),
          ),
        adapter,
      );
    }
  });
});

describe('runOfflineBenchmarkV2 dataset identity and shape', () => {
  it('rejects V1, other, missing, empty, sparse, duplicate, and invalid cases with 0 calls', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([sampleCase()], { datasetId: 'memory-v3-ru-golden-v1' }),
          }),
        ),
      adapter,
    );
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([sampleCase()], { datasetId: 'other-dataset' }),
          }),
        ),
      adapter,
    );
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([sampleCase()], { version: '1.0.0' }),
          }),
        ),
      adapter,
    );
    const missingIdentity = sampleDataset([sampleCase()]);
    delete missingIdentity.datasetId;
    await assertPreflightReject(
      () => runOfflineBenchmarkV2(validRunnerOptions({ modelAdapter: adapter, dataset: missingIdentity })),
      adapter,
    );
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([]),
            budget: passingBudget(0, { maxBudgetUsd: 0 }),
          }),
        ),
      adapter,
    );

    const sparse = [];
    sparse[0] = sampleCase('run-v2-case-01');
    sparse[2] = sampleCase('run-v2-case-03');
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset(sparse),
            budget: passingBudget(3),
          }),
        ),
      adapter,
    );

    const extended = [sampleCase()];
    extended.extra = sampleCase('run-v2-extra');
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({ modelAdapter: adapter, dataset: sampleDataset(extended) }),
        ),
      adapter,
    );

    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            cases: [sampleCase('dup'), sampleCase('dup')],
          }),
        ),
      adapter,
    );

    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            dataset: sampleDataset([{ caseId: 'bad-case' }]),
          }),
        ),
      adapter,
    );
  });

  it('rejects getter, accessor, symbol, and non-enumerable dataset records with 0 getter calls', async () => {
    const adapter = abstainingAdapter();
    let getterCalls = 0;
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
      () => runOfflineBenchmarkV2(validRunnerOptions({ modelAdapter: adapter, dataset })),
      adapter,
    );
    assert.equal(getterCalls, 0);
  });
});

describe('runOfflineBenchmarkV2 budget preflight', () => {
  it('rejects a non-integer or mismatched budget.caseCount with 0 adapter calls', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            budget: passingBudget(1.5),
          }),
        ),
      adapter,
    );
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            budget: passingBudget(2),
          }),
        ),
      adapter,
    );
  });

  it('calls assertBudgetGate before any adapter call and wraps a failing gate', async () => {
    const adapter = abstainingAdapter();
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            budget: passingBudget(1, { maxRequests: 0 }),
          }),
        ),
      adapter,
    );
  });

  it('rejects budget getters, symbols, and accessors with 0 getter calls and no budget sentinel', async () => {
    const adapter = abstainingAdapter();
    let getterCalls = 0;
    const budget = passingBudget(1);
    Object.defineProperty(budget, 'caseCount', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.budget);
      },
    });
    await assertPreflightReject(
      () => runOfflineBenchmarkV2(validRunnerOptions({ modelAdapter: adapter, budget })),
      adapter,
    );
    assert.equal(getterCalls, 0);

    const withSymbol = passingBudget(1);
    withSymbol[Symbol('budget')] = SENTINELS.budget;
    await assertPreflightReject(
      () => runOfflineBenchmarkV2(validRunnerOptions({ modelAdapter: adapter, budget: withSymbol })),
      adapter,
    );
    assert.equal(getterCalls, 0);
  });
});

describe('runOfflineBenchmarkV2 prompt byte preflight', () => {
  it('rejects a UTF-8 byte overflow before any adapter call and does not leak prompt text', async () => {
    const adapter = abstainingAdapter();
    const caseData = sampleCase();
    const bytes = requestBytes(caseData);
    assert.equal(bytes > new TextEncoder().encode('x').byteLength, true);
    await assertPreflightReject(
      () =>
        runOfflineBenchmarkV2(
          validRunnerOptions({
            modelAdapter: adapter,
            cases: [caseData, sampleCase('run-v2-case-02')],
            maxPromptRequestBytesPerCase: bytes - 1,
          }),
        ),
      adapter,
    );
  });
});

describe('runOfflineBenchmarkV2 sequential success', () => {
  it('runs cases sequentially with maxActive 1 and no retry', async () => {
    const dataset = sampleDataset([
      sampleCase('run-v2-case-01'),
      sampleCase('run-v2-case-02'),
      sampleCase('run-v2-case-03'),
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
    const result = await runOfflineBenchmarkV2(
      validRunnerOptions({
        dataset,
        modelAdapter,
        budget: passingBudget(3),
      }),
    );
    assert.equal(maxActive, 1);
    assert.deepEqual(order, [
      'start:run-v2-case-01',
      'end:run-v2-case-01',
      'start:run-v2-case-02',
      'end:run-v2-case-02',
      'start:run-v2-case-03',
      'end:run-v2-case-03',
    ]);
    assert.equal(result.attemptedCount, 3);
    assert.equal(result.successCount, 3);
    assert.equal(result.failureCount, 0);
    assert.deepEqual(
      result.runs.map((entry) => entry.caseId),
      ['run-v2-case-01', 'run-v2-case-02', 'run-v2-case-03'],
    );
    assert.deepEqual(result.failures, []);
    assertResultSchema(result);
  });
});

describe('runOfflineBenchmarkV2 continue after middle failure', () => {
  it('continues after a third-case adapter throw without retry or sentinel leak', async () => {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const ids = [
      'run-v2-case-01',
      'run-v2-case-02',
      'run-v2-case-03',
      'run-v2-case-04',
      'run-v2-case-05',
      'run-v2-case-06',
    ];
    const modelAdapter = async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(request.input.caseId);
      await Promise.resolve();
      active -= 1;
      if (request.input.caseId === 'run-v2-case-03') {
        throw new Error(SENTINELS.adapter);
      }
      return { items: [], evidence: [] };
    };
    const dataset = sampleDataset(ids.map((caseId) => sampleCase(caseId)));
    const snapshot = structuredClone(dataset);
    const result = await runOfflineBenchmarkV2(
      validRunnerOptions({
        dataset,
        modelAdapter,
        budget: passingBudget(6),
      }),
    );
    assert.equal(calls.length, 6);
    assert.deepEqual(calls, ids);
    assert.equal(maxActive, 1);
    assert.equal(result.attemptedCount, 6);
    assert.equal(result.successCount, 5);
    assert.equal(result.failureCount, 1);
    assert.deepEqual(
      result.runs.map((entry) => entry.caseId),
      ['run-v2-case-01', 'run-v2-case-02', 'run-v2-case-04', 'run-v2-case-05', 'run-v2-case-06'],
    );
    assert.deepEqual(result.failures, [
      {
        caseId: 'run-v2-case-03',
        stage: 'adapter',
        diagnosticCode: 'extractor_v2_adapter_failed',
      },
    ]);
    assert.equal(calls.filter((id) => id === 'run-v2-case-03').length, 1);
    assertResultSchema(result);
    assert.equal(JSON.stringify(result).includes(SENTINELS.adapter), false);
    assert.deepEqual(dataset, snapshot);
  });
});

describe('projectOfflineBenchmarkFailureDiagnosticV2', () => {
  function assertSafePublicCode(code, error) {
    const serialized = JSON.stringify({ diagnosticCode: code });
    for (const sentinel of Object.values(SENTINELS)) {
      assert.equal(String(code).includes(sentinel), false);
      assert.equal(serialized.includes(sentinel), false);
    }
    assert.equal(error == null || error.cause == null, true);
    assert.equal('cause' in (error || {}), false);
  }

  it('keeps a branded extractCaseV2 adapter failure as extractor_v2_adapter_failed', async () => {
    try {
      await extractCaseV2(
        sampleCase('run-v2-branded'),
        async () => {
          throw new Error(SENTINELS.adapter);
        },
        { extractorVersion: EXTRACTOR_VERSION },
      );
    } catch (error) {
      assert.equal(projectSafeExtractorDiagnosticV2(error), 'extractor_v2_adapter_failed');
      assert.equal(
        projectOfflineBenchmarkFailureDiagnosticV2(error),
        'extractor_v2_adapter_failed',
      );
      assertSafePublicCode('extractor_v2_adapter_failed', error);
      return;
    }
    assert.fail('expected extractCaseV2 to throw');
  });

  it('classifies unbranded spoofed name/prefix/code as extractor_v2_unknown_failure', () => {
    let getterCalls = 0;
    const error = new Error(`[memory-v3:v2-adapter] ${SENTINELS.spoof}`);
    error.name = 'MemoryV3V2ExtractorError';
    Object.defineProperty(error, 'diagnosticCode', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'extractor_v2_adapter_failed';
      },
    });
    const code = projectOfflineBenchmarkFailureDiagnosticV2(error);
    assert.equal(code, 'extractor_v2_unknown_failure');
    assert.equal(code === 'extractor_v2_adapter_failed', false);
    assert.equal(getterCalls, 0);
    assertSafePublicCode(code, error);
  });

  it('does not execute a diagnosticCode getter or leak a throwing Proxy', () => {
    let getterCalls = 0;
    const getterError = {};
    Object.defineProperty(getterError, 'diagnosticCode', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    assert.equal(
      projectOfflineBenchmarkFailureDiagnosticV2(getterError),
      'extractor_v2_unknown_failure',
    );
    assert.equal(getterCalls, 0);

    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error(SENTINELS.proxy);
        },
      },
    );
    assert.equal(
      projectOfflineBenchmarkFailureDiagnosticV2(proxy),
      'extractor_v2_unknown_failure',
    );
  });
});

describe('runOfflineBenchmarkV2 diagnostic stage matrix', () => {
  async function runWithPayload(payload) {
    return runOfflineBenchmarkV2(
      validRunnerOptions({
        dataset: sampleDataset([sampleCase('run-v2-diag')]),
        modelAdapter: async () => payload,
        budget: passingBudget(1),
      }),
    );
  }

  it('maps branded adapter, parse, shape, and contract failures to trusted stages', async () => {
    const adapterThrow = await runOfflineBenchmarkV2(
      validRunnerOptions({
        dataset: sampleDataset([sampleCase('run-v2-diag')]),
        modelAdapter: async () => {
          throw new Error(SENTINELS.adapter);
        },
        budget: passingBudget(1),
      }),
    );
    assert.deepEqual(adapterThrow.failures, [
      {
        caseId: 'run-v2-diag',
        stage: 'adapter',
        diagnosticCode: 'extractor_v2_adapter_failed',
      },
    ]);

    const parse = await runWithPayload('{');
    assert.deepEqual(parse.failures, [
      {
        caseId: 'run-v2-diag',
        stage: 'parse',
        diagnosticCode: 'extractor_v2_parse_invalid',
      },
    ]);

    const shape = await runWithPayload({
      items: [validEventItem()],
      evidence: [validEventEvidence({ extra: true })],
    });
    assert.deepEqual(shape.failures, [
      {
        caseId: 'run-v2-diag',
        stage: 'shape',
        diagnosticCode: 'extractor_v2_shape_invalid',
      },
    ]);

    const contract = await runWithPayload({
      items: [validEventItem()],
      evidence: [validEventEvidence({ relation: 'contradicts' })],
    });
    assert.deepEqual(contract.failures, [
      {
        caseId: 'run-v2-diag',
        stage: 'contract',
        diagnosticCode: 'extractor_v2_contract_missing_required_relation',
      },
    ]);

    for (const result of [adapterThrow, parse, shape, contract]) {
      assertResultSchema(result);
    }
  });
});

describe('runOfflineBenchmarkV2 real Golden V2 subset', () => {
  it('runs event-03 and safety-03 without mutating the golden file or calling fetch', async () => {
    const raw = await readFileAsync(GOLDEN_V2_URL, 'utf8');
    const golden = JSON.parse(raw);
    const snapshot = structuredClone(golden);
    const selected = ['memv3-ru-event-03', 'memv3-ru-safety-03'].map((caseId) => {
      const found = golden.cases.find((entry) => entry.caseId === caseId);
      assert.equal(found !== undefined, true, caseId);
      return structuredClone(found);
    });
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      throw new Error('GLOBAL_FETCH_SENTINEL');
    };
    const adapter = abstainingAdapter();
    try {
      const result = await runOfflineBenchmarkV2(
        validRunnerOptions({
          dataset: {
            datasetId: DATASET_ID,
            version: DATASET_VERSION,
            language: 'ru',
            privacy: 'synthetic-only',
            cases: selected,
          },
          modelAdapter: adapter,
          budget: passingBudget(2),
        }),
      );
      assert.equal(result.attemptedCount, 2);
      assert.equal(result.successCount, 2);
      assert.equal(result.failureCount, 0);
      assert.equal(adapter.calls.length, 2);
      assert.deepEqual(
        result.runs.map((entry) => entry.caseId),
        ['memv3-ru-event-03', 'memv3-ru-safety-03'],
      );
      assert.equal(fetchCalls, 0);
      assertResultSchema(result);
      assert.deepEqual(golden, snapshot);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe('runOfflineBenchmarkV2 output schema', () => {
  it('returns only the public V2 result fields', async () => {
    const result = await runOfflineBenchmarkV2(validRunnerOptions());
    assertResultSchema(result);
    assert.equal(result.extractorVersion, EXTRACTOR_VERSION);
    assert.equal(result.caseCount, 1);
    assert.equal(result.attemptedCount, result.runs.length + result.failures.length);
  });
});

describe('runOfflineBenchmarkV2 frozen V1 isolation', () => {
  it('uses only V2 extractor imports and does not import the V1 runner', () => {
    const source = readFileSync(fileURLToPath(RUNNER_MODULE_URL), 'utf8');
    assert.match(source, /validateCaseV2/);
    assert.match(source, /extractCaseV2/);
    assert.match(source, /projectSafeExtractorDiagnosticV2/);
    assert.match(source, /buildExtractorRequestV2/);
    assert.match(source, /assertBudgetGate/);
    assert.equal(/from '\.\/benchmark-runner\.mjs'/.test(source), false);
    assert.equal(/from '\.\/extractor-core\.mjs'/.test(source), false);
    assert.equal(/from '\.\/extractor-prompt\.mjs'/.test(source), false);
    assert.equal(/runOfflineBenchmark(?!V2)\(/.test(source), false);
    assert.equal(/extractCase(?!V2)\(/.test(source), false);
    assert.equal(/buildExtractorRequest(?!V2)\(/.test(source), false);
    assert.equal(/process\.env/.test(source), false);
    assert.equal(/globalThis\.fetch/.test(source), false);
    assert.equal(/from 'node:fs'/.test(source), false);
    assert.equal(/from 'node:http'/.test(source), false);
    assert.equal(/from 'node:https'/.test(source), false);
    assert.equal(/from 'node:net'/.test(source), false);
  });
});
