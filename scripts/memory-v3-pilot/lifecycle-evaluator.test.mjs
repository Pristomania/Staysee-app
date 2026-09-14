import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertLifecycleHardGates,
  assignLifecycleItems,
  evaluateLifecycleScenario,
  evaluateLifecycleStep,
} from './lifecycle-evaluator.mjs';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

function evidence(overrides = {}) {
  return {
    conversationId: 'synthetic-conversation-01',
    sourceMessageId: 'm1',
    relation: 'supports',
    supportType: null,
    episodeKey: 'episode:m1',
    provenanceRole: 'user',
    mentionTime: '2026-01-10T10:00:00Z',
    ...overrides,
  };
}

function actualItem(memoryKey, overrides = {}) {
  return {
    memoryKey,
    kind: 'event',
    claim: 'Синтетический факт',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: '2026-01-01',
    eventTimeEnd: '2026-01-31',
    alternative: null,
    firstSeenAt: '2026-01-10T10:00:00Z',
    updatedAt: '2026-01-10T10:00:00Z',
    revision: 1,
    evidence: [evidence()],
    ...overrides,
  };
}

function expectedItem(goldMemoryId, overrides = {}) {
  const actual = actualItem(KEY_A, overrides);
  delete actual.memoryKey;
  return { goldMemoryId, tier: 'required', ...actual };
}

function actualState(items) {
  return { scenarioId: 'scenario-01', nextMemoryOrdinal: items.length + 1, items };
}

function expectedState(items) {
  return { items };
}

function transitionContext(overrides = {}) {
  return {
    expected: [],
    actual: [],
    replayEqual: true,
    noOpExpected: false,
    deletedMemoryKeys: [],
    resurrectedMemoryKeys: [],
    forbiddenMemoryKeys: [],
    assistantOnlyMemoryKeys: [],
    forgottenPairs: [],
    ...overrides,
  };
}

describe('assignLifecycleItems', () => {
  it('uses required-first matching before acceptable matches', () => {
    const required = expectedItem('required-event', { evidence: [evidence({ sourceMessageId: 'm1' })] });
    const acceptable = expectedItem('acceptable-event', {
      tier: 'acceptable',
      evidence: [evidence({ sourceMessageId: 'm2' })],
    });
    const one = actualItem(KEY_A, { evidence: [evidence({ sourceMessageId: 'm2' })] });

    const result = assignLifecycleItems({ expectedItems: [acceptable, required], actualItems: [one] });

    assert.deepEqual(result.pairs, [{ goldMemoryId: 'required-event', memoryKey: KEY_A }]);
  });

  it('maximizes total matches and then exact structural evidence overlap', () => {
    const goldA = expectedItem('gold-a', { evidence: [evidence({ sourceMessageId: 'm1' })] });
    const goldB = expectedItem('gold-b', { evidence: [evidence({ sourceMessageId: 'm2' })] });
    const actualA = actualItem(KEY_A, { evidence: [evidence({ sourceMessageId: 'm2' })] });
    const actualB = actualItem(KEY_B, { evidence: [evidence({ sourceMessageId: 'm1' })] });

    const result = assignLifecycleItems({ expectedItems: [goldA, goldB], actualItems: [actualA, actualB] });

    assert.deepEqual(result.pairs, [
      { goldMemoryId: 'gold-a', memoryKey: KEY_B },
      { goldMemoryId: 'gold-b', memoryKey: KEY_A },
    ]);
  });

  it('uses the UTF-16 pair tuple tie-break without localeCompare', () => {
    const original = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare');
    let calls = 0;
    Object.defineProperty(String.prototype, 'localeCompare', {
      configurable: true,
      value() {
        calls += 1;
        throw new Error('locale ordering is forbidden');
      },
    });
    try {
      const result = assignLifecycleItems({
        expectedItems: [expectedItem('Z-gold'), expectedItem('a-gold')],
        actualItems: [actualItem(KEY_B), actualItem(KEY_A)],
      });
      assert.deepEqual(result.pairs, [
        { goldMemoryId: 'Z-gold', memoryKey: KEY_A },
        { goldMemoryId: 'a-gold', memoryKey: KEY_B },
      ]);
      assert.equal(calls, 0);
    } finally {
      Object.defineProperty(String.prototype, 'localeCompare', original);
    }
  });
});

