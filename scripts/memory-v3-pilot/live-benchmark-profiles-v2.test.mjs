/**
 * Memory V3 V2 frozen profile registry tests.
 * Direct lookup only. No network, .env, fetch, fs, or paid provider calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-profiles-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';

const PROFILE_OWN_KEYS = Object.freeze([
  'profileId',
  'caseIds',
  'model',
  'extractorVersion',
  'datasetId',
  'datasetVersion',
  'reasoningEffort',
  'maxOutputTokensPerCase',
  'maxInputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'maxBudgetUsd',
  'maxRequests',
  'caseCount',
  'timeoutMs',
  'maxResponseBytes',
  'maxPromptRequestBytesPerCase',
  'maxTokensParameter',
  'allowFallbacks',
  'responseContract',
  'executeFlag',
  'maxBudgetUsdArg',
  'engineErrorPrefix',
  'engineErrorName',
  'cliErrorPrefix',
  'cliErrorName',
  'runErrorPrefix',
  'runErrorName',
  'httpCapError',
]);

const SIX_BUDGET = Object.freeze({
  caseCount: 6,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxRequests: 6,
  maxBudgetUsd: 0.11,
});

const HYPOTHESIS_BUDGET = Object.freeze({
  caseCount: 4,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxRequests: 4,
  maxBudgetUsd: 0.075,
});

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

function assertExactOwnKeys(profile) {
  assert.deepEqual(Object.getOwnPropertyNames(profile).sort(), [...PROFILE_OWN_KEYS].sort());
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'budget'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'errorPrefix'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'errorName'), false);
}

function assertEnumerableStringDataDescriptors(profile) {
  for (const key of PROFILE_OWN_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(profile, key);
    assert.equal(typeof key, 'string');
    assert.equal(descriptor !== undefined, true, `missing own key ${key}`);
    assert.equal(descriptor.enumerable, true, `${key} must be enumerable`);
    assert.equal('value' in descriptor, true, `${key} must be a data descriptor`);
    assert.equal('get' in descriptor, false);
    assert.equal('set' in descriptor, false);
  }
}

function assertBudgetFields(profile, budget) {
  assert.equal(profile.caseCount, budget.caseCount);
  assert.equal(profile.maxInputTokensPerCase, budget.maxInputTokensPerCase);
  assert.equal(profile.maxOutputTokensPerCase, budget.maxOutputTokensPerCase);
  assert.equal(profile.inputUsdPerMillion, budget.inputUsdPerMillion);
  assert.equal(profile.outputUsdPerMillion, budget.outputUsdPerMillion);
  assert.equal(profile.maxRequests, budget.maxRequests);
  assert.equal(profile.maxBudgetUsd, budget.maxBudgetUsd);
}

describe('getLiveBenchmarkProfileV2 six-category-v2', () => {
  it('returns the same registry-owned constant on repeated lookup', () => {
    const first = getLiveBenchmarkProfileV2('six-category-v2');
    const second = getLiveBenchmarkProfileV2('six-category-v2');
    assert.equal(Object.is(first, second), true);
  });

  it('exposes exactly 29 own keys and forbids nested budget or generic error fields', () => {
    const profile = getLiveBenchmarkProfileV2('six-category-v2');
    assertExactOwnKeys(profile);
    assert.equal(PROFILE_OWN_KEYS.length, 29);
  });

  it('stores own fields as enumerable string data descriptors', () => {
    const profile = getLiveBenchmarkProfileV2('six-category-v2');
    assertEnumerableStringDataDescriptors(profile);
  });

  it('locks six-category-v2 identity, case order, extractor, and branding', () => {
    const profile = getLiveBenchmarkProfileV2('six-category-v2');
    assert.equal(profile.profileId, 'six-category-v2');
    assert.deepEqual([...profile.caseIds], [...SIX_CASE_IDS]);
    assert.equal(profile.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-six-v2');
    assert.equal(profile.executeFlag, '--execute-six-paid-requests');
    assert.equal(profile.engineErrorPrefix, '[memory-v3:live-benchmark-six-v2]');
    assert.equal(profile.engineErrorName, 'MemoryV3SixCaseBenchmarkV2Error');
    assert.equal(profile.cliErrorPrefix, '[memory-v3:live-benchmark-six-cli-v2]');
    assert.equal(profile.cliErrorName, 'MemoryV3SixCaseBenchmarkCliV2Error');
    assert.equal(profile.runErrorPrefix, '[memory-v3:live-benchmark-six-run-v2]');
    assert.equal(profile.runErrorName, 'MemoryV3SixCaseBenchmarkRunV2Error');
    assert.equal(profile.httpCapError, 'seventh fetch is not allowed');
  });

  it('locks six-category-v2 dataset, model, adapter, and transport values', () => {
    const profile = getLiveBenchmarkProfileV2('six-category-v2');
    assert.equal(profile.datasetId, 'memory-v3-ru-golden-v2');
    assert.equal(profile.datasetVersion, '2.0.0');
    assert.equal(profile.model, 'google/gemini-3.7-flash');
    assert.equal(profile.reasoningEffort, 'low');
    assert.equal(profile.maxTokensParameter, 'max_tokens');
    assert.equal(profile.allowFallbacks, true);
    assert.equal(profile.responseContract, 'v2');
    assert.equal(profile.timeoutMs, 60000);
    assert.equal(profile.maxResponseBytes, 1000000);
    assert.equal(profile.maxPromptRequestBytesPerCase, 20000);
    assert.equal(profile.maxBudgetUsdArg, '0.11');
  });

  it('locks six-category-v2 budget math inputs to N=6 and $0.11', () => {
    const profile = getLiveBenchmarkProfileV2('six-category-v2');
    assertBudgetFields(profile, SIX_BUDGET);
    assert.equal(profile.caseCount, 6);
    assert.equal(profile.maxRequests, 6);
    assert.equal(profile.caseCount, profile.caseIds.length);
    assert.equal(profile.maxRequests, profile.caseIds.length);
  });

  it('deep-freezes the six-category-v2 profile and caseIds against mutation', () => {
    const profile = getLiveBenchmarkProfileV2('six-category-v2');
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.caseIds), true);
    assert.throws(() => {
      profile.model = 'other-model';
    }, TypeError);
    assert.throws(() => {
      profile.caseIds.push('memv3-ru-event-01');
    }, TypeError);
    assert.throws(() => {
      profile.caseIds[0] = 'memv3-ru-event-01';
    }, TypeError);
  });
});

describe('getLiveBenchmarkProfileV2 hypothesis-four-v2', () => {
  it('returns the same registry-owned constant on repeated lookup', () => {
    const first = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    const second = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assert.equal(Object.is(first, second), true);
  });

  it('exposes exactly 29 own keys and forbids nested budget or generic error fields', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assertExactOwnKeys(profile);
  });

  it('stores own fields as enumerable string data descriptors', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assertEnumerableStringDataDescriptors(profile);
  });

  it('locks hypothesis-four-v2 identity, case order, extractor, and branding', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assert.equal(profile.profileId, 'hypothesis-four-v2');
    assert.deepEqual([...profile.caseIds], [...HYPOTHESIS_CASE_IDS]);
    assert.equal(
      profile.extractorVersion,
      'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
    );
    assert.equal(profile.executeFlag, '--execute-hypothesis-four-paid-requests');
    assert.equal(profile.engineErrorPrefix, '[memory-v3:live-benchmark-hypothesis-four-v2]');
    assert.equal(profile.engineErrorName, 'MemoryV3HypothesisFourBenchmarkV2Error');
    assert.equal(profile.cliErrorPrefix, '[memory-v3:live-benchmark-hypothesis-four-cli-v2]');
    assert.equal(profile.cliErrorName, 'MemoryV3HypothesisFourBenchmarkCliV2Error');
    assert.equal(profile.runErrorPrefix, '[memory-v3:live-benchmark-hypothesis-four-run-v2]');
    assert.equal(profile.runErrorName, 'MemoryV3HypothesisFourBenchmarkRunV2Error');
    assert.equal(profile.httpCapError, 'fifth fetch is not allowed');
  });

  it('locks hypothesis-four-v2 dataset, model, adapter, and transport values', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assert.equal(profile.datasetId, 'memory-v3-ru-golden-v2');
    assert.equal(profile.datasetVersion, '2.0.0');
    assert.equal(profile.model, 'google/gemini-3.7-flash');
    assert.equal(profile.reasoningEffort, 'low');
    assert.equal(profile.maxTokensParameter, 'max_tokens');
    assert.equal(profile.allowFallbacks, true);
    assert.equal(profile.responseContract, 'v2');
    assert.equal(profile.timeoutMs, 60000);
    assert.equal(profile.maxResponseBytes, 1000000);
    assert.equal(profile.maxPromptRequestBytesPerCase, 20000);
    assert.equal(profile.maxBudgetUsdArg, '0.075');
  });

  it('locks hypothesis-four-v2 budget math inputs to N=4 and $0.075', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assertBudgetFields(profile, HYPOTHESIS_BUDGET);
    assert.equal(profile.caseCount, 4);
    assert.equal(profile.maxRequests, 4);
    assert.equal(profile.caseCount, profile.caseIds.length);
    assert.equal(profile.maxRequests, profile.caseIds.length);
    assert.equal(profile.maxInputTokensPerCase * 4, 65536);
    assert.equal(profile.maxOutputTokensPerCase * 4, 4800);
  });

  it('deep-freezes the hypothesis-four-v2 profile and caseIds against mutation', () => {
    const profile = getLiveBenchmarkProfileV2('hypothesis-four-v2');
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.caseIds), true);
    assert.throws(() => {
      profile.maxRequests = 24;
    }, TypeError);
    assert.throws(() => {
      profile.caseIds.push('memv3-ru-event-01');
    }, TypeError);
    assert.throws(() => {
      profile.caseIds[0] = 'memv3-ru-event-01';
    }, TypeError);
  });
});

describe('getLiveBenchmarkProfileV2 argument contract', () => {
  it('rejects a plain object without reading properties', () => {
    const value = {};
    const before = JSON.stringify(value);
    assert.throws(() => getLiveBenchmarkProfileV2(value));
    assert.equal(JSON.stringify(value), before);
  });

  it('rejects an options bag with profileId instead of a primitive string', () => {
    const value = { profileId: 'six-category-v2' };
    const before = JSON.stringify(value);
    assert.throws(() => getLiveBenchmarkProfileV2(value));
    assert.equal(JSON.stringify(value), before);
    assert.equal(value.profileId, 'six-category-v2');
  });

  it('rejects a String object wrapping an allowlisted id', () => {
    assert.throws(() => getLiveBenchmarkProfileV2(new String('six-category-v2')));
  });

  it('rejects a getter container without executing the getter', () => {
    let getterCalls = 0;
    const getterContainer = {
      get profileId() {
        getterCalls += 1;
        return 'six-category-v2';
      },
    };
    assert.throws(() => getLiveBenchmarkProfileV2(getterContainer));
    assert.equal(getterCalls, 0);
  });

  it('rejects an array that contains an allowlisted id', () => {
    const value = ['six-category-v2'];
    const before = value.slice();
    assert.throws(() => getLiveBenchmarkProfileV2(value));
    assert.deepEqual(value, before);
  });

  it('rejects null', () => {
    assert.throws(() => getLiveBenchmarkProfileV2(null));
  });

  it('rejects a symbol', () => {
    assert.throws(() => getLiveBenchmarkProfileV2(Symbol('six-category-v2')));
  });

  it('rejects an unknown profile id including full-24-v2', () => {
    assert.throws(() => getLiveBenchmarkProfileV2('full-24-v2'));
  });

  it('rejects an empty string', () => {
    assert.throws(() => getLiveBenchmarkProfileV2(''));
  });

  it('rejects an allowlisted id with surrounding whitespace', () => {
    assert.throws(() => getLiveBenchmarkProfileV2('six-category-v2 '));
    assert.throws(() => getLiveBenchmarkProfileV2(' six-category-v2'));
    assert.throws(() => getLiveBenchmarkProfileV2('six-category-v2\n'));
  });
});
