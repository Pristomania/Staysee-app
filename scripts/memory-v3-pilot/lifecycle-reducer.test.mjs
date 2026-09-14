import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyLifecycleStep,
  createEmptyLifecycleState,
  projectSafeLifecycleReducerDiagnostic,
} from './lifecycle-reducer.mjs';

const MEMORY_KEY_1 = '27d2289fd511deed2b971896c7abe359048560ae9bf1b1589190f125a3115e64';

function session(overrides = {}) {
  return {
    scenarioId: 'scenario-01',
    stepId: 'scenario-01-s01',
    at: '2026-01-10T10:00:00Z',
    conversationId: 'synthetic-scenario-01-c01',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    localItemKey: 'candidate-01',
    kind: 'event',
    claim: 'Переехала в Казань в январе 2026 года',
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: '2026-01-01',
    eventTimeEnd: '2026-01-31',
    status: 'active',
    sensitivity: 'normal',
    alternative: null,
    ...overrides,
  };
}

function extraction(items = [candidate()], evidence = undefined, runOverrides = {}) {
  return {
    run: {
      caseId: 'scenario-01-s01',
      extractorVersion: 'memory-v3-synthetic-lifecycle-fixture-v1',
      ...runOverrides,
    },
    items,
    evidence: evidence ?? items.map((item, index) => ({
      itemKey: item.localItemKey,
      sourceMessageId: `m${index + 1}`,
      episodeKey: `episode:m${index + 1}`,
      relation: 'supports',
      supportType: item.kind === 'recurrence' ? 'episode_observation' : null,
      provenanceRole: 'user',
      mentionTime: '2026-01-10T10:00:00Z',
    })),
  };
}

function createProposal(localItemKey = 'candidate-01') {
  return [{ type: 'create', candidateLocalItemKey: localItemKey, targetMemoryKey: null }];
}

function applyCreate(overrides = {}) {
  return applyLifecycleStep({
    state: createEmptyLifecycleState({ scenarioId: 'scenario-01' }),
    session: session(),
    extraction: extraction(),
    proposal: createProposal(),
    forgetMemoryKeys: [],
    ...overrides,
  });
}

function assertReducerError(fn, diagnosticCode) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, 'MemoryV3LifecycleReducerError');
  assert.match(thrown.message, /^\[memory-v3:lifecycle-reducer\] /);
  assert.equal(thrown.diagnosticCode, diagnosticCode);
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  return thrown;
}

describe('createEmptyLifecycleState and reducer identity', () => {
  test('creates a deeply frozen empty state from a strict options record', () => {
    const state = createEmptyLifecycleState({ scenarioId: 'scenario-01' });
    assert.deepEqual(state, { scenarioId: 'scenario-01', nextMemoryOrdinal: 1, items: [] });
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.items));
  });

  test('does not execute scenarioId getters or trust spoofed errors', () => {
    let getterCalls = 0;
    const options = {};
    Object.defineProperty(options, 'scenarioId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'RAW_SCENARIO_SECRET';
      },
    });
    const error = assertReducerError(
      () => createEmptyLifecycleState(options),
      'lifecycle_reducer_invalid_input',
    );
    assert.equal(getterCalls, 0);
    assert.equal(JSON.stringify(error).includes('RAW_SCENARIO_SECRET'), false);
  });

  test('creates the hand-derived deterministic first memory key', () => {
    const result = applyCreate();
    assert.equal(result.state.items[0].memoryKey, MEMORY_KEY_1);
    assert.equal(result.state.nextMemoryOrdinal, 2);
  });
});

