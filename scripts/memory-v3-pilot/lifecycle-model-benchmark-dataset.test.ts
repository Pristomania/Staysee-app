import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { canonicalStringify } from './contracts.mjs';
import { assignLifecycleItems } from './lifecycle-evaluator.mjs';
import {
  SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID,
  prepareLifecycleModelBenchmarkCases,
  stripTopicForEvaluator,
} from './lifecycle-model-benchmark-dataset.ts';
import {
  LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
  getLifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';
import { validateMemoryV3LifecycleState } from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import { applyMemoryV3LifecycleStep } from '../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts';
import { buildMemoryV3LifecycleReconcileRequest } from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';

const DATASET_URL = new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url);
const MODULE_URL = new URL('./lifecycle-model-benchmark-dataset.ts', import.meta.url);
const DATASET_MANIFEST_SHA256 = 'F815482957C23C2077C37DB6292B8E4510E66D863EC988381074061FA3E5FBEE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEMORY_KEY = /^[0-9a-f]{64}$/;

const EXPECTED_SELECTED = [
  ['paraphrase-event-dedup-s02', 'paraphrase-event-dedup', '5329a3a4-9e2b-4624-b6b1-90c4060ac562'],
  ['same-topic-distinct-events-s02', 'same-topic-distinct-events', '370a3843-82a3-4388-911c-a7fddde302f5'],
  ['event-date-correction-s03', 'event-date-correction', '05e6dfee-bce9-4714-aa29-ea582a348799'],
  ['scope-narrowing-s03', 'scope-narrowing', '473e89f8-cb9b-4888-8138-9696796f53ca'],
  ['hypothesis-supported-s03', 'hypothesis-supported', '7ad29dd6-af81-4240-a7d8-a63847d5a10e'],
  ['hypothesis-rejected-s03', 'hypothesis-rejected', '1e1e51cc-21ed-43cf-b068-50355d66f25d'],
  ['recurrence-growth-s02', 'recurrence-growth', '42355044-2582-42e4-b19d-ea95df1a26ca'],
  ['pattern-confirmation-s03', 'pattern-confirmation', 'df19d010-67e1-431c-b702-1588146c5d6f'],
  ['recurrence-stale-s03', 'recurrence-stale', 'fdc08af0-400e-4a84-95dd-98667d0acf57'],
  ['assistant-speculation-denied-s01', 'assistant-speculation-denied', '54fd10c0-6a78-4189-a280-a9bcf262d5c1'],
  ['prompt-injection-schema-s02', 'prompt-injection-schema', '1133032c-b022-46fa-868f-12cfa7d20bb6'],
  ['layered-coexistence-s01', 'layered-coexistence', '593bd7a1-1336-41ae-864b-28ad07109f1f'],
] as const;

const EXPECTED_OPERATIONS = [
  ['confirm'],
  ['create'],
  ['revise'],
  ['revise'],
  ['revise'],
  ['reject'],
  ['confirm'],
  ['ignore'],
  ['mark_stale'],
  ['ignore'],
  ['ignore'],
  ['create', 'create', 'create'],
] as const;

const EXPECTED_PRIOR_ITEM_COUNTS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0] as const;

interface SyntheticDatasetStep {
  stepId: string;
  expectedState: { items: Array<{ eventTimeStart: string | null }> };
  [key: string]: unknown;
}

interface SyntheticDatasetScenario {
  scenarioId: string;
  steps: SyntheticDatasetStep[];
  [key: string]: unknown;
}

interface SyntheticDataset {
  datasetId: string;
  version: string;
  language: string;
  scenarios: SyntheticDatasetScenario[];
  [key: string]: unknown;
}

