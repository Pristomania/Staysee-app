import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
  MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
  MEMORY_V3_LIFECYCLE_MODEL,
  MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
  MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import { calculateBudgetCeiling } from './benchmark-budget.mjs';
import {
  LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
  getLifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';

const EXPECTED_STEP_IDS = [
  'paraphrase-event-dedup-s02',
  'same-topic-distinct-events-s02',
  'event-date-correction-s03',
  'scope-narrowing-s03',
  'hypothesis-supported-s03',
  'hypothesis-rejected-s03',
  'recurrence-growth-s02',
  'pattern-confirmation-s03',
  'recurrence-stale-s03',
  'assistant-speculation-denied-s01',
  'prompt-injection-schema-s02',
  'layered-coexistence-s01',
] as const;

const EXPECTED_KEYS = [
  'profileId',
  'datasetId',
  'datasetVersion',
  'model',
  'reconcilerVersion',
  'stepIds',
  'caseCount',
  'maxRequests',
  'maxPromptRequestBytesPerCase',
  'maxInputTokensPerCase',
  'maxOutputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'configuredCeilingUsd',
  'maxBudgetUsd',
  'executeFlag',
] as const;

function captureProfileError(value: unknown): Error {
  let thrown: unknown;
  try {
    getLifecycleModelBenchmarkProfile(value);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, 'MemoryV3LifecycleModelBenchmarkProfileError');
  assert.equal(thrown.message, '[memory-v3:lifecycle-model-profile] invalid profile id');
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  return thrown;
}

describe('lifecycle model benchmark frozen profile', () => {
  it('returns one registry-owned object for the exact primitive profile id', () => {
    assert.equal(
      LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
      'lifecycle-reconciler-critical-twelve-v1',
    );
    const first = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    const second = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    assert.equal(first, second);
  });

  it('exposes exactly the closed sixteen-field profile schema', () => {
    const profile = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    assert.deepEqual(Object.keys(profile), EXPECTED_KEYS);
    assert.deepEqual(Reflect.ownKeys(profile), EXPECTED_KEYS);
    for (const key of EXPECTED_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(profile, key);
      assert.ok(descriptor);
      assert.equal(descriptor.enumerable, true);
      assert.equal('value' in descriptor, true);
      assert.equal(descriptor.get, undefined);
      assert.equal(descriptor.set, undefined);
    }
    assert.equal(Object.hasOwn(profile, 'budget'), false);
    assert.equal(Object.hasOwn(profile, 'apiKey'), false);
    assert.equal(Object.hasOwn(profile, 'errorPrefix'), false);
  });

  it('locks the exact twelve selected lifecycle steps in canonical order', () => {
    const profile = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    assert.deepEqual(profile.stepIds, EXPECTED_STEP_IDS);
    assert.equal(profile.caseCount, 12);
    assert.equal(profile.maxRequests, 12);
    assert.equal(profile.caseCount, profile.stepIds.length);
    assert.equal(new Set(profile.stepIds).size, 12);
  });

  it('locks dataset, model, reconciler, byte cap, and execute boundary', () => {
    const profile = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    assert.equal(profile.datasetId, 'memory-v3-synthetic-lifecycle-v1');
    assert.equal(profile.datasetVersion, '1.0.0');
    assert.equal(profile.model, 'google/gemini-3.7-flash');
    assert.equal(profile.reconcilerVersion, 'memory-v3-lifecycle-reconciler-v1');
    assert.equal(profile.maxPromptRequestBytesPerCase, 80_000);
    assert.equal(profile.executeFlag, '--execute-twelve-paid-requests');
  });

  it('stays aligned with the production lifecycle constants', () => {
    const profile = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    assert.equal(profile.model, MEMORY_V3_LIFECYCLE_MODEL);
    assert.equal(profile.reconcilerVersion, MEMORY_V3_LIFECYCLE_RECONCILER_VERSION);
    assert.equal(
      profile.maxPromptRequestBytesPerCase,
      MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
    );
    assert.equal(
      profile.maxInputTokensPerCase,
      MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
    );
    assert.equal(
      profile.maxOutputTokensPerCase,
      MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
    );
  });

  it('produces the hand-checked $0.348912 ceiling under the $0.36 gate', () => {
    const profile = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    const report = calculateBudgetCeiling({
      caseCount: profile.caseCount,
      maxInputTokensPerCase: profile.maxInputTokensPerCase,
      maxOutputTokensPerCase: profile.maxOutputTokensPerCase,
      inputUsdPerMillion: profile.inputUsdPerMillion,
      outputUsdPerMillion: profile.outputUsdPerMillion,
      maxRequests: profile.maxRequests,
      maxBudgetUsd: profile.maxBudgetUsd,
    });
    assert.deepEqual(report, {
      caseCount: 12,
      absoluteMaxRequests: 12,
      absoluteInputTokens: 393_216,
      absoluteOutputTokens: 14_400,
      inputCostUsd: '0.294912',
      outputCostUsd: '0.054',
      absoluteCostUsd: '0.348912',
      maxRequests: 12,
      maxBudgetUsd: 0.36,
      gate: 'PASS',
      costUnit: 'nanodollars',
      absoluteCostNanodollars: '348912000',
    });
    assert.equal(profile.configuredCeilingUsd, '0.348912');
  });

  it('deep-freezes the profile and its selected step ids', () => {
    const profile = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.stepIds), true);
    assert.throws(() => {
      (profile as { maxRequests: number }).maxRequests = 99;
    }, TypeError);
    assert.throws(() => {
      (profile.stepIds as string[])[0] = 'changed';
    }, TypeError);
    assert.throws(() => {
      (profile.stepIds as string[]).push('extra');
    }, TypeError);
    assert.equal(profile.maxRequests, 12);
    assert.equal(profile.stepIds[0], 'paraphrase-event-dedup-s02');
  });
});