describe('evaluateLifecycleStep exact counters', () => {
  it('counts required and acceptable matches before rendering ratios', () => {
    const expected = [
      expectedItem('required-event'),
      expectedItem('acceptable-event', { tier: 'acceptable', claim: 'Допустимый факт' }),
    ];
    const actual = [
      actualItem(KEY_A),
      actualItem(KEY_B, { claim: 'Допустимый факт' }),
      actualItem(KEY_C, { claim: 'Лишний факт', evidence: [evidence({ sourceMessageId: 'm3' })] }),
    ];
    const report = evaluateLifecycleStep({
      expectedState: expectedState(expected),
      actualState: actualState(actual),
      transitions: transitionContext(),
    });

    assert.deepEqual(report.counts, {
      requiredGoldCount: 1,
      acceptableGoldCount: 1,
      requiredMatchedCount: 1,
      acceptableMatchedCount: 1,
      validMatchedCount: 2,
      allActualCount: 3,
      extraFalsePositives: 1,
      evidenceTp: 2,
      evidenceFp: 1,
      evidenceFn: 0,
      kindStatusEligible: 2,
      kindStatusExact: 2,
      transitionExpectedByType: {},
      transitionExactByType: {},
      correctionReplacementEligible: 0,
      correctionReplacementExact: 0,
      duplicateActiveCount: 0,
      supersededActiveCount: 0,
      noOpChurnCount: 0,
      deletedRemnantCount: 0,
      deletedResurrectionCount: 0,
      forbiddenMemoryViolationCount: 0,
      assistantOnlyMemoryCount: 0,
      recurrencePartitionEligible: 0,
      recurrencePartitionExact: 0,
      exactStateStepCount: 1,
      exactStateMatchedCount: 0,
    });
    assert.deepEqual(report.items.overall, { precision: 2 / 3, recall: 1, f1: 0.8 });
    assert.deepEqual(report.items.required, { precision: 0.5, recall: 1, f1: 2 / 3 });
  });

  it('does not count an omitted acceptable item as a false negative', () => {
    const report = evaluateLifecycleStep({
      expectedState: expectedState([
        expectedItem('required-event'),
        expectedItem('acceptable-event', { tier: 'acceptable' }),
      ]),
      actualState: actualState([actualItem(KEY_A)]),
      transitions: transitionContext(),
    });
    assert.equal(report.counts.requiredMatchedCount, 1);
    assert.equal(report.counts.acceptableMatchedCount, 0);
    assert.equal(report.items.overall.recall, 1);
    assert.equal(report.evidence.fn, 0);
  });

  it('counts transition types exactly and detects a wrong operation', () => {
    const report = evaluateLifecycleStep({
      expectedState: expectedState([expectedItem('required-event')]),
      actualState: actualState([actualItem(KEY_A)]),
      transitions: transitionContext({
        expected: [
          { type: 'create', candidateLocalItemKey: 'candidate-1', targetGoldMemoryId: null },
          { type: 'ignore', candidateLocalItemKey: 'candidate-2', targetGoldMemoryId: null },
        ],
        actual: [
          { type: 'create', candidateLocalItemKey: 'candidate-1', targetMemoryKey: null, resultingMemoryKey: KEY_A },
          { type: 'confirm', candidateLocalItemKey: 'candidate-2', targetMemoryKey: KEY_A, resultingMemoryKey: KEY_A },
        ],
      }),
    });
    assert.deepEqual(report.counts.transitionExpectedByType, { create: 1, ignore: 1 });
    assert.deepEqual(report.counts.transitionExactByType, { create: 1 });
  });

  it('does not count a transition with the wrong resulting memory key as exact', () => {
    const report = evaluateLifecycleStep({
      expectedState: expectedState([expectedItem('required-event')]),
      actualState: actualState([actualItem(KEY_A)]),
      transitions: transitionContext({
        expected: [{ type: 'create', candidateLocalItemKey: 'candidate-1', targetGoldMemoryId: null }],
        actual: [{ type: 'create', candidateLocalItemKey: 'candidate-1', targetMemoryKey: null, resultingMemoryKey: KEY_B }],
      }),
    });
    assert.equal(report.counts.transitionExpectedByType.create, 1);
    assert.equal(report.counts.transitionExactByType.create ?? 0, 0);
  });

  it('rejects semantically invalid expected lifecycle state', () => {
    const invalid = expectedItem('required-event', { status: 'supported' });
    assert.throws(() => evaluateLifecycleStep({
      expectedState: expectedState([invalid]),
      actualState: actualState([actualItem(KEY_A)]),
      transitions: transitionContext(),
    }), /\[memory-v3:lifecycle-evaluator\]/);
  });

  it('measures recurrence episode partitions by equivalence, not literal labels', () => {
    const expected = expectedItem('recurrence', {
      kind: 'recurrence',
      status: 'active',
      evidence: [
        evidence({ conversationId: 'c1', sourceMessageId: 'm1', supportType: 'episode_observation', episodeKey: 'gold-a' }),
        evidence({ conversationId: 'c2', sourceMessageId: 'm2', supportType: 'episode_observation', episodeKey: 'gold-b' }),
      ],
    });
    const actual = actualItem(KEY_A, {
      kind: 'recurrence',
      status: 'active',
      evidence: [
        evidence({ conversationId: 'c1', sourceMessageId: 'm1', supportType: 'episode_observation', episodeKey: 'actual-x' }),
        evidence({ conversationId: 'c2', sourceMessageId: 'm2', supportType: 'episode_observation', episodeKey: 'actual-y' }),
      ],
    });
    const report = evaluateLifecycleStep({
      expectedState: expectedState([expected]),
      actualState: actualState([actual]),
      transitions: transitionContext(),
    });
    assert.equal(report.counts.recurrencePartitionEligible, 1);
    assert.equal(report.counts.recurrencePartitionExact, 1);
  });

  it('scores create, confirm, revise, mark_stale, reject, ignore, and forget independently', () => {
    const types = ['create', 'confirm', 'revise', 'mark_stale', 'reject', 'ignore', 'forget'];
    for (const type of types) {
      const targeted = !['create', 'ignore'].includes(type);
      const candidateLocalItemKey = type === 'forget' ? null : `candidate-${type}`;
      const expected = {
        type,
        candidateLocalItemKey,
        targetGoldMemoryId: targeted ? 'required-event' : null,
      };
      const actual = {
        type,
        candidateLocalItemKey,
        targetMemoryKey: targeted ? KEY_A : null,
        resultingMemoryKey: type === 'ignore' || type === 'forget' ? null : KEY_A,
      };
      const report = evaluateLifecycleStep({
        expectedState: expectedState([expectedItem('required-event')]),
        actualState: actualState([actualItem(KEY_A)]),
        transitions: transitionContext({
          expected: [expected],
          actual: [actual],
          forgottenPairs: type === 'forget'
            ? [{ goldMemoryId: 'required-event', memoryKey: KEY_A }]
            : [],
        }),
      });
      assert.equal(report.counts.transitionExpectedByType[type], 1, type);
      assert.equal(report.counts.transitionExactByType[type], 1, type);
    }
  });

  it('does not count a revise as an exact correction when replacement material is wrong', () => {
    const report = evaluateLifecycleStep({
      expectedState: expectedState([expectedItem('required-event')]),
      actualState: actualState([actualItem(KEY_A, { claim: 'Неверная замена' })]),
      transitions: transitionContext({
        expected: [{ type: 'revise', candidateLocalItemKey: 'candidate-revise', targetGoldMemoryId: 'required-event' }],
        actual: [{ type: 'revise', candidateLocalItemKey: 'candidate-revise', targetMemoryKey: KEY_A, resultingMemoryKey: KEY_A }],
      }),
    });
    assert.equal(report.counts.correctionReplacementEligible, 1);
    assert.equal(report.counts.correctionReplacementExact, 0);
  });

  it('counts a hidden revision bump as no-op churn', () => {
    const report = evaluateLifecycleStep({
      expectedState: expectedState([expectedItem('required-event')]),
      actualState: actualState([actualItem(KEY_A, { revision: 2 })]),
      transitions: transitionContext({
        expected: [{ type: 'ignore', candidateLocalItemKey: 'candidate-ignore', targetGoldMemoryId: null }],
        actual: [{ type: 'ignore', candidateLocalItemKey: 'candidate-ignore', targetMemoryKey: null, resultingMemoryKey: null }],
        noOpExpected: true,
      }),
    });
    assert.equal(report.counts.noOpChurnCount, 1);
  });
});