function loadDataset(): SyntheticDataset {
  return JSON.parse(readFileSync(DATASET_URL, 'utf8')) as SyntheticDataset;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function manifestFingerprint(dataset: SyntheticDataset): string {
  return createHash('sha256')
    .update(canonicalStringify({
      datasetId: dataset.datasetId,
      version: dataset.version,
      language: dataset.language,
      scenarios: dataset.scenarios,
    }))
    .digest('hex')
    .toUpperCase();
}

async function captureDatasetError(dataset: unknown): Promise<Error> {
  let thrown: unknown;
  try {
    await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset,
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, 'MemoryV3LifecycleModelBenchmarkDatasetError');
  assert.match(thrown.message, /^\[memory-v3:lifecycle-model-dataset\] /);
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  return thrown;
}

describe('synthetic lifecycle model dataset identity and selection', () => {
  it('uses the approved immutable dataset manifest and exact profile order', async () => {
    const dataset = loadDataset();
    assert.equal(manifestFingerprint(dataset), DATASET_MANIFEST_SHA256);
    const profile = getLifecycleModelBenchmarkProfile(LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID);
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: profile.profileId,
      dataset,
    });
    assert.equal(prepared.length, 12);
    assert.deepEqual(prepared.map((entry) => entry.stepId), profile.stepIds);
    assert.deepEqual(
      prepared.map((entry) => [entry.stepId, entry.scenarioId, entry.conversationId]),
      EXPECTED_SELECTED,
    );
  });

  it('derives stable synthetic UUIDs and never reuses a selected conversation id', async () => {
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset: loadDataset(),
    });
    assert.equal(
      SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID,
      '11111111-1111-4111-8111-111111111111',
    );
    assert.equal(new Set(prepared.map((entry) => entry.conversationId)).size, 12);
    for (const entry of prepared) {
      assert.equal(entry.userId, SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID);
      assert.match(entry.userId, UUID);
      assert.match(entry.conversationId, UUID);
      assert.equal(entry.conversationId.includes('synthetic-'), false);
    }
  });

  it('prepares the exact authored operation types and production target keys', async () => {
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset: loadDataset(),
    });
    assert.deepEqual(
      prepared.map((entry) => entry.expectedProposal.map((operation) => operation.type)),
      EXPECTED_OPERATIONS,
    );
    for (const entry of prepared) {
      for (const operation of entry.expectedProposal) {
        if (operation.type === 'create' || operation.type === 'ignore') {
          assert.equal(operation.targetMemoryKey, null);
        } else {
          assert.match(operation.targetMemoryKey ?? '', MEMORY_KEY);
          assert.equal(
            entry.state.items.some((item) => item.memoryKey === operation.targetMemoryKey),
            true,
          );
        }
      }
    }
  });

  it('gold-seeds each prior state independently at the selected step boundary', async () => {
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset: loadDataset(),
    });
    assert.deepEqual(prepared.map((entry) => entry.state.items.length), EXPECTED_PRIOR_ITEM_COUNTS);
    for (const entry of prepared) {
      assert.doesNotThrow(() => validateMemoryV3LifecycleState(entry.state, entry.userId));
      assert.equal(entry.state.userId, SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID);
      assert.equal(entry.state.items.every((item) => MEMORY_KEY.test(item.memoryKey)), true);
    }
    const assistantOnly = prepared.find((entry) => entry.stepId === 'assistant-speculation-denied-s01');
    const layered = prepared.find((entry) => entry.stepId === 'layered-coexistence-s01');
    assert.deepEqual(assistantOnly?.state.items, []);
    assert.deepEqual(layered?.state.items, []);
  });
});

describe('synthetic lifecycle model gold replay', () => {
  it('builds a production reconcile request for every prepared case', async () => {
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset: loadDataset(),
    });
    for (const testCase of prepared) {
      const bundle = buildMemoryV3LifecycleReconcileRequest({
        userId: testCase.userId,
        conversationId: testCase.conversationId,
        messages: testCase.messages,
        state: testCase.state,
        extraction: testCase.extraction,
      });
      assert.equal(bundle.request.input.session.conversationId, testCase.conversationId);
      assert.equal(bundle.request.input.messages.length, testCase.messages.length);
    }
  });

  it('replaying each selected authored proposal produces its complete expected state', async () => {
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset: loadDataset(),
    });
    for (const entry of prepared) {
      const applied = await applyMemoryV3LifecycleStep({
        state: entry.state,
        at: entry.at,
        conversationId: entry.conversationId,
        extraction: entry.extraction,
        proposal: entry.expectedProposal,
        trustedForgetMemoryKeys: [],
      });
      const assignment = assignLifecycleItems({
        expectedItems: entry.expectedState.items,
        actualItems: stripTopicForEvaluator(applied.state.items),
      });
      assert.equal(
        assignment.pairs.length,
        entry.expectedState.items.length,
        `${entry.stepId} expected items`,
      );
      assert.equal(
        applied.state.items.length,
        entry.expectedState.items.length,
        `${entry.stepId} actual items`,
      );
      assert.deepEqual(applied.transitions, entry.expectedReducerTransitions);
    }
  });

  it('projects every expected evidence conversation to a synthetic UUID', async () => {
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset: loadDataset(),
    });
    for (const entry of prepared) {
      for (const item of entry.expectedState.items) {
        for (const row of item.evidence) {
          assert.match(row.conversationId, UUID);
          assert.equal(row.conversationId.includes('synthetic-'), false);
        }
      }
    }
  });

  it('returns detached deeply frozen cases without mutating the fixture', async () => {
    const dataset = loadDataset();
    const before = canonicalStringify(dataset);
    const prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      dataset,
    });
    assert.equal(canonicalStringify(dataset), before);
    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(Object.isFrozen(prepared[0]), true);
    assert.equal(Object.isFrozen(prepared[0].messages), true);
    assert.equal(Object.isFrozen(prepared[0].state), true);
    assert.notEqual(prepared[0].messages, dataset.scenarios[0].steps[1].messages);
    assert.notEqual(prepared[0].extraction, dataset.scenarios[0].steps[1].validatedExtraction);
    assert.notEqual(prepared[0].state, prepared[1].state);
    assert.throws(() => {
      prepared[0].messages.push({} as never);
    }, TypeError);
    assert.equal(canonicalStringify(dataset), before);
  });
});