describe('lifecycle model benchmark primitive lookup contract', () => {
  const invalidScalars: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace string', '   '],
    ['unknown string', 'lifecycle-reconciler-critical-eleven-v1'],
    ['null', null],
    ['undefined', undefined],
    ['number', 12],
    ['boolean', true],
    ['bigint', 12n],
    ['symbol', Symbol('profile')],
    ['function', () => 'lifecycle-reconciler-critical-twelve-v1'],
  ];

  for (const [label, value] of invalidScalars) {
    it(`rejects ${label} without reflecting attacker data`, () => {
      const error = captureProfileError(value);
      assert.equal(error.message.includes(label), false);
    });
  }

  it('rejects a String object because lookup accepts only a primitive', () => {
    const input = new String('lifecycle-reconciler-critical-twelve-v1');
    captureProfileError(input);
    assert.equal(input.valueOf(), 'lifecycle-reconciler-critical-twelve-v1');
  });

  it('rejects an array without mutating it', () => {
    const input = ['lifecycle-reconciler-critical-twelve-v1'];
    const before = JSON.stringify(input);
    captureProfileError(input);
    assert.equal(JSON.stringify(input), before);
  });

  it('rejects a plain profile-like clone without trusting its fields', () => {
    const canonical = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    const clone = { ...canonical, stepIds: [...canonical.stepIds] };
    captureProfileError(clone);
    assert.deepEqual(clone.stepIds, EXPECTED_STEP_IDS);
  });

  it('rejects a frozen profile-like clone', () => {
    const canonical = getLifecycleModelBenchmarkProfile(
      'lifecycle-reconciler-critical-twelve-v1',
    );
    const clone = Object.freeze({ ...canonical });
    captureProfileError(clone);
    assert.equal(Object.isFrozen(clone), true);
  });

  it('does not execute a getter on a profile-like container', () => {
    let getterCalls = 0;
    const input = Object.create(null);
    Object.defineProperty(input, 'profileId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_PROFILE_GETTER_SENTINEL');
      },
    });
    const error = captureProfileError(input);
    assert.equal(getterCalls, 0);
    assert.equal(error.message.includes('RAW_PROFILE_GETTER_SENTINEL'), false);
    assert.equal(JSON.stringify(error).includes('RAW_PROFILE_GETTER_SENTINEL'), false);
  });

  it('does not trigger proxy traps for a non-string argument', () => {
    let getCalls = 0;
    let ownKeysCalls = 0;
    const input = new Proxy({}, {
      get() {
        getCalls += 1;
        throw new Error('RAW_PROXY_GET_SENTINEL');
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error('RAW_PROXY_KEYS_SENTINEL');
      },
    });
    captureProfileError(input);
    assert.equal(getCalls, 0);
    assert.equal(ownKeysCalls, 0);
  });
});
