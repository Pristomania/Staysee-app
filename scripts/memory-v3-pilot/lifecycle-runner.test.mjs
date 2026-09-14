import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { canonicalStringify } from './contracts.mjs';

import {
  createScriptedLifecycleAdapter,
  runSyntheticLifecycleBenchmark,
} from './lifecycle-runner.mjs';

const DATASET_URL = new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url);
const dataset = JSON.parse(readFileSync(DATASET_URL, 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function routedScriptedAdapter(source = dataset, hooks = {}) {
  const adapters = new Map(source.scenarios.map((scenario) => [
    scenario.scenarioId,
    createScriptedLifecycleAdapter({ scenario }),
  ]));
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const adapter = async (request) => {
    calls.push(`${request.session.scenarioId}/${request.session.stepId}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await hooks.before?.(request, calls.length);
      return await adapters.get(request.session.scenarioId)(request);
    } finally {
      active -= 1;
    }
  };
  adapter.calls = calls;
  adapter.maxActive = () => maxActive;
  return adapter;
}

describe('scripted lifecycle adapter', () => {
  test('compiles authoring targets to runtime keys without leaking gold or dialogue', async () => {
    const scenario = clone(dataset.scenarios[0]);
    const adapter = createScriptedLifecycleAdapter({ scenario });
    const first = scenario.steps[0];
    const request = {
      session: {
        scenarioId: scenario.scenarioId,
        stepId: first.stepId,
        at: first.at,
        conversationId: first.conversationId,
      },
      currentState: { scenarioId: scenario.scenarioId, nextMemoryOrdinal: 1, items: [] },
      extraction: first.validatedExtraction,
    };
    const proposal = await adapter(request);
    assert.deepEqual(proposal, [{
      type: 'create',
      candidateLocalItemKey: first.scriptedProposal[0].candidateLocalItemKey,
      targetMemoryKey: null,
    }]);
    assert.deepEqual(Object.keys(request).sort(), ['currentState', 'extraction', 'session']);
    const serialized = JSON.stringify({ request, proposal });
    assert.doesNotMatch(serialized, /goldMemoryId|expectedState|mustNotRemember|message.text/);
    assert.deepEqual(scenario, dataset.scenarios[0]);
  });

  test('rejects a mismatched step before returning a proposal', async () => {
    const adapter = createScriptedLifecycleAdapter({ scenario: dataset.scenarios[0] });
    await assert.rejects(() => adapter({
      session: { scenarioId: 'wrong', stepId: 'wrong', at: '2026-01-01T00:00:00Z', conversationId: 'wrong' },
      currentState: { scenarioId: dataset.scenarios[0].scenarioId, nextMemoryOrdinal: 1, items: [] },
      extraction: dataset.scenarios[0].steps[0].validatedExtraction,
    }), /^MemoryV3LifecycleRunnerError: \[memory-v3:lifecycle-runner\]/);
  });
});

describe('synthetic lifecycle runner preflight', () => {
  for (const [name, mutate] of [
    ['wrong dataset id', (value) => { value.datasetId = 'wrong'; }],
    ['wrong version', (value) => { value.version = '2.0.0'; }],
    ['empty scenarios', (value) => { value.scenarios = []; }],
    ['duplicate scenario id', (value) => { value.scenarios[1].scenarioId = value.scenarios[0].scenarioId; }],
    ['wrong step order', (value) => { value.scenarios[0].steps.reverse(); }],
    ['backwards time', (value) => { value.scenarios[0].steps[1].at = '2020-01-01T00:00:00Z'; }],
    ['unresolved proposal target', (value) => { value.scenarios[0].steps[1].scriptedProposal[0].targetGoldMemoryId = 'missing'; }],
    ['malformed expected state', (value) => { value.scenarios[0].steps[0].expectedState.items[0].revision = 0; }],
    ['provider-like field', (value) => { value.provider = 'forbidden'; }],
  ]) {
    test(`rejects ${name} before adapter calls`, async () => {
      const input = clone(dataset);
      mutate(input);
      let calls = 0;
      await assert.rejects(() => runSyntheticLifecycleBenchmark({
        dataset: input,
        reconciliationAdapter: async () => { calls += 1; return []; },
      }), /^MemoryV3LifecycleRunnerError: \[memory-v3:lifecycle-runner\]/);
      assert.equal(calls, 0);
    });
  }

  test('rejects accessor, symbol, sparse, and cyclic inputs without executing getters', async () => {
    const hostile = [
      () => {
        const value = clone(dataset);
        let getterCalls = 0;
        Object.defineProperty(value, 'provider', { enumerable: true, get() { getterCalls += 1; return 'secret'; } });
        return { value, getterCalls: () => getterCalls };
      },
      () => { const value = clone(dataset); value[Symbol('secret')] = true; return { value, getterCalls: () => 0 }; },
      () => { const value = clone(dataset); delete value.scenarios[1]; return { value, getterCalls: () => 0 }; },
      () => { const value = clone(dataset); value.self = value; return { value, getterCalls: () => 0 }; },
    ];
    for (const make of hostile) {
      const { value, getterCalls } = make();
      let calls = 0;
      await assert.rejects(() => runSyntheticLifecycleBenchmark({
        dataset: value,
        reconciliationAdapter: async () => { calls += 1; return []; },
      }), /^MemoryV3LifecycleRunnerError: \[memory-v3:lifecycle-runner\]/);
      assert.equal(calls, 0);
      assert.equal(getterCalls(), 0);
    }
  });

  test('rejects setter-only, non-enumerable, inherited, revoked, and stateful inputs before calls', async () => {
    const hostile = [];
    const setterOnly = clone(dataset);
    let setterCalls = 0;
    Object.defineProperty(setterOnly, 'datasetId', { enumerable: true, set() { setterCalls += 1; } });
    hostile.push(setterOnly);
    const nonEnumerable = clone(dataset);
    Object.defineProperty(nonEnumerable, 'datasetId', { value: dataset.datasetId, enumerable: false });
    hostile.push(nonEnumerable);
    hostile.push(Object.assign(Object.create({ inherited: true }), clone(dataset)));
    const revoked = Proxy.revocable(clone(dataset), {});
    revoked.revoke();
    hostile.push(revoked.proxy);
    let descriptorCalls = 0;
    hostile.push(new Proxy(clone(dataset), {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        if (descriptorCalls > 1) throw new Error('RAW_RUNNER_TRAP_SENTINEL');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }));
    for (const value of hostile) {
      let calls = 0;
      await assert.rejects(
        () => runSyntheticLifecycleBenchmark({
          dataset: value,
          reconciliationAdapter: async () => { calls += 1; return []; },
        }),
        (error) => error.name === 'MemoryV3LifecycleRunnerError' &&
          !JSON.stringify(error).match(/RAW_RUNNER_TRAP_SENTINEL|TypeError/),
      );
      assert.equal(calls, 0);
    }
    assert.equal(setterCalls, 0);
  });
});

describe('synthetic lifecycle runner execution', () => {
  test('runs all 80 steps sequentially and passes every lifecycle gate', async () => {
    const input = clone(dataset);
    const adapter = routedScriptedAdapter(input, { before: () => new Promise((resolve) => setImmediate(resolve)) });
    const result = await runSyntheticLifecycleBenchmark({ dataset: input, reconciliationAdapter: adapter });
    assert.equal(adapter.calls.length, 80);
    assert.equal(adapter.maxActive(), 1);
    assert.equal(result.attemptedStepCount, 80);
    assert.equal(result.successfulStepCount, 80);
    assert.equal(result.failureCount, 0);
    assert.equal(result.externalCalls, 0);
    assert.deepEqual(result.hardGates, { status: 'PASS' });
    assert.deepEqual(result.scenarios.map((row) => row.scenarioId), dataset.scenarios.map((row) => row.scenarioId));
    assert.deepEqual(Object.keys(result).sort(), [
      'aggregate', 'attemptedStepCount', 'datasetId', 'externalCalls', 'failureCount',
      'hardGates', 'maxActive', 'scenarioCount', 'scenarios', 'stepCount',
      'successfulStepCount', 'version',
    ].sort());
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(input, dataset);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(
      serialized,
      /"(?:messages|messageText|mustNotRemember|expectedState|scriptedProposal|goldMemoryId|prompt|provider|apiKey|Authorization)"\s*:/,
    );
  });

  test('stops only the failed scenario, continues with an empty next state, and does not retry', async () => {
    const input = clone(dataset);
    const base = routedScriptedAdapter(input);
    const failedStep = input.scenarios[1].steps[1].stepId;
    let calls = 0;
    const adapter = async (request) => {
      calls += 1;
      if (request.session.stepId === failedStep) throw new Error('RAW_ADAPTER_SECRET');
      if (request.session.scenarioId === input.scenarios[2].scenarioId && request.session.stepId.endsWith('-s01')) {
        assert.equal(request.currentState.items.length, 0);
      }
      return base(request);
    };
    const result = await runSyntheticLifecycleBenchmark({ dataset: input, reconciliationAdapter: adapter });
    assert.equal(calls, 78);
    assert.equal(result.attemptedStepCount, 78);
    assert.equal(result.successfulStepCount, 77);
    assert.equal(result.failureCount, 1);
    assert.deepEqual(result.scenarios[1].failures, [{
      stepId: failedStep,
      stage: 'adapter',
      diagnosticCode: 'lifecycle_runner_adapter_failed',
    }]);
    assert.doesNotMatch(JSON.stringify(result), /RAW_ADAPTER_SECRET|cause/);
  });

  test('does not evaluate or expose a partial step when the last proposal row is invalid', async () => {
    const input = clone(dataset);
    const base = routedScriptedAdapter(input);
    const targetScenario = input.scenarios.find((scenario) => scenario.scenarioId === 'deterministic-equal-time');
    const targetStep = targetScenario.steps[0].stepId;
    const adapter = async (request) => {
      const proposal = await base(request);
      if (request.session.stepId !== targetStep) return proposal;
      return [proposal[0], { ...proposal[1], candidateLocalItemKey: 'missing-candidate' }];
    };
    const result = await runSyntheticLifecycleBenchmark({ dataset: input, reconciliationAdapter: adapter });
    const row = result.scenarios.find((scenario) => scenario.scenarioId === targetScenario.scenarioId);
    assert.equal(row.stepCount, 0);
    assert.equal(row.counts.exactStateStepCount, 0);
    assert.equal(row.failures.length, 1);
    assert.equal(result.failureCount, 1);
    assert.equal(result.successfulStepCount, 76);
    assert.equal(result.attemptedStepCount, 77);
  });

  test('is deterministic under proposal, expected-state, and evidence reordering without localeCompare', async () => {
    const reordered = JSON.parse(JSON.stringify(dataset));
    for (const scenario of reordered.scenarios) {
      for (const step of scenario.steps) {
        step.scriptedProposal.reverse();
        step.validatedExtraction.items.reverse();
        step.validatedExtraction.evidence.reverse();
        step.expectedState.items.reverse();
        for (const item of step.expectedState.items) item.evidence.reverse();
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare');
    let localeCalls = 0;
    Object.defineProperty(String.prototype, 'localeCompare', {
      configurable: true,
      value() { localeCalls += 1; throw new Error('localeCompare is forbidden'); },
    });
    try {
      const firstAdapter = routedScriptedAdapter(dataset);
      const secondAdapter = routedScriptedAdapter(reordered);
      const first = await runSyntheticLifecycleBenchmark({ dataset, reconciliationAdapter: firstAdapter });
      const second = await runSyntheticLifecycleBenchmark({ dataset: reordered, reconciliationAdapter: secondAdapter });
      assert.equal(canonicalStringify(second), canonicalStringify(first));
      assert.equal(localeCalls, 0);
    } finally {
      Object.defineProperty(String.prototype, 'localeCompare', descriptor);
    }
  });
});

describe('lifecycle runner external-call source locks', () => {
  test('keeps every new lifecycle production module offline and non-executable', () => {
    for (const file of [
      'lifecycle-contract.mjs',
      'lifecycle-reducer.mjs',
      'lifecycle-evaluator.mjs',
      'lifecycle-runner.mjs',
    ]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(
        source,
        /(?:\bfetch\b|node:(?:fs|http|https|net)|process\.env|Deno\.env|\.env\b|OpenRouter|Supabase|production|staging|import\.meta\.main|process\.argv)/i,
        file,
      );
    }
  });
});