describe('lifecycle hard gates and scenario aggregation', () => {
  function perfectStep() {
    return evaluateLifecycleStep({
      expectedState: expectedState([expectedItem('required-event')]),
      actualState: actualState([actualItem(KEY_A)]),
      transitions: transitionContext(),
    });
  }

  it('aggregates integer counters before ratios', () => {
    const one = perfectStep();
    const two = evaluateLifecycleStep({
      expectedState: expectedState([expectedItem('required-event')]),
      actualState: actualState([]),
      transitions: transitionContext(),
    });
    const report = evaluateLifecycleScenario({
      scenario: { scenarioId: 'scenario-01' },
      stepResults: [one, two],
    });
    assert.equal(report.counts.requiredGoldCount, 2);
    assert.equal(report.counts.requiredMatchedCount, 1);
    assert.equal(report.items.overall.recall, 0.5);
  });

  it('passes a fully exact report and freezes non-semantic review fields', () => {
    const report = evaluateLifecycleScenario({
      scenario: { scenarioId: 'scenario-01' },
      stepResults: [perfectStep()],
    });
    assert.deepEqual(assertLifecycleHardGates(report), { status: 'PASS' });
    assert.deepEqual(report.semanticClaims, { status: 'not_evaluated' });
    assert.deepEqual(report.forbiddenClaims, { status: 'not_evaluated' });
    assert.equal(Object.isFrozen(report), true);
  });

  for (const counter of [
    'duplicateActiveCount',
    'supersededActiveCount',
    'noOpChurnCount',
    'deletedRemnantCount',
    'deletedResurrectionCount',
    'forbiddenMemoryViolationCount',
    'assistantOnlyMemoryCount',
  ]) {
    it(`fails the absolute gate when ${counter} is one even with perfect F1`, () => {
      const base = evaluateLifecycleScenario({
        scenario: { scenarioId: 'scenario-01' },
        stepResults: [perfectStep()],
      });
      const report = structuredClone(base);
      report.counts[counter] = 1;
      assert.throws(() => assertLifecycleHardGates(report), /\[memory-v3:lifecycle-evaluator\]/);
    });
  }

  it('fails hard gates for a wrong transition, recurrence partition, correction, replay, or exact state', () => {
    const base = evaluateLifecycleScenario({
      scenario: { scenarioId: 'scenario-01' },
      stepResults: [perfectStep()],
    });
    const mutations = [
      (report) => { report.counts.transitionExpectedByType.create = 1; },
      (report) => { report.counts.recurrencePartitionEligible = 1; },
      (report) => { report.counts.correctionReplacementEligible = 1; },
      (report) => { report.replayEqual = false; },
      (report) => { report.counts.exactStateMatchedCount = 0; },
    ];
    for (const mutate of mutations) {
      const report = structuredClone(base);
      mutate(report);
      assert.throws(() => assertLifecycleHardGates(report), /\[memory-v3:lifecycle-evaluator\]/);
    }
  });

  it('returns a sanitized report without aliases, dialogue, prompts, or provider fields', () => {
    const expected = expectedState([expectedItem('required-event')]);
    const actual = actualState([actualItem(KEY_A)]);
    const report = evaluateLifecycleStep({
      expectedState: expected,
      actualState: actual,
      transitions: transitionContext(),
    });
    expected.items[0].claim = 'RAW_DIALOGUE_SECRET';
    actual.items[0].claim = 'RAW_PROVIDER_SECRET';
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /RAW_DIALOGUE_SECRET|RAW_PROVIDER_SECRET|prompt|provider|Authorization|apiKey/);
    assert.deepEqual(Object.keys(report).sort(), [
      'counts', 'evidence', 'forbiddenClaims', 'items', 'matches', 'replayEqual',
      'semanticClaims', 'transitionAccuracy',
    ]);
  });
});