describe('synthetic lifecycle model dataset fail-fast boundary', () => {
  it('rejects wrong identity and contract-valid manifest drift', async () => {
    const wrongIdentity = loadDataset();
    wrongIdentity.datasetId = 'memory-v3-synthetic-lifecycle-v2';
    await captureDatasetError(wrongIdentity);

    const drifted = loadDataset();
    drifted.scenarios
      .find((scenario) => scenario.scenarioId === 'event-date-correction')!
      .steps[0].expectedState.items[0].eventTimeStart = '2026-01-02';
    assert.notEqual(manifestFingerprint(drifted), DATASET_MANIFEST_SHA256);
    await captureDatasetError(drifted);
  });

  it('rejects a missing or duplicate selected step', async () => {
    const missing = loadDataset();
    const scenario = missing.scenarios.find(
      (entry) => entry.scenarioId === 'layered-coexistence',
    );
    scenario.steps = scenario.steps.filter(
      (step) => step.stepId !== 'layered-coexistence-s01',
    );
    await captureDatasetError(missing);

    const duplicate = loadDataset();
    const source = duplicate.scenarios[0].steps[1];
    duplicate.scenarios[1].steps[1] = clone(source);
    await captureDatasetError(duplicate);
  });

  it('rejects accessors without executing them or leaking their sentinel', async () => {
    const dataset = loadDataset();
    let getterCalls = 0;
    Object.defineProperty(dataset, 'privacy', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_DATASET_GETTER_SENTINEL');
      },
    });
    const error = await captureDatasetError(dataset);
    assert.equal(getterCalls, 0);
    assert.equal(error.message.includes('RAW_DATASET_GETTER_SENTINEL'), false);
    assert.equal(JSON.stringify(error).includes('RAW_DATASET_GETTER_SENTINEL'), false);
  });

  it('rejects cycles, symbols, sparse arrays, and revoked proxies safely', async () => {
    const cyclic = loadDataset();
    cyclic.self = cyclic;
    await captureDatasetError(cyclic);

    const symbolic = loadDataset();
    symbolic[Symbol('RAW_SYMBOL_SENTINEL')] = true;
    await captureDatasetError(symbolic);

    const sparse = loadDataset();
    delete sparse.scenarios[1];
    await captureDatasetError(sparse);

    const revocable = Proxy.revocable(loadDataset(), {});
    revocable.revoke();
    const error = await captureDatasetError(revocable.proxy);
    assert.equal(error.name, 'MemoryV3LifecycleModelBenchmarkDatasetError');
  });

  it('does not mutate rejected inputs', async () => {
    const dataset = loadDataset();
    dataset.version = '9.9.9';
    const before = JSON.stringify(dataset);
    await captureDatasetError(dataset);
    assert.equal(JSON.stringify(dataset), before);
  });
});

describe('synthetic lifecycle model dataset source isolation', () => {
  it('imports only offline preparation dependencies', () => {
    const source = readFileSync(MODULE_URL, 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.deepEqual(imports.sort(), [
      '../../supabase/functions/_shared/memoryV3/contract.ts',
      '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts',
      '../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts',
      '../../supabase/functions/_shared/memoryV3/messages.ts',
      './contracts.mjs',
      './lifecycle-evaluator.mjs',
      './lifecycle-model-benchmark-profile.ts',
      'node:crypto',
    ].sort());
    for (const forbidden of [
      'supabaseClient', 'lifecycleStore', 'process.env', 'Deno.env',
      'globalThis.fetch', 'node:fs', 'OpenRouter', '_tmp-',
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
