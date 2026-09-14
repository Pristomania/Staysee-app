/**
 * Memory V3 offline pilot — epistemic contract tests.
 * Run: node --test scripts/memory-v3-pilot/contracts.cases.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ITEM_KINDS,
  EVIDENCE_RELATIONS,
  validateCase,
  validateExtraction,
  makeRunKey,
  makeLocalItemKey,
} from './contracts.mjs';

function minimalCase(overrides = {}) {
  return {
    caseId: 'case-basic-001',
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'В 2019 мы переехали в другой город.',
        createdAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'Похоже, переезд был важным шагом.',
        createdAt: '2024-01-10T10:00:05.000Z',
      },
      {
        id: 'm3',
        role: 'user',
        text: 'Потом снова пришлось переезжать в 2021.',
        createdAt: '2024-01-10T10:01:00.000Z',
      },
    ],
    gold: {
      events: [
        {
          claim: 'Переезд в 2019',
          supportMessageIds: ['m1'],
        },
      ],
      recurrences: [
        {
          claim: 'Повторяющиеся переезды',
          supportMessageIds: ['m1', 'm3'],
          episodeKeys: ['ep-2019', 'ep-2021'],
        },
      ],
      hypotheses: [
        {
          claim: 'Переезды связаны с поиском опоры',
          supportMessageIds: ['m1', 'm3'],
          alternative: 'Переезды могли быть вынуждены работой',
        },
      ],
    },
    ...overrides,
  };
}

function minimalExtraction(overrides = {}) {
  return {
    run: {
      caseId: 'case-basic-001',
      extractorVersion: 'v3-offline-0.1.0',
    },
    items: [
      {
        localItemKey: 'item-event-1',
        kind: 'event',
        claim: 'Переезд в другой город в 2019',
        scope: 'conversation',
        conversationId: 'conv-1',
        eventTimeStart: '2019-01-01',
        eventTimeEnd: '2019-12-31',
        status: 'active',
        sensitivity: 'normal',
        alternative: null,
      },
    ],
    evidence: [
      {
        itemKey: 'item-event-1',
        sourceMessageId: 'm1',
        episodeKey: 'ep-2019',
        relation: 'supports',
        provenanceRole: 'user',
        mentionTime: '2024-01-10T10:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function recurrenceExtraction() {
  return {
    run: {
      caseId: 'case-basic-001',
      extractorVersion: 'v3-offline-0.1.0',
    },
    items: [
      {
        localItemKey: 'item-rec-1',
        kind: 'recurrence',
        claim: 'Повторяющиеся переезды',
        scope: 'conversation',
        conversationId: 'conv-1',
        eventTimeStart: null,
        eventTimeEnd: null,
        status: 'active',
        sensitivity: 'normal',
        alternative: null,
      },
    ],
    evidence: [
      {
        itemKey: 'item-rec-1',
        sourceMessageId: 'm1',
        episodeKey: 'ep-2019',
        relation: 'supports',
        provenanceRole: 'user',
        mentionTime: '2024-01-10T10:00:00.000Z',
      },
      {
        itemKey: 'item-rec-1',
        sourceMessageId: 'm3',
        episodeKey: 'ep-2021',
        relation: 'supports',
        provenanceRole: 'user',
        mentionTime: '2024-01-10T10:01:00.000Z',
      },
    ],
  };
}

describe('exports', () => {
  it('exposes ITEM_KINDS and EVIDENCE_RELATIONS', () => {
    assert.deepEqual([...ITEM_KINDS].sort(), ['event', 'hypothesis', 'recurrence']);
    assert.deepEqual(
      [...EVIDENCE_RELATIONS].sort(),
      ['contradicts', 'corrects', 'rejects', 'supports'],
    );
  });
});

describe('validateExtraction — happy path', () => {
  it('accepts a minimal valid extraction', () => {
    const value = minimalExtraction();
    const out = validateExtraction(value);
    assert.equal(out.run.caseId, 'case-basic-001');
    assert.equal(out.items.length, 1);
  });

  it('accepts extraction with caseData role/id checks', () => {
    const caseData = minimalCase();
    const out = validateExtraction(minimalExtraction(), caseData);
    assert.equal(out.evidence[0].sourceMessageId, 'm1');
  });

  it('accepts recurrence with two distinct user episodeKeys', () => {
    const out = validateExtraction(recurrenceExtraction(), minimalCase());
    assert.equal(out.items[0].kind, 'recurrence');
  });

  it('separates eventTime on item from mentionTime on evidence', () => {
    const value = minimalExtraction();
    assert.equal(value.items[0].eventTimeStart, '2019-01-01');
    assert.equal(value.evidence[0].mentionTime, '2024-01-10T10:00:00.000Z');
    assert.doesNotThrow(() => validateExtraction(value, minimalCase()));
  });
});

describe('validateExtraction — item rules', () => {
  it('rejects unknown kind', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          kind: 'diagnosis',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /kind/i);
  });

  it('rejects invalid status for event', () => {
    const value = minimalExtraction({
      items: [{ ...minimalExtraction().items[0], status: 'candidate' }],
    });
    assert.throws(() => validateExtraction(value), /status/i);
  });

  it('rejects invalid status for recurrence', () => {
    const base = recurrenceExtraction();
    base.items[0].status = 'supported';
    assert.throws(() => validateExtraction(base), /status/i);
  });

  it('rejects invalid status for hypothesis', () => {
    const value = {
      run: { caseId: 'c1', extractorVersion: 'v1' },
      items: [
        {
          localItemKey: 'h1',
          kind: 'hypothesis',
          claim: 'Ищет опору через перемены места',
          scope: 'cross_conversation',
          conversationId: null,
          eventTimeStart: null,
          eventTimeEnd: null,
          status: 'active',
          sensitivity: 'normal',
          alternative: 'Может быть просто смена работы',
        },
      ],
      evidence: [
        {
          itemKey: 'h1',
          sourceMessageId: 'm1',
          episodeKey: 'ep-2019',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
      ],
    };
    assert.throws(() => validateExtraction(value), /status/i);
  });

  it('rejects duplicate localItemKey', () => {
    const item = minimalExtraction().items[0];
    const value = minimalExtraction({
      items: [item, { ...item }],
      evidence: [
        {
          itemKey: item.localItemKey,
          sourceMessageId: 'm1',
          episodeKey: 'ep-2019',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /localItemKey|duplicate/i);
  });

  it('rejects mentionTime inside item', () => {
    const item = {
      ...minimalExtraction().items[0],
      mentionTime: '2024-01-10T10:00:00.000Z',
    };
    const value = minimalExtraction({ items: [item] });
    assert.throws(() => validateExtraction(value), /mentionTime/i);
  });

  it('rejects invalid ISO dates', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2019/01/01',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /ISO|date|eventTime/i);
  });

  it('rejects eventTimeStart after eventTimeEnd', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2020-01-01',
          eventTimeEnd: '2019-01-01',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /eventTime|later|after|order/i);
  });

  it('rejects hypothesis without alternative', () => {
    const value = {
      run: { caseId: 'c1', extractorVersion: 'v1' },
      items: [
        {
          localItemKey: 'h1',
          kind: 'hypothesis',
          claim: 'Ищет опору через перемены места',
          scope: 'cross_conversation',
          conversationId: null,
          eventTimeStart: null,
          eventTimeEnd: null,
          status: 'candidate',
          sensitivity: 'normal',
          alternative: null,
        },
      ],
      evidence: [
        {
          itemKey: 'h1',
          sourceMessageId: 'm1',
          episodeKey: 'ep-2019',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
      ],
    };
    assert.throws(() => validateExtraction(value), /alternative/i);
  });

  it('rejects nested reasoning / diagnosis / attachment fields', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          meta: {
            analysis: {
              chainOfThought: 'because...',
            },
          },
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /chainOfThought|forbidden|reasoning|diagnosis/i);

    const value2 = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          diagnosis: 'anxiety disorder',
        },
      ],
    });
    assert.throws(() => validateExtraction(value2), /diagnosis|forbidden/i);

    const value3 = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          nested: { attachment_style: 'avoidant' },
        },
      ],
    });
    assert.throws(() => validateExtraction(value3), /attachment|forbidden/i);
  });

  it('rejects clinical/diagnostic kind', () => {
    const value = minimalExtraction({
      items: [{ ...minimalExtraction().items[0], kind: 'clinical_label' }],
    });
    assert.throws(() => validateExtraction(value), /kind/i);
  });
});

describe('validateExtraction — evidence rules', () => {
  it('rejects evidence with unknown itemKey', () => {
    const value = minimalExtraction({
      evidence: [
        {
          itemKey: 'missing-item',
          sourceMessageId: 'm1',
          episodeKey: 'ep-2019',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /itemKey|unknown/i);
  });

  it('rejects duplicate evidence', () => {
    const ev = minimalExtraction().evidence[0];
    const value = minimalExtraction({
      evidence: [ev, { ...ev }],
    });
    assert.throws(() => validateExtraction(value), /duplicate/i);
  });

  it('rejects two supports from one source message with different episodeKeys', () => {
    const caseData = {
      caseId: 'case-basic-001',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'В 2019 мы переехали в другой город.',
          createdAt: '2024-01-10T10:00:00.000Z',
        },
      ],
      gold: { events: [], recurrences: [], hypotheses: [] },
    };
    const base = recurrenceExtraction();
    const value = {
      ...base,
      evidence: [
        {
          itemKey: 'item-rec-1',
          sourceMessageId: 'm1',
          episodeKey: 'ep-2019',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
        {
          itemKey: 'item-rec-1',
          sourceMessageId: 'm1',
          episodeKey: 'ep-2021',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
      ],
    };
    assert.throws(
      () => validateExtraction(value, caseData),
      /duplicate|sourceMessageId|evidence/i,
    );
  });

  it('rejects invalid relation', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          relation: 'mentions',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /relation/i);
  });

  it('rejects invalid provenanceRole', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          provenanceRole: 'model',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /provenanceRole/i);
  });

  it('rejects assistant supports event', () => {
    const value = minimalExtraction({
      evidence: [
        {
          itemKey: 'item-event-1',
          sourceMessageId: 'm2',
          episodeKey: 'ep-ai',
          relation: 'supports',
          provenanceRole: 'assistant',
          mentionTime: '2024-01-10T10:00:05.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value, minimalCase()), /assistant|supports/i);
  });

  it('rejects assistant supports recurrence', () => {
    const base = recurrenceExtraction();
    base.evidence.push({
      itemKey: 'item-rec-1',
      sourceMessageId: 'm2',
      episodeKey: 'ep-ai',
      relation: 'supports',
      provenanceRole: 'assistant',
      mentionTime: '2024-01-10T10:00:05.000Z',
    });
    assert.throws(() => validateExtraction(base, minimalCase()), /assistant|supports/i);
  });

  it('rejects assistant supports hypothesis', () => {
    const value = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v1' },
      items: [
        {
          localItemKey: 'h1',
          kind: 'hypothesis',
          claim: 'Ищет опору через перемены места',
          scope: 'conversation',
          conversationId: 'conv-1',
          eventTimeStart: null,
          eventTimeEnd: null,
          status: 'candidate',
          sensitivity: 'sensitive',
          alternative: 'Может быть смена работы',
        },
      ],
      evidence: [
        {
          itemKey: 'h1',
          sourceMessageId: 'm2',
          episodeKey: 'ep-ai',
          relation: 'supports',
          provenanceRole: 'assistant',
          mentionTime: '2024-01-10T10:00:05.000Z',
        },
      ],
    };
    assert.throws(() => validateExtraction(value, minimalCase()), /assistant|supports/i);
  });

  it('rejects system supports item', () => {
    const caseData = minimalCase({
      messages: [
        ...minimalCase().messages,
        {
          id: 'm-sys',
          role: 'system',
          text: 'system note',
          createdAt: '2024-01-10T09:00:00.000Z',
        },
      ],
    });
    const value = minimalExtraction({
      evidence: [
        {
          itemKey: 'item-event-1',
          sourceMessageId: 'm-sys',
          episodeKey: 'ep-sys',
          relation: 'supports',
          provenanceRole: 'system',
          mentionTime: '2024-01-10T09:00:00.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value, caseData), /system|supports/i);
  });

  it('rejects provenanceRole mismatch with caseData message role', () => {
    const value = minimalExtraction({
      evidence: [
        {
          itemKey: 'item-event-1',
          sourceMessageId: 'm2',
          episodeKey: 'ep-x',
          relation: 'contradicts',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:05.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value, minimalCase()), /provenanceRole|role/i);
  });

  it('rejects sourceMessageId missing from caseData', () => {
    const value = minimalExtraction({
      evidence: [
        {
          itemKey: 'item-event-1',
          sourceMessageId: 'm-missing',
          episodeKey: 'ep-2019',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value, minimalCase()), /sourceMessageId|not found|unknown/i);
  });

  it('rejects recurrence supported by two messages of the same episodeKey', () => {
    const base = recurrenceExtraction();
    base.evidence = [
      {
        itemKey: 'item-rec-1',
        sourceMessageId: 'm1',
        episodeKey: 'ep-same',
        relation: 'supports',
        provenanceRole: 'user',
        mentionTime: '2024-01-10T10:00:00.000Z',
      },
      {
        itemKey: 'item-rec-1',
        sourceMessageId: 'm3',
        episodeKey: 'ep-same',
        relation: 'supports',
        provenanceRole: 'user',
        mentionTime: '2024-01-10T10:01:00.000Z',
      },
    ];
    assert.throws(() => validateExtraction(base, minimalCase()), /episodeKey|recurrence/i);
  });
});

describe('validateCase', () => {
  it('accepts a valid case and returns it', () => {
    const value = minimalCase();
    const out = validateCase(value);
    assert.equal(out.caseId, 'case-basic-001');
    assert.equal(out.messages.length, 3);
  });

  it('rejects duplicate message IDs', () => {
    const value = minimalCase({
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'a',
          createdAt: '2024-01-10T10:00:00.000Z',
        },
        {
          id: 'm1',
          role: 'user',
          text: 'b',
          createdAt: '2024-01-10T10:01:00.000Z',
        },
      ],
      gold: { events: [], recurrences: [], hypotheses: [] },
    });
    assert.throws(() => validateCase(value), /duplicate|message id/i);
  });

  it('rejects gold referencing missing message', () => {
    const value = minimalCase({
      gold: {
        events: [{ claim: 'x', supportMessageIds: ['m-nope'] }],
        recurrences: [],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /supportMessageIds|message|gold/i);
  });

  it('rejects assistant-only recurrence in gold', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m2'],
            episodeKeys: ['ep-a', 'ep-b'],
          },
        ],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /recurrence|assistant|user/i);
  });
});

describe('deterministic keys', () => {
  it('makeRunKey is stable under different key order', () => {
    const a = makeRunKey({ caseId: 'c1', extractorVersion: 'v1' });
    const b = makeRunKey({ extractorVersion: 'v1', caseId: 'c1' });
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  it('makeRunKey changes when extractorVersion changes', () => {
    const a = makeRunKey({ caseId: 'c1', extractorVersion: 'v1' });
    const b = makeRunKey({ caseId: 'c1', extractorVersion: 'v2' });
    assert.notEqual(a, b);
  });

  it('makeLocalItemKey is stable for same item and index', () => {
    const item = {
      kind: 'event',
      claim: 'Переезд',
      scope: 'conversation',
      conversationId: 'conv-1',
      status: 'active',
    };
    const a = makeLocalItemKey(item, 0);
    const b = makeLocalItemKey({ status: 'active', conversationId: 'conv-1', scope: 'conversation', claim: 'Переезд', kind: 'event' }, 0);
    assert.equal(a, b);
  });

  it('makeLocalItemKey changes when index changes', () => {
    const item = {
      kind: 'event',
      claim: 'Переезд',
      scope: 'conversation',
      conversationId: 'conv-1',
      status: 'active',
    };
    assert.notEqual(makeLocalItemKey(item, 0), makeLocalItemKey(item, 1));
  });
});

describe('strict calendar dates and timezones', () => {
  it('rejects impossible calendar date 2023-02-29 on eventTimeStart', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2023-02-29',
          eventTimeEnd: null,
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /ISO|date|calendar|eventTime/i);
  });

  it('rejects impossible month 2024-13-01', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2024-13-01',
          eventTimeEnd: null,
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /ISO|date|calendar|eventTime/i);
  });

  it('rejects impossible datetime 2024-02-30T10:00:00Z', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2024-02-30T10:00:00Z',
          eventTimeEnd: null,
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /ISO|date|calendar|eventTime/i);
  });

  it('rejects impossible createdAt', () => {
    const value = minimalCase({
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'x',
          createdAt: '2023-02-29T12:00:00.000Z',
        },
      ],
      gold: { events: [], recurrences: [], hypotheses: [] },
    });
    assert.throws(() => validateCase(value), /createdAt|ISO|calendar|date/i);
  });

  it('rejects impossible mentionTime', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-02-30T10:00:00.000Z',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /mentionTime|ISO|calendar|date/i);
  });

  it('rejects datetime with space instead of T', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2024-02-29 10:00:00Z',
          eventTimeEnd: null,
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /ISO|date|eventTime|T/i);
  });

  it('accepts leap day 2024-02-29 as event date', () => {
    const value = minimalExtraction({
      items: [
        {
          ...minimalExtraction().items[0],
          eventTimeStart: '2024-02-29',
          eventTimeEnd: '2024-02-29',
        },
      ],
    });
    assert.doesNotThrow(() => validateExtraction(value, minimalCase()));
  });

  it('accepts ISO datetime with Z', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-01-10T10:00:00Z',
        },
      ],
    });
    assert.doesNotThrow(() => validateExtraction(value, minimalCase()));
  });

  it('accepts ISO datetime with explicit offset', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-01-10T13:00:00+03:00',
        },
      ],
    });
    assert.doesNotThrow(() => validateExtraction(value, minimalCase()));
  });

  it('rejects datetime with offset +14:01', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-01-10T10:00:00+14:01',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /mentionTime|ISO|offset|timezone|datetime/i);
  });

  it('rejects datetime with offset -14:59', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-01-10T10:00:00-14:59',
        },
      ],
    });
    assert.throws(() => validateExtraction(value), /mentionTime|ISO|offset|timezone|datetime/i);
  });

  it('accepts datetime with offset +14:00', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-01-10T10:00:00+14:00',
        },
      ],
    });
    assert.doesNotThrow(() => validateExtraction(value, minimalCase()));
  });

  it('accepts datetime with offset -14:00', () => {
    const value = minimalExtraction({
      evidence: [
        {
          ...minimalExtraction().evidence[0],
          mentionTime: '2024-01-10T10:00:00-14:00',
        },
      ],
    });
    assert.doesNotThrow(() => validateExtraction(value, minimalCase()));
  });
});

describe('caseId alignment', () => {
  it('rejects extraction.run.caseId mismatch with caseData.caseId', () => {
    const caseData = minimalCase({ caseId: 'case-other-999' });
    // Keep same message ids/roles as extraction expects, only caseId differs.
    const extraction = minimalExtraction();
    assert.equal(extraction.run.caseId, 'case-basic-001');
    assert.equal(caseData.caseId, 'case-other-999');
    assert.throws(
      () => validateExtraction(extraction, caseData),
      /caseId|mismatch|does not match/i,
    );
  });
});

describe('_messageById bypass prevention', () => {
  it('rejects invalid caseData even when a fake _messageById is supplied', () => {
    const bogus = {
      caseId: '',
      messages: [],
      gold: { events: [], recurrences: [], hypotheses: [] },
      _messageById: new Map([
        [
          'm1',
          {
            id: 'm1',
            role: 'user',
            text: 'spoof',
            createdAt: '2024-01-10T10:00:00.000Z',
          },
        ],
      ]),
    };
    assert.throws(() => validateExtraction(minimalExtraction(), bogus), /caseId|case\./i);
  });
});

describe('gold recurrence episodeKeys ↔ supportMessageIds', () => {
  it('rejects one user + one assistant support even with two episodeKeys', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m1', 'm2'],
            episodeKeys: ['ep-user', 'ep-ai'],
          },
        ],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /episodeKey|user|recurrence/i);
  });

  it('accepts two user supports with two distinct episodeKeys', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m1', 'm3'],
            episodeKeys: ['ep-2019', 'ep-2021'],
          },
        ],
        hypotheses: [],
      },
    });
    assert.doesNotThrow(() => validateCase(value));
  });

  it('rejects identical episodeKey for two user supports', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m1', 'm3'],
            episodeKeys: ['ep-same', 'ep-same'],
          },
        ],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /episodeKey|distinct|recurrence/i);
  });

  it('rejects mismatched lengths of supportMessageIds and episodeKeys', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m1', 'm3'],
            episodeKeys: ['ep-only-one'],
          },
        ],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /length|episodeKey|supportMessageIds/i);
  });

  it('rejects empty episodeKey string', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m1', 'm3'],
            episodeKeys: ['ep-ok', ''],
          },
        ],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /episodeKey|empty/i);
  });

  it('rejects repeated supportMessageId mapped to two episodeKeys', () => {
    const value = minimalCase({
      gold: {
        events: [],
        recurrences: [
          {
            claim: 'pattern',
            supportMessageIds: ['m1', 'm1'],
            episodeKeys: ['ep-2019', 'ep-2021'],
          },
        ],
        hypotheses: [],
      },
    });
    assert.throws(() => validateCase(value), /supportMessageId|duplicate|unique/i);
  });
});

function userEvidence(itemKey, relation, overrides = {}) {
  return {
    itemKey,
    sourceMessageId: 'm1',
    episodeKey: 'ep-2019',
    relation,
    provenanceRole: 'user',
    mentionTime: '2024-01-10T10:00:00.000Z',
    ...overrides,
  };
}

function eventItem(status, overrides = {}) {
  return {
    ...minimalExtraction().items[0],
    status,
    ...overrides,
  };
}

function recurrenceItem(status) {
  return {
    ...recurrenceExtraction().items[0],
    status,
  };
}

function hypothesisItem(status, overrides = {}) {
  return {
    localItemKey: 'h1',
    kind: 'hypothesis',
    claim: 'Возможна связь с поиском опоры',
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: null,
    eventTimeEnd: null,
    status,
    sensitivity: 'normal',
    alternative: 'Может быть смена работы',
    ...overrides,
  };
}

describe('validateExtraction — status/relation evidence contract', () => {
  it('rejects an active event without evidence', () => {
    const value = minimalExtraction({ evidence: [] });
    assert.throws(() => validateExtraction(value), /requires related evidence/);
  });

  it('rejects an active event that has only contradicts evidence', () => {
    const value = minimalExtraction({
      evidence: [userEvidence('item-event-1', 'contradicts')],
    });
    assert.throws(() => validateExtraction(value), /requires user supports evidence/);
  });

  it('accepts an active event with user supports', () => {
    assert.doesNotThrow(() => validateExtraction(minimalExtraction()));
  });

  it('rejects a corrected event without corrects evidence', () => {
    const value = minimalExtraction({
      items: [eventItem('corrected')],
      evidence: [userEvidence('item-event-1', 'supports')],
    });
    assert.throws(() => validateExtraction(value), /requires user corrects evidence/);
  });

  it('accepts a corrected event with user corrects', () => {
    const value = minimalExtraction({
      items: [eventItem('corrected')],
      evidence: [userEvidence('item-event-1', 'corrects')],
    });
    assert.doesNotThrow(() => validateExtraction(value));
  });

  it('rejects a rejected event without rejects evidence', () => {
    const value = minimalExtraction({
      items: [eventItem('rejected')],
      evidence: [userEvidence('item-event-1', 'supports')],
    });
    assert.throws(() => validateExtraction(value), /requires user rejects evidence/);
  });

  it('accepts a rejected event with user rejects', () => {
    const value = minimalExtraction({
      items: [eventItem('rejected')],
      evidence: [userEvidence('item-event-1', 'rejects')],
    });
    assert.doesNotThrow(() => validateExtraction(value));
  });

  it('rejects a candidate hypothesis without supports', () => {
    const value = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v1' },
      items: [hypothesisItem('candidate')],
      evidence: [],
    };
    assert.throws(() => validateExtraction(value), /requires related evidence/);
  });

  it('rejects a supported hypothesis without supports', () => {
    const value = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v1' },
      items: [hypothesisItem('supported')],
      evidence: [userEvidence('h1', 'contradicts')],
    };
    assert.throws(() => validateExtraction(value), /requires user supports evidence/);
  });

  it('rejects a stale hypothesis without contradicts', () => {
    const value = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v1' },
      items: [hypothesisItem('stale')],
      evidence: [userEvidence('h1', 'supports')],
    };
    assert.throws(() => validateExtraction(value), /requires user contradicts evidence/);
  });

  it('rejects a rejected hypothesis without rejects', () => {
    const value = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v1' },
      items: [hypothesisItem('rejected')],
      evidence: [userEvidence('h1', 'supports')],
    };
    assert.throws(() => validateExtraction(value), /requires user rejects evidence/);
  });

  it('rejects a stale recurrence without contradicts', () => {
    const value = {
      ...recurrenceExtraction(),
      items: [recurrenceItem('stale')],
      evidence: recurrenceExtraction().evidence,
    };
    assert.throws(() => validateExtraction(value), /requires user contradicts evidence/);
  });

  it('rejects a rejected recurrence without rejects', () => {
    const value = {
      ...recurrenceExtraction(),
      items: [recurrenceItem('rejected')],
      evidence: recurrenceExtraction().evidence,
    };
    assert.throws(() => validateExtraction(value), /requires user rejects evidence/);
  });

  it('rejects any item without related evidence', () => {
    for (const item of [
      eventItem('active'),
      recurrenceItem('active'),
      hypothesisItem('candidate'),
    ]) {
      const value = {
        run: { caseId: 'case-basic-001', extractorVersion: 'v1' },
        items: [item],
        evidence: [],
      };
      assert.throws(() => validateExtraction(value), /requires related evidence/);
    }
  });

  for (const relation of EVIDENCE_RELATIONS) {
    for (const { role, sourceMessageId, mentionTime } of [
      { role: 'assistant', sourceMessageId: 'm2', mentionTime: '2024-01-10T10:00:05.000Z' },
      { role: 'system', sourceMessageId: 'm-system', mentionTime: '2024-01-10T10:00:01.000Z' },
    ]) {
      it(`rejects ${role} ${relation} evidence`, () => {
        const caseData = minimalCase({
          messages: [
            ...minimalCase().messages,
            {
              id: 'm-system',
              role: 'system',
              text: 'system note',
              createdAt: '2024-01-10T10:00:01.000Z',
            },
          ],
        });
        const value = minimalExtraction({
          evidence: [
            userEvidence('item-event-1', 'supports'),
            {
              itemKey: 'item-event-1',
              sourceMessageId,
              episodeKey: 'ep-nonuser',
              relation,
              provenanceRole: role,
              mentionTime,
            },
          ],
        });
        assert.throws(
          () => validateExtraction(value, caseData),
          /assistant|system|provenanceRole|user/,
        );
      });
    }
  }
});

describe('validateExtraction — positive status/relation matrix', () => {
  const run = { caseId: 'case-basic-001', extractorVersion: 'v1' };
  const secondSupport = userEvidence('item-rec-1', 'supports', {
    sourceMessageId: 'm3',
    episodeKey: 'ep-2021',
    mentionTime: '2024-01-10T10:01:00.000Z',
  });

  const cases = [
    {
      name: 'event active + user supports',
      value: minimalExtraction(),
    },
    {
      name: 'event corrected + user corrects',
      value: minimalExtraction({
        items: [eventItem('corrected')],
        evidence: [userEvidence('item-event-1', 'corrects')],
      }),
    },
    {
      name: 'event rejected + user rejects',
      value: minimalExtraction({
        items: [eventItem('rejected')],
        evidence: [userEvidence('item-event-1', 'rejects')],
      }),
    },
    {
      name: 'recurrence candidate + two distinct user supports',
      value: {
        ...recurrenceExtraction(),
        items: [recurrenceItem('candidate')],
      },
    },
    {
      name: 'recurrence active + two distinct user supports',
      value: recurrenceExtraction(),
    },
    {
      name: 'recurrence stale + user contradicts without two episodeKeys',
      value: {
        run,
        items: [recurrenceItem('stale')],
        evidence: [userEvidence('item-rec-1', 'contradicts')],
      },
    },
    {
      name: 'recurrence rejected + user rejects without two episodeKeys',
      value: {
        run,
        items: [recurrenceItem('rejected')],
        evidence: [userEvidence('item-rec-1', 'rejects')],
      },
    },
    {
      name: 'hypothesis candidate + user supports',
      value: {
        run,
        items: [hypothesisItem('candidate')],
        evidence: [userEvidence('h1', 'supports')],
      },
    },
    {
      name: 'hypothesis supported + user supports',
      value: {
        run,
        items: [hypothesisItem('supported')],
        evidence: [userEvidence('h1', 'supports')],
      },
    },
    {
      name: 'hypothesis stale + user contradicts',
      value: {
        run,
        items: [hypothesisItem('stale')],
        evidence: [userEvidence('h1', 'contradicts')],
      },
    },
    {
      name: 'hypothesis rejected + user rejects',
      value: {
        run,
        items: [hypothesisItem('rejected')],
        evidence: [userEvidence('h1', 'rejects')],
      },
    },
  ];

  for (const entry of cases) {
    it(`accepts ${entry.name}`, () => {
      assert.doesNotThrow(() => validateExtraction(entry.value));
    });
  }

  it('accepts extra user relations when the required relation is present', () => {
    const value = minimalExtraction({
      evidence: [
        userEvidence('item-event-1', 'supports'),
        userEvidence('item-event-1', 'corrects', {
          sourceMessageId: 'm3',
          episodeKey: 'ep-2021',
          mentionTime: '2024-01-10T10:01:00.000Z',
        }),
      ],
    });
    assert.doesNotThrow(() => validateExtraction(value));
  });

  it('accepts empty items and evidence as abstention', () => {
    assert.doesNotThrow(() =>
      validateExtraction({
        run,
        items: [],
        evidence: [],
      }),
    );
  });

  it('still requires two distinct user episodeKeys for recurrence candidate and active', () => {
    const oneEpisode = {
      run,
      items: [recurrenceItem('candidate')],
      evidence: [userEvidence('item-rec-1', 'supports')],
    };
    assert.throws(() => validateExtraction(oneEpisode), /episodeKey|recurrence/);
    const activeOneEpisode = {
      run,
      items: [recurrenceItem('active')],
      evidence: [userEvidence('item-rec-1', 'supports'), secondSupport],
    };
    activeOneEpisode.evidence[1] = userEvidence('item-rec-1', 'supports', {
      sourceMessageId: 'm3',
      episodeKey: 'ep-2019',
      mentionTime: '2024-01-10T10:01:00.000Z',
    });
    assert.throws(() => validateExtraction(activeOneEpisode), /episodeKey|recurrence/);
  });
});