describe('applyLifecycleStep operation effects', () => {
  test('create copies material fields, trusted times, evidence, and freezes output', () => {
    const result = applyCreate();
    assert.deepEqual(result.state.items[0], {
      memoryKey: MEMORY_KEY_1,
      kind: 'event',
      claim: 'Переехала в Казань в январе 2026 года',
      status: 'active',
      sensitivity: 'normal',
      eventTimeStart: '2026-01-01',
      eventTimeEnd: '2026-01-31',
      alternative: null,
      firstSeenAt: '2026-01-10T10:00:00Z',
      updatedAt: '2026-01-10T10:00:00Z',
      revision: 1,
      evidence: [{
        conversationId: 'synthetic-scenario-01-c01',
        sourceMessageId: 'm1',
        relation: 'supports',
        supportType: null,
        episodeKey: 'episode:m1',
        provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:00Z',
      }],
    });
    assert.deepEqual(result.transitions, [{
      type: 'create',
      candidateLocalItemKey: 'candidate-01',
      targetMemoryKey: null,
      resultingMemoryKey: MEMORY_KEY_1,
    }]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.state.items[0].evidence));
    assert.ok(Object.isFrozen(result.transitions));
  });

  test('confirm appends only new evidence and preserves material revision and updatedAt', () => {
    const first = applyCreate().state;
    const nextSession = session({
      stepId: 'scenario-01-s02',
      at: '2026-02-10T10:00:00Z',
      conversationId: 'synthetic-scenario-01-c02',
    });
    const nextExtraction = extraction(
      [candidate({ claim: 'В январе я перебралась в Казань' })],
      [{
        itemKey: 'candidate-01',
        sourceMessageId: 'm1',
        episodeKey: 'episode:m1',
        relation: 'supports',
        supportType: null,
        provenanceRole: 'user',
        mentionTime: '2026-02-10T10:00:00Z',
      }],
      { caseId: 'scenario-01-s02' },
    );
    const result = applyLifecycleStep({
      state: first,
      session: nextSession,
      extraction: nextExtraction,
      proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });
    assert.equal(result.state.items[0].claim, first.items[0].claim);
    assert.equal(result.state.items[0].revision, 1);
    assert.equal(result.state.items[0].updatedAt, '2026-01-10T10:00:00Z');
    assert.equal(result.state.items[0].evidence.length, 2);
    assert.equal(result.state.items[0].evidence[1].conversationId, 'synthetic-scenario-01-c02');
  });

  test('confirm adds pattern evidence to a recurrence without adding an episode', () => {
    const recurrence = candidate({
      kind: 'recurrence',
      claim: 'Заранее планирует маршруты',
      eventTimeStart: null,
      eventTimeEnd: null,
    });
    const observations = [
      {
        itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:one',
        relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:00Z',
      },
      {
        itemKey: 'candidate-01', sourceMessageId: 'm2', episodeKey: 'episode:two',
        relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:01Z',
      },
    ];
    const first = applyCreate({ extraction: extraction([recurrence], observations) }).state;
    const confirmation = extraction([recurrence], [{
      itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: null,
      relation: 'supports', supportType: 'pattern_confirmation', provenanceRole: 'user',
      mentionTime: '2026-02-10T10:00:00Z',
    }], { caseId: 'scenario-01-s02' });

    const result = applyLifecycleStep({
      state: first,
      session: session({
        stepId: 'scenario-01-s02',
        at: '2026-02-10T10:00:00Z',
        conversationId: 'synthetic-scenario-01-c02',
      }),
      extraction: confirmation,
      proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });

    const rows = result.state.items[0].evidence;
    assert.equal(rows.filter((row) => row.supportType === 'episode_observation').length, 2);
    assert.equal(rows.filter((row) => row.supportType === 'pattern_confirmation').length, 1);
    assert.equal(rows.at(-1).episodeKey, null);
  });

  test('grows a candidate recurrence from one observation to two across sessions', () => {
    const recurrence = candidate({
      kind: 'recurrence',
      claim: 'Проверяет дверь перед поездкой',
      status: 'candidate',
      eventTimeStart: null,
      eventTimeEnd: null,
    });
    const firstObservation = [{
      itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:one',
      relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
      mentionTime: '2026-01-10T10:00:00Z',
    }];
    const first = applyCreate({ extraction: extraction([recurrence], firstObservation) }).state;
    const secondObservation = extraction([recurrence], [{
      itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:two',
      relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
      mentionTime: '2026-02-10T10:00:00Z',
    }], { caseId: 'scenario-01-s02' });

    const result = applyLifecycleStep({
      state: first,
      session: session({
        stepId: 'scenario-01-s02',
        at: '2026-02-10T10:00:00Z',
        conversationId: 'synthetic-scenario-01-c02',
      }),
      extraction: secondObservation,
      proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });

    assert.equal(result.state.items[0].status, 'candidate');
    assert.equal(result.state.items[0].revision, 1);
    assert.equal(result.state.items[0].evidence.length, 2);
    assert.equal(new Set(result.state.items[0].evidence.map((row) => row.episodeKey)).size, 2);
  });

  test('revise adds a scope boundary without inventing a recurrence episode', () => {
    const recurrence = candidate({
      kind: 'recurrence',
      claim: 'Обычно избегает незнакомых звонков',
      eventTimeStart: null,
      eventTimeEnd: null,
    });
    const observations = [
      {
        itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:one',
        relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:00Z',
      },
      {
        itemKey: 'candidate-01', sourceMessageId: 'm2', episodeKey: 'episode:two',
        relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:01Z',
      },
    ];
    const first = applyCreate({ extraction: extraction([recurrence], observations) }).state;
    const narrowed = candidate({
      kind: 'recurrence',
      claim: 'Обычно избегает только звонков с незнакомых номеров',
      eventTimeStart: null,
      eventTimeEnd: null,
    });
    const boundary = extraction([narrowed], [{
      itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: null,
      relation: 'supports', supportType: 'scope_boundary', provenanceRole: 'user',
      mentionTime: '2026-02-10T10:00:00Z',
    }], { caseId: 'scenario-01-s02' });

    const result = applyLifecycleStep({
      state: first,
      session: session({
        stepId: 'scenario-01-s02',
        at: '2026-02-10T10:00:00Z',
        conversationId: 'synthetic-scenario-01-c02',
      }),
      extraction: boundary,
      proposal: [{ type: 'revise', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });

    const item = result.state.items[0];
    assert.equal(item.claim, narrowed.claim);
    assert.equal(item.revision, 2);
    assert.equal(item.evidence.filter((row) => row.supportType === 'episode_observation').length, 2);
    assert.equal(item.evidence.filter((row) => row.supportType === 'scope_boundary').length, 1);
    assert.equal(item.evidence.at(-1).episodeKey, null);
  });

  test('repeating identical confirm is byte-for-byte idempotent', () => {
    const first = applyCreate().state;
    const result = applyLifecycleStep({
      state: first,
      session: session(),
      extraction: extraction(),
      proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });
    assert.deepEqual(result.state, first);
  });

  test('revise replaces material fields and increments revision once', () => {
    const first = applyCreate().state;
    const revised = candidate({
      claim: 'Переехала в Казань в феврале 2026 года',
      eventTimeStart: '2026-02-01',
      eventTimeEnd: '2026-02-28',
    });
    const result = applyLifecycleStep({
      state: first,
      session: session({ stepId: 'scenario-01-s02', at: '2026-02-12T10:00:00Z' }),
      extraction: extraction([revised], undefined, { caseId: 'scenario-01-s02' }),
      proposal: [{ type: 'revise', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });
    assert.equal(result.state.items[0].memoryKey, MEMORY_KEY_1);
    assert.equal(result.state.items[0].firstSeenAt, '2026-01-10T10:00:00Z');
    assert.equal(result.state.items[0].updatedAt, '2026-02-12T10:00:00Z');
    assert.equal(result.state.items[0].revision, 2);
    assert.equal(result.state.items[0].claim, revised.claim);
    assert.equal(result.state.items[0].eventTimeStart, '2026-02-01');
  });

  test('mark_stale closes recurrence without replacing its material claim', () => {
    const observations = [
      {
        itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:m1',
        relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:00Z',
      },
      {
        itemKey: 'candidate-01', sourceMessageId: 'm2', episodeKey: 'episode:m2',
        relation: 'supports', supportType: 'episode_observation', provenanceRole: 'user',
        mentionTime: '2026-01-10T10:00:00Z',
      },
    ];
    const recurrence = candidate({ kind: 'recurrence', claim: 'Пропускает завтрак по будням' });
    const first = applyCreate({ extraction: extraction([recurrence], observations) }).state;
    const stale = candidate({ kind: 'recurrence', claim: 'Теперь завтракает по будням', status: 'stale' });
    const contradiction = [{
      itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:m1',
      relation: 'contradicts', supportType: null, provenanceRole: 'user',
      mentionTime: '2026-03-10T10:00:00Z',
    }];
    const result = applyLifecycleStep({
      state: first,
      session: session({ stepId: 'scenario-01-s03', at: '2026-03-10T10:00:00Z' }),
      extraction: extraction([stale], contradiction, { caseId: 'scenario-01-s03' }),
      proposal: [{ type: 'mark_stale', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });
    assert.equal(result.state.items[0].status, 'stale');
    assert.equal(result.state.items[0].claim, 'Пропускает завтрак по будням');
    assert.equal(result.state.items[0].revision, 2);
  });

  test('reject closes a hypothesis and preserves its earlier material claim', () => {
    const hypothesis = candidate({
      kind: 'hypothesis',
      claim: 'Молчание означает злость',
      status: 'candidate',
      alternative: 'Человек может быть уставшим',
    });
    const first = applyCreate({ extraction: extraction([hypothesis]) }).state;
    const rejected = { ...hypothesis, claim: 'Молчание не означает злость', status: 'rejected' };
    const rejectionEvidence = [{
      itemKey: 'candidate-01', sourceMessageId: 'm1', episodeKey: 'episode:m1',
      relation: 'rejects', supportType: null, provenanceRole: 'user',
      mentionTime: '2026-02-10T10:00:00Z',
    }];
    const result = applyLifecycleStep({
      state: first,
      session: session({ stepId: 'scenario-01-s02', at: '2026-02-10T10:00:00Z' }),
      extraction: extraction([rejected], rejectionEvidence, { caseId: 'scenario-01-s02' }),
      proposal: [{ type: 'reject', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
      forgetMemoryKeys: [],
    });
    assert.equal(result.state.items[0].status, 'rejected');
    assert.equal(result.state.items[0].claim, 'Молчание означает злость');
    assert.equal(result.state.items[0].revision, 2);
  });

  test('ignore changes no state', () => {
    const first = applyCreate().state;
    const result = applyLifecycleStep({
      state: first,
      session: session({ stepId: 'scenario-01-s02' }),
      extraction: extraction(undefined, undefined, { caseId: 'scenario-01-s02' }),
      proposal: [{ type: 'ignore', candidateLocalItemKey: 'candidate-01', targetMemoryKey: null }],
      forgetMemoryKeys: [],
    });
    assert.deepEqual(result.state, first);
  });
});

describe('forgetting, determinism, and atomic failure', () => {
  test('trusted forget removes the complete item before an empty proposal', () => {
    const first = applyCreate().state;
    const result = applyLifecycleStep({
      state: first,
      session: session({ stepId: 'scenario-01-s02' }),
      extraction: extraction([], [], { caseId: 'scenario-01-s02' }),
      proposal: [],
      forgetMemoryKeys: [MEMORY_KEY_1],
    });
    assert.deepEqual(result.state.items, []);
    assert.deepEqual(result.transitions, [{
      type: 'forget',
      candidateLocalItemKey: null,
      targetMemoryKey: MEMORY_KEY_1,
      resultingMemoryKey: null,
    }]);
    assert.equal(JSON.stringify(result).includes('Переехала'), false);
  });

  test('an old snapshot ignored after forgetting cannot resurrect memory', () => {
    const forgotten = applyLifecycleStep({
      state: applyCreate().state,
      session: session({ stepId: 'scenario-01-s02' }),
      extraction: extraction([], [], { caseId: 'scenario-01-s02' }),
      proposal: [],
      forgetMemoryKeys: [MEMORY_KEY_1],
    }).state;
    const replay = applyLifecycleStep({
      state: forgotten,
      session: session({ stepId: 'scenario-01-s03' }),
      extraction: extraction(undefined, undefined, { caseId: 'scenario-01-s03' }),
      proposal: [{ type: 'ignore', candidateLocalItemKey: 'candidate-01', targetMemoryKey: null }],
      forgetMemoryKeys: [],
    });
    assert.deepEqual(replay.state.items, []);
  });

  test('reordered create proposals produce byte-identical state and audit', () => {
    const items = [candidate({ localItemKey: 'candidate-b', claim: 'Факт Б' }), candidate({ localItemKey: 'candidate-a', claim: 'Факт А' })];
    const input = {
      state: createEmptyLifecycleState({ scenarioId: 'scenario-01' }),
      session: session(),
      extraction: extraction(items),
      forgetMemoryKeys: [],
    };
    const left = applyLifecycleStep({
      ...input,
      proposal: [createProposal('candidate-b')[0], createProposal('candidate-a')[0]],
    });
    const right = applyLifecycleStep({
      ...input,
      proposal: [createProposal('candidate-a')[0], createProposal('candidate-b')[0]],
    });
    assert.deepEqual(left, right);
  });

  test('rejects scenario or step mismatch without mutating any input', () => {
    const state = createEmptyLifecycleState({ scenarioId: 'scenario-01' });
    const raw = {
      state,
      session: session({ scenarioId: 'other-scenario' }),
      extraction: extraction(),
      proposal: createProposal(),
      forgetMemoryKeys: [],
    };
    const before = structuredClone(raw);
    assertReducerError(() => applyLifecycleStep(raw), 'lifecycle_reducer_invalid_input');
    assert.deepEqual(raw, before);
  });

  test('rejects a backwards target update atomically', () => {
    const state = applyCreate().state;
    const before = structuredClone(state);
    assertReducerError(
      () => applyLifecycleStep({
        state,
        session: session({ stepId: 'scenario-01-s02', at: '2026-01-09T10:00:00Z' }),
        extraction: extraction(undefined, undefined, { caseId: 'scenario-01-s02' }),
        proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
        forgetMemoryKeys: [],
      }),
      'lifecycle_reducer_transition_invalid',
    );
    assert.deepEqual(state, before);
  });

  test('rejects conflicting durable evidence atomically', () => {
    const state = applyCreate().state;
    const conflictingEvidence = [{
      itemKey: 'candidate-01',
      sourceMessageId: 'm1',
      episodeKey: 'episode:changed',
      relation: 'supports',
      supportType: null,
      provenanceRole: 'user',
      mentionTime: '2026-01-10T10:00:00Z',
    }];
    const before = structuredClone(state);
    assertReducerError(
      () => applyLifecycleStep({
        state,
        session: session(),
        extraction: extraction(undefined, conflictingEvidence),
        proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
        forgetMemoryKeys: [],
      }),
      'lifecycle_reducer_transition_invalid',
    );
    assert.deepEqual(state, before);
  });

  test('rejects a proposal that targets a key forgotten in the same step', () => {
    const state = applyCreate().state;
    assertReducerError(
      () => applyLifecycleStep({
        state,
        session: session({ stepId: 'scenario-01-s02' }),
        extraction: extraction(undefined, undefined, { caseId: 'scenario-01-s02' }),
        proposal: [{ type: 'confirm', candidateLocalItemKey: 'candidate-01', targetMemoryKey: MEMORY_KEY_1 }],
        forgetMemoryKeys: [MEMORY_KEY_1],
      }),
      'lifecycle_reducer_invalid_input',
    );
    assert.equal(state.items.length, 1);
  });

  test('does not trust a stolen reducer error thrown by a proxy trap', () => {
    const branded = assertReducerError(
      () => createEmptyLifecycleState(null),
      'lifecycle_reducer_invalid_input',
    );
    const proxy = new Proxy({}, {
      ownKeys() {
        throw branded;
      },
    });
    const error = assertReducerError(
      () => applyLifecycleStep(proxy),
      'lifecycle_reducer_invalid_input',
    );
    assert.notEqual(error, branded);
    assert.equal(projectSafeLifecycleReducerDiagnostic(error), 'lifecycle_reducer_invalid_input');
  });

  test('does not read extraction through get traps after descriptor validation', () => {
    let getCalls = 0;
    const raw = extraction();
    const proxy = new Proxy(raw, {
      get(target, key, receiver) {
        getCalls += 1;
        if (key === 'items') throw new Error('RAW_POST_VALIDATION_SECRET');
        return Reflect.get(target, key, receiver);
      },
    });
    const result = applyCreate({ extraction: proxy });
    assert.equal(getCalls, 0);
    assert.equal(result.state.items.length, 1);
    assert.equal(JSON.stringify(result).includes('RAW_POST_VALIDATION_SECRET'), false);
  });

  test('does not publish the first create when a later proposal row is invalid', () => {
    const state = createEmptyLifecycleState({ scenarioId: 'scenario-01' });
    const first = candidate({ localItemKey: 'candidate-01' });
    const second = candidate({ localItemKey: 'candidate-02', claim: 'Второй синтетический факт' });
    const input = {
      state,
      session: session(),
      extraction: extraction([first, second]),
      proposal: [
        { type: 'create', candidateLocalItemKey: 'candidate-01', targetMemoryKey: null },
        { type: 'create', candidateLocalItemKey: 'missing-candidate', targetMemoryKey: null },
      ],
      forgetMemoryKeys: [],
    };
    assertReducerError(() => applyLifecycleStep(input), 'lifecycle_reducer_invalid_input');
    assert.deepEqual(state.items, []);
    assert.equal(state.nextMemoryOrdinal, 1);
  });
});
