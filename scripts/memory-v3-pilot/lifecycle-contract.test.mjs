import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LIFECYCLE_CLOSED_STATUS_BY_KIND,
  LIFECYCLE_CURRENT_STATUS_BY_KIND,
  LIFECYCLE_OPERATION_TYPES,
  projectSafeLifecycleContractDiagnostic,
  validateForgetMemoryKeys,
  validateLifecycleProposal,
  validateLifecycleSession,
  validateLifecycleState,
} from './lifecycle-contract.mjs';

const MEMORY_KEY_A = 'a'.repeat(64);
const MEMORY_KEY_B = 'b'.repeat(64);

function clone(value) {
  return structuredClone(value);
}

function sessionFixture(overrides = {}) {
  return {
    scenarioId: 'scenario-01',
    stepId: 'scenario-01-s01',
    at: '2026-01-10T10:00:00Z',
    conversationId: 'synthetic-scenario-01-c01',
    ...overrides,
  };
}

function evidenceFixture(overrides = {}) {
  return {
    conversationId: 'synthetic-scenario-01-c01',
    sourceMessageId: 'm1',
    relation: 'supports',
    supportType: null,
    episodeKey: 'episode:m1',
    provenanceRole: 'user',
    mentionTime: '2026-01-10T10:00:00Z',
    ...overrides,
  };
}

function itemFixture(overrides = {}) {
  return {
    memoryKey: MEMORY_KEY_A,
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
    evidence: [evidenceFixture()],
    ...overrides,
  };
}

function stateFixture(overrides = {}) {
  return {
    scenarioId: 'scenario-01',
    nextMemoryOrdinal: 2,
    items: [itemFixture()],
    ...overrides,
  };
}

