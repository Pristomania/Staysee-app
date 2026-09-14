/**
 * Memory V3 V2 contract tests. Production module is imported only after RED.
 * Run: node --test scripts/memory-v3-pilot/contracts-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_RELATIONS,
  ITEM_KINDS,
  validateCase,
  validateExtraction,
} from './contracts.mjs';
import {
  V2_ADAPTER_EVIDENCE_FIELDS,
  V2_GOLD_TIERS,
  V2_SUPPORT_TYPES,
  goldItemsV2,
  validateCaseV2,
  validateExtractionV2,
} from './contracts-v2.mjs';

const CONTRACT_PREFIX = '[memory-v3:v2-contract]';
const MENTION = {
  m1: '2024-01-10T10:00:00.000Z',
  m2: '2024-01-10T10:01:00.000Z',
  m3: '2024-01-10T10:02:00.000Z',
  m4: '2024-01-10T10:03:00.000Z',
  mA: '2024-01-10T10:00:05.000Z',
  mS: '2024-01-10T10:00:01.000Z',
};

function emptyGold() {
  return {
    required: { events: [], recurrences: [], hypotheses: [] },
    acceptable: { events: [], recurrences: [], hypotheses: [] },
  };
}

function v2Case(overrides = {}) {
  return {
    caseId: 'case-v2-001',
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'Первый эпизод.',
        createdAt: MENTION.m1,
      },
      {
        id: 'm2',
        role: 'user',
        text: 'Второй эпизод.',
        createdAt: MENTION.m2,
      },
      {
        id: 'm3',
        role: 'user',
        text: 'Позже подтвердила паттерн.',
        createdAt: MENTION.m3,
      },
      {
        id: 'm4',
        role: 'user',
        text: 'Иногда только в группе.',
        createdAt: MENTION.m4,
      },
      {
        id: 'mA',
        role: 'assistant',
        text: 'Контекст ассистента.',
        createdAt: MENTION.mA,
      },
      {
        id: 'mS',
        role: 'system',
        text: 'Системный контекст.',
        createdAt: MENTION.mS,
      },
    ],
    gold: emptyGold(),
    ...overrides,
  };
}

function goldRecurrence(goldItemId, extra = {}) {
  return {
    goldItemId,
    claim: extra.claim ?? 'Повторяющееся поведение',
    supportMessageIds: extra.supportMessageIds ?? ['m1', 'm2'],
    supportTypes: extra.supportTypes ?? ['episode_observation', 'episode_observation'],
    episodeKeys: extra.episodeKeys ?? ['episode:m1', 'episode:m2'],
    correctedMessageIds: extra.correctedMessageIds ?? [],
    contradictedMessageIds: extra.contradictedMessageIds ?? [],
    rejectedMessageIds: extra.rejectedMessageIds ?? [],
    status: extra.status ?? null,
    sensitivity: extra.sensitivity ?? null,
    eventTimeStart: extra.eventTimeStart ?? null,
    eventTimeEnd: extra.eventTimeEnd ?? null,
    alternative: extra.alternative ?? null,
  };
}

function goldEvent(goldItemId, extra = {}) {
  return {
    goldItemId,
    claim: extra.claim ?? 'Синтетическое событие',
    supportMessageIds: extra.supportMessageIds ?? ['m1'],
    ...extra,
  };
}

function goldHypothesis(goldItemId, extra = {}) {
  return {
    goldItemId,
    claim: extra.claim ?? 'Синтетическая гипотеза',
    supportMessageIds: extra.supportMessageIds ?? ['m1'],
    alternative: extra.alternative ?? 'Синтетическая альтернатива',
    mustNotBeFact: true,
    ...extra,
  };
}

function assertNoOwnTypedGoldFields(entry) {
  assert.equal(Object.hasOwn(entry, 'supportTypes'), false);
  assert.equal(Object.hasOwn(entry, 'episodeKeys'), false);
}

function withGold(tier, kindList, entries) {
  const gold = emptyGold();
  gold[tier][kindList] = entries;
  return v2Case({ gold });
}

function eventItem(extra = {}) {
  return {
    localItemKey: extra.localItemKey ?? 'item-event-1',
    kind: 'event',
    claim: extra.claim ?? 'Синтетическое событие',
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: extra.eventTimeStart ?? null,
    eventTimeEnd: extra.eventTimeEnd ?? null,
    status: extra.status ?? 'active',
    sensitivity: extra.sensitivity ?? 'normal',
    alternative: extra.alternative ?? null,
  };
}

function recurrenceItem(extra = {}) {
  return {
    localItemKey: extra.localItemKey ?? 'item-recurrence-1',
    kind: 'recurrence',
    claim: extra.claim ?? 'Синтетическое повторение',
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: extra.eventTimeStart ?? null,
    eventTimeEnd: extra.eventTimeEnd ?? null,
    status: extra.status ?? 'active',
    sensitivity: extra.sensitivity ?? 'normal',
    alternative: extra.alternative ?? null,
  };
}

function hypothesisItem(extra = {}) {
  return {
    localItemKey: extra.localItemKey ?? 'item-hypothesis-1',
    kind: 'hypothesis',
    claim: extra.claim ?? 'Синтетическая гипотеза',
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: extra.eventTimeStart ?? null,
    eventTimeEnd: extra.eventTimeEnd ?? null,
    status: extra.status ?? 'rejected',
    sensitivity: extra.sensitivity ?? 'normal',
    alternative: extra.alternative ?? 'Синтетическая альтернатива',
  };
}

function evidenceRow(extra) {
  return {
    itemKey: extra.itemKey,
    sourceMessageId: extra.sourceMessageId,
    episodeKey: extra.episodeKey,
    relation: extra.relation ?? 'supports',
    supportType: extra.supportType,
    provenanceRole: extra.provenanceRole ?? 'user',
    mentionTime: extra.mentionTime ?? MENTION[extra.sourceMessageId] ?? MENTION.m1,
  };
}

function twoObservationEvidence(itemKey) {
  return [
    evidenceRow({
      itemKey,
      sourceMessageId: 'm1',
      episodeKey: 'episode:m1',
      supportType: 'episode_observation',
    }),
    evidenceRow({
      itemKey,
      sourceMessageId: 'm2',
      episodeKey: 'episode:m2',
      supportType: 'episode_observation',
    }),
  ];
}

function v2Extraction(items, evidence, extra = {}) {
  return {
    run: {
      caseId: extra.caseId ?? 'case-v2-001',
      extractorVersion: extra.extractorVersion ?? 'memory-v3-v2-test',
    },
    items,
    evidence,
  };
}

function recurrenceExtraction(evidenceExtra = []) {
  return v2Extraction(
    [recurrenceItem()],
    [...twoObservationEvidence('item-recurrence-1'), ...evidenceExtra],
  );
}

function assertV2ContractError(fn, { leakNeedles = [] } = {}) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown instanceof Error, true);
  assert.equal(thrown.message.startsWith(CONTRACT_PREFIX), true, thrown?.message);
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  for (const needle of leakNeedles) {
    assert.equal(thrown.message.includes(needle), false, thrown.message);
  }
}

describe('V2 exports', () => {
  it('freezes support types, adapter evidence fields, and gold tiers', () => {
    assert.deepEqual(
      [...V2_SUPPORT_TYPES],
      ['episode_observation', 'pattern_confirmation', 'scope_boundary'],
    );
    assert.deepEqual(
      [...V2_ADAPTER_EVIDENCE_FIELDS],
      ['itemRef', 'sourceMessageId', 'relation', 'supportType', 'episodeKey'],
    );
    assert.deepEqual([...V2_GOLD_TIERS], ['required', 'acceptable']);
    assert.equal(Object.isFrozen(V2_SUPPORT_TYPES), true);
    assert.equal(Object.isFrozen(V2_ADAPTER_EVIDENCE_FIELDS), true);
    assert.equal(Object.isFrozen(V2_GOLD_TIERS), true);
    assert.deepEqual([...ITEM_KINDS].sort(), ['event', 'hypothesis', 'recurrence']);
    assert.deepEqual(
      [...EVIDENCE_RELATIONS].sort(),
      ['contradicts', 'corrects', 'rejects', 'supports'],
    );
  });
});

describe('validateExtractionV2 — evidence matrix accept', () => {
  it('1 accepts recurrence supports with episode_observation and non-empty episodeKey', () => {
    const out = validateExtractionV2(recurrenceExtraction(), v2Case());
    assert.equal(out.items[0].kind, 'recurrence');
    assert.equal(out.evidence[0].supportType, 'episode_observation');
    assert.equal(out.evidence[0].episodeKey, 'episode:m1');
  });

  it('2 accepts pattern_confirmation with null episodeKey when two observations exist', () => {
    const extraction = recurrenceExtraction([
      evidenceRow({
        itemKey: 'item-recurrence-1',
        sourceMessageId: 'm3',
        episodeKey: null,
        supportType: 'pattern_confirmation',
      }),
    ]);
    const out = validateExtractionV2(extraction, v2Case());
    assert.equal(out.evidence[2].supportType, 'pattern_confirmation');
    assert.equal(out.evidence[2].episodeKey, null);
  });

  it('3 accepts scope_boundary with null episodeKey when two observations exist', () => {
    const extraction = recurrenceExtraction([
      evidenceRow({
        itemKey: 'item-recurrence-1',
        sourceMessageId: 'm4',
        episodeKey: null,
        supportType: 'scope_boundary',
      }),
    ]);
    const out = validateExtractionV2(extraction, v2Case());
    assert.equal(out.evidence[2].supportType, 'scope_boundary');
    assert.equal(out.evidence[2].episodeKey, null);
  });

  it('4 accepts event supports with supportType null and non-empty episodeKey', () => {
    const extraction = v2Extraction(
      [eventItem()],
      [
        evidenceRow({
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          supportType: null,
        }),
      ],
    );
    const out = validateExtractionV2(extraction, v2Case());
    assert.equal(out.evidence[0].supportType, null);
    assert.equal(out.evidence[0].episodeKey, 'episode:m1');
  });

  it('5 accepts hypothesis rejects with supportType null and non-empty episodeKey', () => {
    const extraction = v2Extraction(
      [hypothesisItem({ status: 'rejected' })],
      [
        evidenceRow({
          itemKey: 'item-hypothesis-1',
          sourceMessageId: 'm2',
          episodeKey: 'episode:m2',
          relation: 'rejects',
          supportType: null,
        }),
      ],
    );
    const out = validateExtractionV2(extraction, v2Case());
    assert.equal(out.items[0].status, 'rejected');
    assert.equal(out.evidence[0].relation, 'rejects');
    assert.equal(out.evidence[0].supportType, null);
  });

  it('6 accepts mixed event plus hypothesis extraction', () => {
    const extraction = v2Extraction(
      [
        eventItem(),
        hypothesisItem({
          localItemKey: 'item-hypothesis-1',
          status: 'supported',
        }),
      ],
      [
        evidenceRow({
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          supportType: null,
        }),
        evidenceRow({
          itemKey: 'item-hypothesis-1',
          sourceMessageId: 'm2',
          episodeKey: 'episode:m2',
          supportType: null,
        }),
      ],
    );
    const out = validateExtractionV2(extraction, v2Case());
    assert.equal(out.items.map((item) => item.kind).join(','), 'event,hypothesis');
  });
});

describe('validateExtractionV2 — evidence matrix reject', () => {
  it('7 rejects episode_observation with null episodeKey', () => {
    const extraction = v2Extraction(
      [recurrenceItem()],
      [
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm1',
          episodeKey: null,
          supportType: 'episode_observation',
        }),
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm2',
          episodeKey: 'episode:m2',
          supportType: 'episode_observation',
        }),
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('8 rejects pattern_confirmation with non-null episodeKey', () => {
    const extraction = recurrenceExtraction([
      evidenceRow({
        itemKey: 'item-recurrence-1',
        sourceMessageId: 'm3',
        episodeKey: 'episode:m3',
        supportType: 'pattern_confirmation',
      }),
    ]);
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('9 rejects scope_boundary with non-null episodeKey', () => {
    const extraction = recurrenceExtraction([
      evidenceRow({
        itemKey: 'item-recurrence-1',
        sourceMessageId: 'm4',
        episodeKey: 'episode:m4',
        supportType: 'scope_boundary',
      }),
    ]);
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('10 rejects missing supportType field', () => {
    const extraction = v2Extraction(
      [eventItem({ claim: 'LEAK_CLAIM_SENTINEL' })],
      [
        {
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          relation: 'supports',
          provenanceRole: 'user',
          mentionTime: MENTION.m1,
        },
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()), {
      leakNeedles: ['LEAK_CLAIM_SENTINEL', 'Первый эпизод.'],
    });
  });

  it('11 rejects unknown supportType', () => {
    const extraction = v2Extraction(
      [eventItem()],
      [
        evidenceRow({
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          supportType: 'episode_note',
        }),
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('12 rejects unknown evidence field', () => {
    const row = evidenceRow({
      itemKey: 'item-event-1',
      sourceMessageId: 'm1',
      episodeKey: 'episode:m1',
      supportType: null,
    });
    row.raw = 'nope';
    const extraction = v2Extraction([eventItem()], [row]);
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('13 rejects missing closed evidence field', () => {
    const extraction = v2Extraction(
      [eventItem()],
      [
        {
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          relation: 'supports',
          supportType: null,
          provenanceRole: 'user',
          mentionTime: MENTION.m1,
        },
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('14 rejects assistant evidence for every relation', () => {
    const cases = [
      {
        item: eventItem({ status: 'active' }),
        relation: 'supports',
        supportType: null,
      },
      {
        item: recurrenceItem({ status: 'stale' }),
        relation: 'contradicts',
        supportType: null,
      },
      {
        item: eventItem({ status: 'corrected' }),
        relation: 'corrects',
        supportType: null,
      },
      {
        item: eventItem({ status: 'rejected' }),
        relation: 'rejects',
        supportType: null,
      },
    ];
    for (const fixture of cases) {
      const extraction = v2Extraction(
        [fixture.item],
        [
          evidenceRow({
            itemKey: fixture.item.localItemKey,
            sourceMessageId: 'mA',
            episodeKey: 'episode:m1',
            relation: fixture.relation,
            supportType: fixture.supportType,
            provenanceRole: 'assistant',
            mentionTime: MENTION.mA,
          }),
        ],
      );
      assertV2ContractError(() => validateExtractionV2(extraction, v2Case()), {
        leakNeedles: ['Контекст ассистента.'],
      });
    }
  });

  it('15 rejects system evidence', () => {
    const extraction = v2Extraction(
      [eventItem()],
      [
        evidenceRow({
          itemKey: 'item-event-1',
          sourceMessageId: 'mS',
          episodeKey: 'episode:m1',
          supportType: null,
          provenanceRole: 'system',
          mentionTime: MENTION.mS,
        }),
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()), {
      leakNeedles: ['Системный контекст.'],
    });
  });

  it('16 rejects one episode_observation plus only confirmation and boundary rows', () => {
    const extraction = v2Extraction(
      [recurrenceItem({ status: 'active' })],
      [
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          supportType: 'episode_observation',
        }),
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm3',
          episodeKey: null,
          supportType: 'pattern_confirmation',
        }),
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm4',
          episodeKey: null,
          supportType: 'scope_boundary',
        }),
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('17 rejects two supports that share one real episodeKey', () => {
    const extraction = v2Extraction(
      [recurrenceItem()],
      [
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:shared',
          supportType: 'episode_observation',
        }),
        evidenceRow({
          itemKey: 'item-recurrence-1',
          sourceMessageId: 'm2',
          episodeKey: 'episode:shared',
          supportType: 'episode_observation',
        }),
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });

  it('18 rejects duplicate evidence itemKey sourceMessageId relation', () => {
    const extraction = v2Extraction(
      [eventItem()],
      [
        evidenceRow({
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          supportType: null,
        }),
        evidenceRow({
          itemKey: 'item-event-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:other',
          supportType: null,
        }),
      ],
    );
    assertV2ContractError(() => validateExtractionV2(extraction, v2Case()));
  });
});

describe('validateCaseV2 — gold tiers', () => {
  it('19 accepts empty required and acceptable lists', () => {
    const out = validateCaseV2(v2Case());
    assert.equal(out.caseId, 'case-v2-001');
    assert.equal(out.gold.required.events.length, 0);
    assert.equal(out.gold.acceptable.hypotheses.length, 0);
  });

  it('20 rejects missing or empty goldItemId', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'events', [
          { claim: 'Событие без идентификатора', supportMessageIds: ['m1'] },
        ]),
      ),
    );
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'events', [
          { goldItemId: '', claim: 'Событие', supportMessageIds: ['m1'] },
        ]),
      ),
    );
  });

  it('21 rejects duplicate goldItemId across tiers', () => {
    const gold = emptyGold();
    gold.required.events = [
      { goldItemId: 'shared-id', claim: 'Первое', supportMessageIds: ['m1'] },
    ];
    gold.acceptable.events = [
      { goldItemId: 'shared-id', claim: 'Второе', supportMessageIds: ['m2'] },
    ];
    assertV2ContractError(() => validateCaseV2(v2Case({ gold })));
  });

  it('22 rejects exact canonical duplicate between required and acceptable', () => {
    const gold = emptyGold();
    gold.required.events = [
      { goldItemId: 'required-event-01', claim: 'Одно событие', supportMessageIds: ['m1'] },
    ];
    gold.acceptable.events = [
      { goldItemId: 'acceptable-event-01', claim: 'Одно событие', supportMessageIds: ['m1'] },
    ];
    assertV2ContractError(() => validateCaseV2(v2Case({ gold })));
  });

  it('A rejects exact structural duplicate inside required with distinct goldItemId', () => {
    const gold = emptyGold();
    gold.required.events = [
      {
        goldItemId: 'required-event-01',
        claim: 'Один факт',
        supportMessageIds: ['m1'],
      },
      {
        goldItemId: 'required-event-02',
        claim: 'Один факт',
        supportMessageIds: ['m1'],
      },
    ];
    assertV2ContractError(() => validateCaseV2(v2Case({ gold })), {
      leakNeedles: ['Один факт', 'required-event-01', 'required-event-02', 'Первый эпизод.'],
    });
  });

  it('B rejects exact structural duplicate inside acceptable with distinct goldItemId', () => {
    const gold = emptyGold();
    gold.acceptable.events = [
      {
        goldItemId: 'acceptable-event-01',
        claim: 'Один факт',
        supportMessageIds: ['m1'],
      },
      {
        goldItemId: 'acceptable-event-02',
        claim: 'Один факт',
        supportMessageIds: ['m1'],
      },
    ];
    assertV2ContractError(() => validateCaseV2(v2Case({ gold })), {
      leakNeedles: ['Один факт', 'acceptable-event-01', 'acceptable-event-02'],
    });
  });

  it('C accepts same claim when support ids or episode partition differ inside one tier', () => {
    const bySupport = emptyGold();
    bySupport.required.events = [
      { goldItemId: 'required-event-01', claim: 'Один факт', supportMessageIds: ['m1'] },
      { goldItemId: 'required-event-02', claim: 'Один факт', supportMessageIds: ['m2'] },
    ];
    assert.doesNotThrow(() => validateCaseV2(v2Case({ gold: bySupport })));

    const byPartition = emptyGold();
    byPartition.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        claim: 'Один паттерн',
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'episode_observation'],
        episodeKeys: ['g1', 'g1', 'g2'],
      }),
      goldRecurrence('required-recurrence-02', {
        claim: 'Один паттерн',
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'episode_observation'],
        episodeKeys: ['x', 'y', 'y'],
      }),
    ];
    assert.doesNotThrow(() => validateCaseV2(v2Case({ gold: byPartition })));
  });

  it('D accepts the same claim on different kinds as not an exact structural duplicate', () => {
    const gold = emptyGold();
    gold.required.events = [
      { goldItemId: 'required-event-01', claim: 'Один факт', supportMessageIds: ['m1'] },
    ];
    gold.required.hypotheses = [
      {
        goldItemId: 'required-hypothesis-01',
        claim: 'Один факт',
        supportMessageIds: ['m1'],
        alternative: 'Альтернатива',
        mustNotBeFact: true,
      },
    ];
    assert.doesNotThrow(() => validateCaseV2(v2Case({ gold })));
  });

  it('23 rejects required recurrence with one episode observation', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'recurrences', [
          goldRecurrence('required-recurrence-01', {
            supportMessageIds: ['m1'],
            supportTypes: ['episode_observation'],
            episodeKeys: ['episode:m1'],
          }),
        ]),
      ),
    );
  });

  it('24 rejects acceptable recurrence with one episode observation', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('acceptable', 'recurrences', [
          goldRecurrence('acceptable-recurrence-01', {
            supportMessageIds: ['m1'],
            supportTypes: ['episode_observation'],
            episodeKeys: ['episode:m1'],
          }),
        ]),
      ),
    );
  });

  it('25 rejects recurrence supportTypes or episodeKeys length mismatch', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'recurrences', [
          goldRecurrence('required-recurrence-01', {
            supportMessageIds: ['m1', 'm2'],
            supportTypes: ['episode_observation'],
            episodeKeys: ['episode:m1', 'episode:m2'],
          }),
        ]),
      ),
    );
  });

  it('26 rejects confirmation or boundary gold episodeKey that is not null', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'recurrences', [
          goldRecurrence('required-recurrence-01', {
            supportMessageIds: ['m1', 'm2', 'm3'],
            supportTypes: [
              'episode_observation',
              'episode_observation',
              'pattern_confirmation',
            ],
            episodeKeys: ['episode:m1', 'episode:m2', 'episode:m3'],
          }),
        ]),
      ),
    );
  });

  it('27 rejects gold supportMessageId on assistant or system', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'events', [
          {
            goldItemId: 'required-event-01',
            claim: 'Событие',
            supportMessageIds: ['mA'],
          },
        ]),
      ),
    );
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'events', [
          {
            goldItemId: 'required-event-01',
            claim: 'Событие',
            supportMessageIds: ['mS'],
          },
        ]),
      ),
    );
  });

  it('28 goldItemsV2 returns required before acceptable and keeps tier kind goldItemId', () => {
    const gold = emptyGold();
    gold.required.events = [
      { goldItemId: 'required-event-01', claim: 'Событие A', supportMessageIds: ['m1'] },
    ];
    gold.required.hypotheses = [
      {
        goldItemId: 'required-hypothesis-01',
        claim: 'Гипотеза',
        supportMessageIds: ['m1'],
        alternative: 'Альтернатива',
        mustNotBeFact: true,
      },
    ];
    gold.acceptable.events = [
      { goldItemId: 'acceptable-event-01', claim: 'Событие B', supportMessageIds: ['m2'] },
    ];
    gold.acceptable.recurrences = [goldRecurrence('acceptable-recurrence-01')];
    const items = goldItemsV2(v2Case({ gold }));
    assert.deepEqual(
      items.map((item) => [item.tier, item.kind, item.goldItemId, item.index]),
      [
        ['required', 'event', 'required-event-01', 0],
        ['required', 'hypothesis', 'required-hypothesis-01', 0],
        ['acceptable', 'event', 'acceptable-event-01', 0],
        ['acceptable', 'recurrence', 'acceptable-recurrence-01', 0],
      ],
    );
  });

  it('29 duplicate fingerprint uses episode partition equivalence not literal episodeKey labels', () => {
    const gold = emptyGold();
    gold.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        claim: 'Один паттерн',
        episodeKeys: ['opaque-a', 'opaque-b'],
      }),
    ];
    gold.acceptable.recurrences = [
      goldRecurrence('acceptable-recurrence-01', {
        claim: 'Один паттерн',
        episodeKeys: ['episode:m1', 'episode:m2'],
      }),
    ];
    assertV2ContractError(() => validateCaseV2(v2Case({ gold })));
  });

  it('30 exact structural duplicate uses the full fingerprint and ignores semantic paraphrase', () => {
    const gold = emptyGold();
    gold.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        claim: '  Паттерн  ',
        sensitivity: 'sensitive',
      }),
    ];
    gold.acceptable.recurrences = [
      goldRecurrence('acceptable-recurrence-01', {
        claim: 'Паттерн',
        sensitivity: 'sensitive',
      }),
    ];
    assertV2ContractError(() => validateCaseV2(v2Case({ gold })));

    const paraphrase = emptyGold();
    paraphrase.required.recurrences = [
      goldRecurrence('required-recurrence-01', { claim: 'Паттерн один' }),
    ];
    paraphrase.acceptable.recurrences = [
      goldRecurrence('acceptable-recurrence-01', { claim: 'Паттерн другой' }),
    ];
    assert.doesNotThrow(() => validateCaseV2(v2Case({ gold: paraphrase })));

    const differentPartition = emptyGold();
    differentPartition.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        claim: 'Паттерн',
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'episode_observation'],
        episodeKeys: ['g1', 'g1', 'g2'],
      }),
    ];
    differentPartition.acceptable.recurrences = [
      goldRecurrence('acceptable-recurrence-01', {
        claim: 'Паттерн',
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'episode_observation'],
        episodeKeys: ['x', 'y', 'y'],
      }),
    ];
    assert.doesNotThrow(() => validateCaseV2(v2Case({ gold: differentPartition })));
  });
});

describe('validateCaseV2 — idempotence of normalized gold', () => {
  it('A revalidates event gold without own supportTypes or episodeKeys', () => {
    const raw = withGold('required', 'events', [goldEvent('required-event-01')]);
    const snapshot = structuredClone(raw);
    const first = validateCaseV2(raw);
    const second = validateCaseV2(first);
    assert.deepEqual(second, first);
    assertNoOwnTypedGoldFields(first.gold.required.events[0]);
    assertNoOwnTypedGoldFields(second.gold.required.events[0]);
    assert.deepEqual(raw, snapshot);
  });

  it('B revalidates hypothesis gold without own supportTypes or episodeKeys', () => {
    const raw = withGold('required', 'hypotheses', [goldHypothesis('required-hypothesis-01')]);
    const snapshot = structuredClone(raw);
    const first = validateCaseV2(raw);
    const second = validateCaseV2(first);
    assert.deepEqual(second, first);
    assertNoOwnTypedGoldFields(first.gold.required.hypotheses[0]);
    assertNoOwnTypedGoldFields(second.gold.required.hypotheses[0]);
    assert.deepEqual(raw, snapshot);
  });

  it('C revalidates recurrence gold and keeps typed arrays unchanged', () => {
    const typed = goldRecurrence('required-recurrence-01', {
      supportMessageIds: ['m1', 'm2', 'm3', 'm4'],
      supportTypes: [
        'episode_observation',
        'episode_observation',
        'pattern_confirmation',
        'scope_boundary',
      ],
      episodeKeys: ['episode:m1', 'episode:m2', null, null],
    });
    const raw = withGold('required', 'recurrences', [typed]);
    const snapshot = structuredClone(raw);
    const first = validateCaseV2(raw);
    const second = validateCaseV2(first);
    assert.deepEqual(second, first);
    assert.deepEqual(first.gold.required.recurrences[0].supportTypes, typed.supportTypes);
    assert.deepEqual(first.gold.required.recurrences[0].episodeKeys, typed.episodeKeys);
    assert.deepEqual(raw, snapshot);
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'recurrences', [
          goldRecurrence('required-recurrence-01', {
            supportMessageIds: ['m1'],
            supportTypes: ['episode_observation'],
            episodeKeys: ['episode:m1'],
          }),
        ]),
      ),
    );
  });

  it('D revalidates a mixed required and acceptable case without mutating raw input', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01', { claim: 'Событие required' })];
    gold.required.recurrences = [goldRecurrence('required-recurrence-01')];
    gold.required.hypotheses = [
      goldHypothesis('required-hypothesis-01', { claim: 'Гипотеза required' }),
    ];
    gold.acceptable.events = [
      goldEvent('acceptable-event-01', { claim: 'Событие acceptable', supportMessageIds: ['m2'] }),
    ];
    gold.acceptable.hypotheses = [
      goldHypothesis('acceptable-hypothesis-01', {
        claim: 'Гипотеза acceptable',
        supportMessageIds: ['m2'],
      }),
    ];
    const raw = v2Case({ gold });
    const snapshot = structuredClone(raw);
    const first = validateCaseV2(raw);
    const second = validateCaseV2(first);
    assert.deepEqual(second, first);
    assert.deepEqual(
      goldItemsV2(first).map((item) => [item.tier, item.kind, item.goldItemId]),
      [
        ['required', 'event', 'required-event-01'],
        ['required', 'recurrence', 'required-recurrence-01'],
        ['required', 'hypothesis', 'required-hypothesis-01'],
        ['acceptable', 'event', 'acceptable-event-01'],
        ['acceptable', 'hypothesis', 'acceptable-hypothesis-01'],
      ],
    );
    assertNoOwnTypedGoldFields(first.gold.required.events[0]);
    assertNoOwnTypedGoldFields(first.gold.required.hypotheses[0]);
    assert.deepEqual(first.gold.required.recurrences[0].supportTypes, [
      'episode_observation',
      'episode_observation',
    ]);
    assert.deepEqual(raw, snapshot);
  });

  it('still rejects raw non-recurrence gold that carries supportTypes or episodeKeys', () => {
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'events', [
          goldEvent('required-event-01', { supportTypes: [] }),
        ]),
      ),
    );
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'events', [
          goldEvent('required-event-01', { episodeKeys: [] }),
        ]),
      ),
    );
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'hypotheses', [
          goldHypothesis('required-hypothesis-01', { supportTypes: [] }),
        ]),
      ),
    );
    assertV2ContractError(() =>
      validateCaseV2(
        withGold('required', 'hypotheses', [
          goldHypothesis('required-hypothesis-01', { episodeKeys: [] }),
        ]),
      ),
    );
  });
});

describe('V1 freeze', () => {
  it('31 validateCase still accepts an existing V1 golden fixture', async () => {
    const goldenPath = fileURLToPath(
      new URL('./memory-v3-ru-golden.v1.json', import.meta.url),
    );
    const dataset = JSON.parse(await readFile(goldenPath, 'utf8'));
    const first = dataset.cases[0];
    const out = validateCase(first);
    assert.equal(out.caseId, first.caseId);
    assert.equal(Array.isArray(out.gold.events), true);
  });

  it('32 V1 validateExtraction still rejects V2 typed evidence', () => {
    const v1Case = {
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
      gold: { events: [], recurrences: [], hypotheses: [] },
    };
    const v2Shaped = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v3-offline-0.1.0' },
      items: [recurrenceItem({ localItemKey: 'item-rec-1', claim: 'Повторяющиеся переезды' })],
      evidence: [
        {
          itemKey: 'item-rec-1',
          sourceMessageId: 'm1',
          episodeKey: 'ep-2019',
          relation: 'supports',
          supportType: 'episode_observation',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:00:00.000Z',
        },
        {
          itemKey: 'item-rec-1',
          sourceMessageId: 'm3',
          episodeKey: null,
          relation: 'supports',
          supportType: 'pattern_confirmation',
          provenanceRole: 'user',
          mentionTime: '2024-01-10T10:01:00.000Z',
        },
      ],
    };
    assert.throws(() => validateExtraction(v2Shaped, v1Case), /episodeKey|non-empty|must be/i);
  });

  it('33 V1 exports and a V1 extraction without supportType still work', () => {
    const v1Case = {
      caseId: 'case-basic-001',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'В 2019 мы переехали в другой город.',
          createdAt: '2024-01-10T10:00:00.000Z',
        },
        {
          id: 'm3',
          role: 'user',
          text: 'Потом снова пришлось переезжать в 2021.',
          createdAt: '2024-01-10T10:01:00.000Z',
        },
      ],
      gold: { events: [], recurrences: [], hypotheses: [] },
    };
    const extraction = {
      run: { caseId: 'case-basic-001', extractorVersion: 'v3-offline-0.1.0' },
      items: [
        {
          localItemKey: 'item-event-1',
          kind: 'event',
          claim: 'Переезд в другой город в 2019',
          scope: 'cross_conversation',
          conversationId: null,
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
    };
    const out = validateExtraction(extraction, v1Case);
    assert.equal(out.items[0].kind, 'event');
    assert.equal(out.evidence[0].supportType, undefined);
  });
});