function extractionFixture(items = undefined) {
  const resolvedItems = items ?? [{
    localItemKey: 'candidate-01',
    kind: 'event',
    claim: 'Переехала в Казань',
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: '2026-01-01',
    eventTimeEnd: '2026-01-31',
    status: 'active',
    sensitivity: 'normal',
    alternative: null,
  }];
  return {
    run: { caseId: 'scenario-01-s01', extractorVersion: 'synthetic-v1' },
    items: resolvedItems,
    evidence: resolvedItems.map((item, index) => ({
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

function proposalFixture(overrides = {}) {
  return [{
    type: 'confirm',
    candidateLocalItemKey: 'candidate-01',
    targetMemoryKey: MEMORY_KEY_A,
    ...overrides,
  }];
}

function assertContractError(fn, diagnosticCode) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, 'MemoryV3LifecycleContractError');
  assert.match(thrown.message, /^\[memory-v3:lifecycle-contract\] /);
  assert.equal(thrown.diagnosticCode, diagnosticCode);
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  return thrown;
}

describe('lifecycle contract constants and valid projections', () => {
  test('exports deeply frozen operation and status constants', () => {
    assert.deepEqual(LIFECYCLE_OPERATION_TYPES, [
      'create',
      'confirm',
      'revise',
      'mark_stale',
      'reject',
      'ignore',
    ]);
    assert.deepEqual(LIFECYCLE_CURRENT_STATUS_BY_KIND, {
      event: ['active'],
      recurrence: ['candidate', 'active'],
      hypothesis: ['candidate', 'supported'],
    });
    assert.deepEqual(LIFECYCLE_CLOSED_STATUS_BY_KIND, {
      event: ['corrected', 'rejected'],
      recurrence: ['stale', 'rejected'],
      hypothesis: ['stale', 'rejected'],
    });
    assert.ok(Object.isFrozen(LIFECYCLE_OPERATION_TYPES));
    assert.ok(Object.isFrozen(LIFECYCLE_CURRENT_STATUS_BY_KIND));
    assert.ok(Object.isFrozen(LIFECYCLE_CURRENT_STATUS_BY_KIND.recurrence));
  });

  test('copies a valid session without aliasing or mutation', () => {
    const raw = sessionFixture();
    const before = clone(raw);
    const actual = validateLifecycleSession(raw);
    assert.deepEqual(actual, before);
    assert.notEqual(actual, raw);
    assert.deepEqual(raw, before);
  });

  test('copies a valid event state and nested evidence without aliasing', () => {
    const raw = stateFixture();
    const before = clone(raw);
    const actual = validateLifecycleState(raw);
    assert.deepEqual(actual, before);
    assert.notEqual(actual, raw);
    assert.notEqual(actual.items, raw.items);
    assert.notEqual(actual.items[0], raw.items[0]);
    assert.notEqual(actual.items[0].evidence, raw.items[0].evidence);
    assert.deepEqual(raw, before);
  });

  test('accepts every current and closed kind/status combination', () => {
    const matrix = {
      event: ['active', 'corrected', 'rejected'],
      recurrence: ['candidate', 'active', 'stale', 'rejected'],
      hypothesis: ['candidate', 'supported', 'stale', 'rejected'],
    };
    for (const [kind, statuses] of Object.entries(matrix)) {
      for (const status of statuses) {
        const relation = status === 'corrected'
          ? 'corrects'
          : status === 'rejected'
            ? 'rejects'
            : status === 'stale'
              ? 'contradicts'
              : 'supports';
        const evidence = kind === 'recurrence' && relation === 'supports'
          ? [
              evidenceFixture({ supportType: 'episode_observation' }),
              evidenceFixture({
                sourceMessageId: 'm2',
                supportType: 'episode_observation',
                episodeKey: 'episode:m2',
              }),
            ]
          : [evidenceFixture({ relation })];
        assert.doesNotThrow(() => validateLifecycleState(stateFixture({
          items: [itemFixture({
            kind,
            status,
            alternative: kind === 'hypothesis' ? 'Альтернативное объяснение' : null,
            evidence,
          })],
        })));
      }
    }
  });

  test('accepts a closed proposal and returns a detached copy', () => {
    const raw = proposalFixture();
    const actual = validateLifecycleProposal(raw, {
      state: stateFixture(),
      extraction: extractionFixture(),
    });
    assert.deepEqual(actual, raw);
    assert.notEqual(actual, raw);
    assert.notEqual(actual[0], raw[0]);
  });

  test('accepts unique existing forget keys and returns a detached copy', () => {
    const raw = [MEMORY_KEY_A];
    const actual = validateForgetMemoryKeys(raw, stateFixture());
    assert.deepEqual(actual, raw);
    assert.notEqual(actual, raw);
  });
});

describe('lifecycle state semantic validation', () => {
  test('allows a candidate recurrence after one observation but not an active recurrence', () => {
    const oneObservation = [evidenceFixture({
      supportType: 'episode_observation',
      episodeKey: 'episode:one',
    })];
    assert.doesNotThrow(() => validateLifecycleState(stateFixture({
      items: [itemFixture({
        kind: 'recurrence',
        status: 'candidate',
        eventTimeStart: null,
        eventTimeEnd: null,
        evidence: oneObservation,
      })],
    })));
    assertContractError(
      () => validateLifecycleState(stateFixture({
        items: [itemFixture({
          kind: 'recurrence',
          status: 'active',
          eventTimeStart: null,
          eventTimeEnd: null,
          evidence: oneObservation,
        })],
      })),
      'lifecycle_contract_invalid_state',
    );
  });

  test('rejects status from another kind', () => {
    assertContractError(
      () => validateLifecycleState(stateFixture({ items: [itemFixture({ status: 'supported' })] })),
      'lifecycle_contract_invalid_state',
    );
  });

  test('rejects invalid identity, revision, ordinal, and timestamp order', () => {
    const mutations = [
      { memoryKey: 'not-a-key' },
      { revision: 0 },
      { firstSeenAt: 'not-a-date' },
      { updatedAt: '2026-01-09T10:00:00Z' },
    ];
    for (const mutation of mutations) {
      assertContractError(
        () => validateLifecycleState(stateFixture({ items: [itemFixture(mutation)] })),
        'lifecycle_contract_invalid_state',
      );
    }
    assertContractError(
      () => validateLifecycleState(stateFixture({ nextMemoryOrdinal: 0 })),
      'lifecycle_contract_invalid_state',
    );
  });

  test('rejects duplicate memory keys', () => {
    assertContractError(
      () => validateLifecycleState(stateFixture({
        items: [itemFixture(), itemFixture({ claim: 'Другой факт' })],
      })),
      'lifecycle_contract_invalid_state',
    );
  });

  test('rejects non-user evidence and invalid recurrence support typing', () => {
    assertContractError(
      () => validateLifecycleState(stateFixture({
        items: [itemFixture({ evidence: [evidenceFixture({ provenanceRole: 'assistant' })] })],
      })),
      'lifecycle_contract_invalid_state',
    );
    assertContractError(
      () => validateLifecycleState(stateFixture({
        items: [itemFixture({ kind: 'recurrence' })],
      })),
      'lifecycle_contract_invalid_state',
    );
  });

  test('rejects duplicate and conflicting durable evidence tuples', () => {
    const duplicate = evidenceFixture();
    assertContractError(
      () => validateLifecycleState(stateFixture({
        items: [itemFixture({ evidence: [duplicate, clone(duplicate)] })],
      })),
      'lifecycle_contract_invalid_state',
    );
    assertContractError(
      () => validateLifecycleState(stateFixture({
        items: [itemFixture({ evidence: [duplicate, { ...duplicate, episodeKey: 'episode:other' }] })],
      })),
      'lifecycle_contract_invalid_state',
    );
  });
});

describe('lifecycle proposal reference and consumption validation', () => {
  test('accepts create and ignore only with null targets', () => {
    const state = stateFixture({ items: [] });
    for (const type of ['create', 'ignore']) {
      assert.doesNotThrow(() => validateLifecycleProposal([{
        type,
        candidateLocalItemKey: 'candidate-01',
        targetMemoryKey: null,
      }], { state, extraction: extractionFixture() }));
    }
  });

  test('requires a target for target-changing operations', () => {
    for (const type of ['confirm', 'revise', 'mark_stale', 'reject']) {
      assertContractError(
        () => validateLifecycleProposal([{
          type,
          candidateLocalItemKey: 'candidate-01',
          targetMemoryKey: null,
        }], { state: stateFixture(), extraction: extractionFixture() }),
        'lifecycle_contract_invalid_proposal',
      );
    }
  });

  test('rejects unknown candidates and targets', () => {
    assertContractError(
      () => validateLifecycleProposal(proposalFixture({ candidateLocalItemKey: 'missing' }), {
        state: stateFixture(), extraction: extractionFixture(),
      }),
      'lifecycle_contract_invalid_proposal',
    );
    assertContractError(
      () => validateLifecycleProposal(proposalFixture({ targetMemoryKey: MEMORY_KEY_B }), {
        state: stateFixture(), extraction: extractionFixture(),
      }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('requires every extraction candidate exactly once', () => {
    const second = { ...extractionFixture().items[0], localItemKey: 'candidate-02' };
    const extraction = extractionFixture([extractionFixture().items[0], second]);
    assertContractError(
      () => validateLifecycleProposal(proposalFixture(), { state: stateFixture(), extraction }),
      'lifecycle_contract_invalid_proposal',
    );
    assertContractError(
      () => validateLifecycleProposal([proposalFixture()[0], proposalFixture()[0]], {
        state: stateFixture(), extraction: extractionFixture(),
      }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('rejects two changing operations against one target', () => {
    const item2 = { ...extractionFixture().items[0], localItemKey: 'candidate-02' };
    const extraction = extractionFixture([extractionFixture().items[0], item2]);
    assertContractError(
      () => validateLifecycleProposal([
        proposalFixture()[0],
        { type: 'revise', candidateLocalItemKey: 'candidate-02', targetMemoryKey: MEMORY_KEY_A },
      ], { state: stateFixture(), extraction }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('allows two non-conflicting confirmations of one target', () => {
    const item2 = { ...extractionFixture().items[0], localItemKey: 'candidate-02' };
    const extraction = extractionFixture([extractionFixture().items[0], item2]);
    assert.doesNotThrow(() => validateLifecycleProposal([
      proposalFixture()[0],
      { type: 'confirm', candidateLocalItemKey: 'candidate-02', targetMemoryKey: MEMORY_KEY_A },
    ], { state: stateFixture(), extraction }));
  });

  test('allows recurrence confirmation evidence without inventing new episodes', () => {
    const recurrenceState = stateFixture({
      items: [itemFixture({
        kind: 'recurrence',
        status: 'active',
        eventTimeStart: null,
        eventTimeEnd: null,
        evidence: [
          evidenceFixture({ sourceMessageId: 'm1', supportType: 'episode_observation', episodeKey: 'episode:one' }),
          evidenceFixture({ sourceMessageId: 'm2', supportType: 'episode_observation', episodeKey: 'episode:two' }),
        ],
      })],
    });
    const recurrence = {
      ...extractionFixture().items[0],
      kind: 'recurrence',
      eventTimeStart: null,
      eventTimeEnd: null,
    };
    const recurrenceExtraction = extractionFixture([recurrence]);
    recurrenceExtraction.evidence = [{
      ...recurrenceExtraction.evidence[0],
      supportType: 'pattern_confirmation',
      episodeKey: null,
    }];

    assert.doesNotThrow(() => validateLifecycleProposal([{
      type: 'confirm',
      candidateLocalItemKey: 'candidate-01',
      targetMemoryKey: MEMORY_KEY_A,
    }], { state: recurrenceState, extraction: recurrenceExtraction }));
  });

  test('still requires two recurrence observations when creating durable state', () => {
    const recurrence = {
      ...extractionFixture().items[0],
      kind: 'recurrence',
      eventTimeStart: null,
      eventTimeEnd: null,
    };
    const recurrenceExtraction = extractionFixture([recurrence]);
    recurrenceExtraction.evidence = [{
      ...recurrenceExtraction.evidence[0],
      supportType: 'pattern_confirmation',
      episodeKey: null,
    }];
    assertContractError(
      () => validateLifecycleProposal([{
        type: 'create',
        candidateLocalItemKey: 'candidate-01',
        targetMemoryKey: null,
      }], { state: { scenarioId: 'scenario-01', nextMemoryOrdinal: 1, items: [] }, extraction: recurrenceExtraction }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('allows creating a candidate recurrence from its first observed episode', () => {
    const recurrence = {
      ...extractionFixture().items[0],
      kind: 'recurrence',
      status: 'candidate',
      eventTimeStart: null,
      eventTimeEnd: null,
    };
    const recurrenceExtraction = extractionFixture([recurrence]);
    recurrenceExtraction.evidence[0].supportType = 'episode_observation';

    assert.doesNotThrow(() => validateLifecycleProposal([{
      type: 'create',
      candidateLocalItemKey: 'candidate-01',
      targetMemoryKey: null,
    }], {
      state: { scenarioId: 'scenario-01', nextMemoryOrdinal: 1, items: [] },
      extraction: recurrenceExtraction,
    }));
  });

  test('rejects a semantically invalid extraction context', () => {
    const badClaim = extractionFixture();
    badClaim.items[0].claim = { raw: 'RAW_CLAIM_SECRET' };
    const assistantEvidence = extractionFixture();
    assistantEvidence.evidence[0].provenanceRole = 'assistant';
    const unknownEvidenceItem = extractionFixture();
    unknownEvidenceItem.evidence[0].itemKey = 'missing-candidate';
    for (const extraction of [badClaim, assistantEvidence, unknownEvidenceItem]) {
      const error = assertContractError(
        () => validateLifecycleProposal(proposalFixture(), {
          state: stateFixture(),
          extraction,
        }),
        'lifecycle_contract_invalid_proposal',
      );
      assert.equal(JSON.stringify(error).includes('RAW_CLAIM_SECRET'), false);
    }
  });

  test('rejects kind-incompatible target operations', () => {
    const recurrence = {
      ...extractionFixture().items[0],
      kind: 'recurrence',
      status: 'stale',
    };
    const extraction = extractionFixture([recurrence]);
    extraction.evidence[0] = {
      ...extraction.evidence[0],
      relation: 'contradicts',
      supportType: null,
    };
    for (const type of ['confirm', 'revise', 'mark_stale']) {
      assertContractError(
        () => validateLifecycleProposal([{
          type,
          candidateLocalItemKey: 'candidate-01',
          targetMemoryKey: MEMORY_KEY_A,
        }], { state: stateFixture(), extraction }),
        'lifecycle_contract_invalid_proposal',
      );
    }
  });

  test('requires stale and rejected candidates for closing operations', () => {
    for (const type of ['mark_stale', 'reject']) {
      assertContractError(
        () => validateLifecycleProposal([{
          type,
          candidateLocalItemKey: 'candidate-01',
          targetMemoryKey: MEMORY_KEY_A,
        }], { state: stateFixture(), extraction: extractionFixture() }),
        'lifecycle_contract_invalid_proposal',
      );
    }
  });

  test('rejects confirm when the candidate itself is closed', () => {
    const rejectedCandidate = { ...extractionFixture().items[0], status: 'rejected' };
    const extraction = extractionFixture([rejectedCandidate]);
    extraction.evidence[0] = { ...extraction.evidence[0], relation: 'rejects' };
    assertContractError(
      () => validateLifecycleProposal([{
        type: 'confirm',
        candidateLocalItemKey: 'candidate-01',
        targetMemoryKey: MEMORY_KEY_A,
      }], { state: stateFixture(), extraction }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('does not let revise bypass reject or mark_stale operations', () => {
    const rejectedCandidate = { ...extractionFixture().items[0], status: 'rejected' };
    const rejectedExtraction = extractionFixture([rejectedCandidate]);
    rejectedExtraction.evidence[0] = { ...rejectedExtraction.evidence[0], relation: 'rejects' };
    assertContractError(
      () => validateLifecycleProposal([{
        type: 'revise',
        candidateLocalItemKey: 'candidate-01',
        targetMemoryKey: MEMORY_KEY_A,
      }], { state: stateFixture(), extraction: rejectedExtraction }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('rejects every target operation against an already closed memory', () => {
    const closedEventState = stateFixture({
      items: [itemFixture({
        status: 'rejected',
        evidence: [evidenceFixture({ relation: 'rejects' })],
      })],
    });
    const rejectedCandidate = { ...extractionFixture().items[0], status: 'rejected' };
    const rejectedExtraction = extractionFixture([rejectedCandidate]);
    rejectedExtraction.evidence[0] = {
      ...rejectedExtraction.evidence[0],
      relation: 'rejects',
    };
    for (const [type, extraction] of [
      ['confirm', extractionFixture()],
      ['revise', extractionFixture()],
      ['reject', rejectedExtraction],
    ]) {
      assertContractError(
        () => validateLifecycleProposal([{
          type,
          candidateLocalItemKey: 'candidate-01',
          targetMemoryKey: MEMORY_KEY_A,
        }], { state: closedEventState, extraction }),
        'lifecycle_contract_invalid_proposal',
      );
    }

    const closedRecurrenceState = stateFixture({
      items: [itemFixture({
        kind: 'recurrence',
        status: 'stale',
        evidence: [evidenceFixture({ relation: 'contradicts' })],
      })],
    });
    const staleCandidate = {
      ...extractionFixture().items[0],
      kind: 'recurrence',
      status: 'stale',
    };
    const staleExtraction = extractionFixture([staleCandidate]);
    staleExtraction.evidence[0] = {
      ...staleExtraction.evidence[0],
      relation: 'contradicts',
      supportType: null,
    };
    assertContractError(
      () => validateLifecycleProposal([{
        type: 'mark_stale',
        candidateLocalItemKey: 'candidate-01',
        targetMemoryKey: MEMORY_KEY_A,
      }], { state: closedRecurrenceState, extraction: staleExtraction }),
      'lifecycle_contract_invalid_proposal',
    );
  });

  test('accepts valid revise, mark_stale, and reject operations', () => {
    assert.doesNotThrow(() => validateLifecycleProposal(
      proposalFixture({ type: 'revise' }),
      { state: stateFixture(), extraction: extractionFixture() },
    ));

    const recurrenceState = stateFixture({
      items: [itemFixture({
        kind: 'recurrence',
        status: 'active',
        evidence: [
          evidenceFixture({ supportType: 'episode_observation' }),
          evidenceFixture({
            sourceMessageId: 'm2',
            supportType: 'episode_observation',
            episodeKey: 'episode:m2',
          }),
        ],
      })],
    });
    const staleCandidate = {
      ...extractionFixture().items[0],
      kind: 'recurrence',
      status: 'stale',
    };
    const staleExtraction = extractionFixture([staleCandidate]);
    staleExtraction.evidence[0] = {
      ...staleExtraction.evidence[0],
      relation: 'contradicts',
      supportType: null,
    };
    assert.doesNotThrow(() => validateLifecycleProposal([{
      type: 'mark_stale',
      candidateLocalItemKey: 'candidate-01',
      targetMemoryKey: MEMORY_KEY_A,
    }], { state: recurrenceState, extraction: staleExtraction }));

    const rejectedCandidate = { ...extractionFixture().items[0], status: 'rejected' };
    const rejectedExtraction = extractionFixture([rejectedCandidate]);
    rejectedExtraction.evidence[0] = {
      ...rejectedExtraction.evidence[0],
      relation: 'rejects',
    };
    assert.doesNotThrow(() => validateLifecycleProposal([{
      type: 'reject',
      candidateLocalItemKey: 'candidate-01',
      targetMemoryKey: MEMORY_KEY_A,
    }], { state: stateFixture(), extraction: rejectedExtraction }));
  });

  test('rejects duplicate, unknown, and malformed forget keys', () => {
    for (const value of [[MEMORY_KEY_A, MEMORY_KEY_A], [MEMORY_KEY_B], ['bad-key']]) {
      assertContractError(
        () => validateForgetMemoryKeys(value, stateFixture()),
        'lifecycle_contract_invalid_forget',
      );
    }
  });
});

describe('JSON-data-only and public diagnostic boundary', () => {
  test('rejects unknown, symbol, non-enumerable, and sparse fields', () => {
    const unknown = sessionFixture({ extra: true });
    const symbol = sessionFixture();
    symbol[Symbol('secret')] = true;
    const hidden = sessionFixture();
    Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
    const sparse = stateFixture({ items: new Array(1) });
    for (const value of [unknown, symbol, hidden]) {
      assertContractError(
        () => validateLifecycleSession(value),
        'lifecycle_contract_invalid_shape',
      );
    }
    assertContractError(
      () => validateLifecycleState(sparse),
      'lifecycle_contract_invalid_shape',
    );
  });

  test('does not execute accessors or leak their sentinel', () => {
    let getterCalls = 0;
    const value = sessionFixture();
    Object.defineProperty(value, 'scenarioId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'RAW_GETTER_SECRET_SENTINEL';
      },
    });
    const error = assertContractError(
      () => validateLifecycleSession(value),
      'lifecycle_contract_invalid_shape',
    );
    assert.equal(getterCalls, 0);
    assert.equal(JSON.stringify(error).includes('RAW_GETTER_SECRET_SENTINEL'), false);
  });

  test('rejects cycles and revoked proxies without leaking trap text', () => {
    const cyclic = stateFixture();
    cyclic.secretCycle = cyclic;
    const { proxy, revoke } = Proxy.revocable(stateFixture(), {});
    revoke();
    for (const value of [cyclic, proxy]) {
      const error = assertContractError(
        () => validateLifecycleState(value),
        'lifecycle_contract_invalid_shape',
      );
      assert.equal(error.message.includes('secretCycle'), false);
      assert.equal(error.name === 'TypeError', false);
    }
  });

  test('projects diagnostics only from module-branded errors', () => {
    const branded = assertContractError(
      () => validateLifecycleSession(null),
      'lifecycle_contract_invalid_shape',
    );
    assert.equal(projectSafeLifecycleContractDiagnostic(branded), 'lifecycle_contract_invalid_shape');

    let getterCalls = 0;
    const spoof = new Error('[memory-v3:lifecycle-contract] spoof');
    spoof.name = 'MemoryV3LifecycleContractError';
    Object.defineProperty(spoof, 'diagnosticCode', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'lifecycle_contract_invalid_state';
      },
    });
    assert.equal(projectSafeLifecycleContractDiagnostic(spoof), null);
    assert.equal(getterCalls, 0);
  });

  test('rejects setter-only, inherited, and stateful descriptor inputs without leaking traps', () => {
    let setterCalls = 0;
    const setterOnly = {};
    Object.defineProperty(setterOnly, 'scenarioId', {
      enumerable: true,
      set() { setterCalls += 1; },
    });
    assertContractError(() => validateLifecycleSession(setterOnly), 'lifecycle_contract_invalid_shape');
    assert.equal(setterCalls, 0);

    const inherited = Object.create(sessionFixture());
    assertContractError(() => validateLifecycleSession(inherited), 'lifecycle_contract_invalid_shape');

    let descriptorCalls = 0;
    const stateful = new Proxy(sessionFixture(), {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        if (descriptorCalls > 1) throw new Error('RAW_STATEFUL_DESCRIPTOR_SENTINEL');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const error = assertContractError(
      () => validateLifecycleSession(stateful),
      'lifecycle_contract_invalid_shape',
    );
    assert.doesNotMatch(JSON.stringify(error), /RAW_STATEFUL_DESCRIPTOR_SENTINEL/);
  });
});
