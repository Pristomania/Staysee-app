/**
 * Memory V3 V2 evaluator tests. Production module is imported only after RED.
 * Synthetic fixtures only. No network, provider, filesystem I/O of secrets, or env.
 * Run: node --test scripts/memory-v3-pilot/evaluator-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validateExtractionV2 } from './contracts-v2.mjs';
import {
  assignPredictedToGoldV2,
  compareOverlapTotalsV2,
  evaluateCaseV2,
  evaluateDatasetV2,
  renderMarkdownReportV2,
} from './evaluator-v2.mjs';

const EXTRACTOR_VERSION = 'memory-v3-v2-eval-test';
const CONTRACT_PREFIX = '[memory-v3:v2-contract]';
const SENTINELS = Object.freeze({
  dialogue: 'RAW_DIALOGUE_SECRET_SENTINEL',
  gold: 'LEAK_GOLD_SENTINEL',
  key: 'sk-live-not-a-real-key-sentinel',
  auth: 'Authorization: Bearer eyJ-fake',
});
const MENTION = Object.freeze({
  m1: '2024-01-10T10:00:00.000Z',
  m2: '2024-01-10T10:01:00.000Z',
  m3: '2024-01-10T10:02:00.000Z',
  m4: '2024-01-10T10:03:00.000Z',
});

function emptyGold() {
  return {
    required: { events: [], recurrences: [], hypotheses: [] },
    acceptable: { events: [], recurrences: [], hypotheses: [] },
  };
}

function v2Case(overrides = {}) {
  return {
    caseId: 'eval-v2-case-01',
    title: 'Synthetic evaluator fixture',
    category: 'eval',
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: `${SENTINELS.dialogue} Синтетический первый эпизод.`,
        createdAt: MENTION.m1,
      },
      {
        id: 'm2',
        role: 'user',
        text: 'Синтетический второй эпизод.',
        createdAt: MENTION.m2,
      },
      {
        id: 'm3',
        role: 'user',
        text: 'Синтетический третий эпизод.',
        createdAt: MENTION.m3,
      },
      {
        id: 'm4',
        role: 'user',
        text: 'Синтетический четвёртый эпизод.',
        createdAt: MENTION.m4,
      },
    ],
    gold: emptyGold(),
    ...overrides,
  };
}

function goldEvent(goldItemId, extra = {}) {
  return {
    goldItemId,
    claim: extra.claim ?? `Синтетическое событие ${goldItemId}`,
    supportMessageIds: extra.supportMessageIds ?? ['m1'],
  };
}

function goldHypothesis(goldItemId, extra = {}) {
  return {
    goldItemId,
    claim: extra.claim ?? `Синтетическая гипотеза ${goldItemId}`,
    supportMessageIds: extra.supportMessageIds ?? ['m1'],
    alternative: extra.alternative ?? 'Синтетическая альтернатива',
    mustNotBeFact: true,
  };
}

function goldRecurrence(goldItemId, extra = {}) {
  return {
    goldItemId,
    claim: extra.claim ?? 'Синтетическое повторение',
    supportMessageIds: extra.supportMessageIds ?? ['m1', 'm2'],
    supportTypes: extra.supportTypes ?? ['episode_observation', 'episode_observation'],
    episodeKeys: extra.episodeKeys ?? ['episode:m1', 'episode:m2'],
  };
}

function predictedItem(localItemKey, kind, extra = {}) {
  return {
    localItemKey,
    kind,
    claim: extra.claim ?? `Синтетический item ${localItemKey}`,
    scope: 'cross_conversation',
    conversationId: null,
    eventTimeStart: extra.eventTimeStart ?? null,
    eventTimeEnd: extra.eventTimeEnd ?? null,
    status: extra.status ?? (kind === 'hypothesis' ? 'rejected' : 'active'),
    sensitivity: 'normal',
    alternative: extra.alternative ?? (kind === 'hypothesis' ? 'Синтетическая альтернатива' : null),
  };
}

function evidenceRow(itemKey, sourceMessageId, extra = {}) {
  const supportType = extra.supportType ?? null;
  const defaultEpisodeKey =
    supportType === null || supportType === 'episode_observation'
      ? `episode:${sourceMessageId}`
      : null;
  return {
    itemKey,
    sourceMessageId,
    episodeKey: Object.prototype.hasOwnProperty.call(extra, 'episodeKey')
      ? extra.episodeKey
      : defaultEpisodeKey,
    relation: extra.relation ?? 'supports',
    supportType,
    provenanceRole: 'user',
    mentionTime: extra.mentionTime ?? MENTION[sourceMessageId],
  };
}

function extraction(caseId, items, evidence) {
  return {
    run: { caseId, extractorVersion: EXTRACTOR_VERSION },
    items,
    evidence,
  };
}

function emptyRelations() {
  return {
    supports: new Set(),
    corrects: new Set(),
    contradicts: new Set(),
    rejects: new Set(),
  };
}

function goldNode({ goldItemId, tier, kind, supports }) {
  const relations = emptyRelations();
  for (const token of supports) relations.supports.add(token);
  return { goldItemId, tier, kind, relations };
}

function predictedNode({ localItemKey, kind, supports }) {
  const relations = emptyRelations();
  for (const token of supports) relations.supports.add(token);
  return { localItemKey, kind, relations };
}

function pairSet(result) {
  return result.pairs.map((pair) => `${pair.goldItemId}:${pair.localItemKey}`).sort();
}

function ratioClose(actual, expected) {
  assert.equal(Number(actual.toFixed(10)), Number(expected.toFixed(10)));
}

function scoringCaseRequiredAcceptable(extraPredictions = []) {
  const gold = emptyGold();
  gold.required.events = [goldEvent('required-event-01', { supportMessageIds: ['m1'] })];
  gold.acceptable.events = [
    goldEvent('acceptable-event-01', {
      claim: 'Синтетическое acceptable событие',
      supportMessageIds: ['m2'],
    }),
  ];
  const caseData = v2Case({ gold });
  const items = [
    predictedItem('item-required', 'event', { claim: 'Синтетическое событие required-event-01' }),
    predictedItem('item-acceptable', 'event', { claim: 'Синтетическое acceptable событие' }),
    ...extraPredictions.map((row) => row.item),
  ];
  const evidence = [
    evidenceRow('item-required', 'm1'),
    evidenceRow('item-acceptable', 'm2'),
    ...extraPredictions.flatMap((row) => row.evidence),
  ];
  return { caseData, extraction: extraction(caseData.caseId, items, evidence) };
}

describe('compareOverlapTotalsV2 exact rationals', () => {
  it('treats 2/4 as equal to 1/2 and ranks 2/3 above 1/2', () => {
    assert.equal(compareOverlapTotalsV2({ num: 2n, den: 4n }, { num: 1n, den: 2n }), 0);
    assert.equal(compareOverlapTotalsV2({ num: 2n, den: 3n }, { num: 1n, den: 2n }), 1);
    assert.equal(compareOverlapTotalsV2({ num: 1n, den: 3n }, { num: 1n, den: 2n }), -1);
  });

  it('compares large BigInt values without Number conversion', () => {
    const left = { num: 1n, den: 9007199254740992n };
    const right = { num: 1n, den: 9007199254740993n };
    assert.equal(Number(left.den), Number(right.den));
    assert.equal(compareOverlapTotalsV2(left, right), 1);
    assert.equal(compareOverlapTotalsV2(right, left), -1);
    assert.equal(compareOverlapTotalsV2(left, left), 0);
  });

  it('rejects a zero or negative denominator', () => {
    assert.throws(() => compareOverlapTotalsV2({ num: 1n, den: 0n }, { num: 1n, den: 1n }));
    assert.throws(() => compareOverlapTotalsV2({ num: 1n, den: 1n }, { num: 1n, den: -1n }));
  });

  it('does not use IEEE float on the assignment compare path', () => {
    const source = readFileSync(new URL('./evaluator-v2.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export function compareOverlapTotalsV2');
    const end = source.indexOf('export function evaluateCaseV2');
    assert.equal(start >= 0 && end > start, true);
    const assignmentPath = source.slice(start, end);
    assert.equal(/Number\s*\(|parseFloat\s*\(|parseInt\s*\(/.test(assignmentPath), false);
  });
});

describe('assignPredictedToGoldV2 required-first global matching', () => {
  it('matches both required events and does not let acceptable steal P-x', () => {
    const goldItems = [
      goldNode({ goldItemId: 'R-A', tier: 'required', kind: 'event', supports: ['m1'] }),
      goldNode({ goldItemId: 'R-B', tier: 'required', kind: 'event', supports: ['m2'] }),
      goldNode({ goldItemId: 'A-C', tier: 'acceptable', kind: 'event', supports: ['m1'] }),
    ];
    const predictedItems = [
      predictedNode({ localItemKey: 'P-x', kind: 'event', supports: ['m1'] }),
      predictedNode({ localItemKey: 'P-y', kind: 'event', supports: ['m2'] }),
    ];
    const result = assignPredictedToGoldV2({ goldItems, predictedItems });
    assert.deepEqual(pairSet(result), ['R-A:P-x', 'R-B:P-y']);
    assert.equal(result.pairs.filter((pair) => pair.gold.tier === 'required').length, 2);
    assert.equal(result.pairs.some((pair) => pair.goldItemId === 'A-C'), false);

    const shuffled = assignPredictedToGoldV2({
      goldItems: [...goldItems].reverse(),
      predictedItems: [...predictedItems].reverse(),
    });
    assert.deepEqual(pairSet(shuffled), pairSet(result));
  });
});

describe('assignPredictedToGoldV2 acceptable cannot steal required', () => {
  it('assigns a hypothesis prediction to required hypothesis, not acceptable event', () => {
    const result = assignPredictedToGoldV2({
      goldItems: [
        goldNode({
          goldItemId: 'required-hypothesis-01',
          tier: 'required',
          kind: 'hypothesis',
          supports: ['m1'],
        }),
        goldNode({
          goldItemId: 'acceptable-event-01',
          tier: 'acceptable',
          kind: 'event',
          supports: ['m1'],
        }),
      ],
      predictedItems: [
        predictedNode({ localItemKey: 'item-h1', kind: 'hypothesis', supports: ['m1'] }),
      ],
    });
    assert.deepEqual(pairSet(result), ['required-hypothesis-01:item-h1']);
  });

  it('assigns a same-kind event prediction to required rather than acceptable', () => {
    const result = assignPredictedToGoldV2({
      goldItems: [
        goldNode({
          goldItemId: 'required-event-01',
          tier: 'required',
          kind: 'event',
          supports: ['m1'],
        }),
        goldNode({
          goldItemId: 'acceptable-event-01',
          tier: 'acceptable',
          kind: 'event',
          supports: ['m1'],
        }),
      ],
      predictedItems: [predictedNode({ localItemKey: 'item-e1', kind: 'event', supports: ['m1'] })],
    });
    assert.deepEqual(pairSet(result), ['required-event-01:item-e1']);
  });
});

describe('assignPredictedToGoldV2 pair-tuple tie-break', () => {
  it('chooses aa-gold↔item-event-1 and bb-gold↔item-event-2', () => {
    const goldItems = [
      goldNode({ goldItemId: 'bb-gold', tier: 'required', kind: 'event', supports: ['m1'] }),
      goldNode({ goldItemId: 'aa-gold', tier: 'required', kind: 'event', supports: ['m1'] }),
    ];
    const predictedItems = [
      predictedNode({ localItemKey: 'item-event-2', kind: 'event', supports: ['m1'] }),
      predictedNode({ localItemKey: 'item-event-1', kind: 'event', supports: ['m1'] }),
    ];
    const result = assignPredictedToGoldV2({ goldItems, predictedItems });
    assert.deepEqual(
      result.pairs.map((pair) => [pair.goldItemId, pair.localItemKey]),
      [
        ['aa-gold', 'item-event-1'],
        ['bb-gold', 'item-event-2'],
      ],
    );
  });
});

function compareCodeUnitStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function serializedDelimiterPairKey(pairs) {
  return [...pairs]
    .map((pair) => [pair.goldItemId, pair.localItemKey])
    .sort(
      (left, right) =>
        compareCodeUnitStrings(left[0], right[0]) || compareCodeUnitStrings(left[1], right[1]),
    )
    .map((pair) => `${pair[0]}\0${pair[1]}`)
    .join('\n');
}

function zGoldTieBreakFixture() {
  return {
    goldItems: [
      goldNode({ goldItemId: 'a-gold', tier: 'required', kind: 'event', supports: ['m1'] }),
      goldNode({ goldItemId: 'Z-gold', tier: 'required', kind: 'event', supports: ['m1'] }),
    ],
    predictedItems: [
      predictedNode({ localItemKey: 'item-2', kind: 'event', supports: ['m1'] }),
      predictedNode({ localItemKey: 'item-1', kind: 'event', supports: ['m1'] }),
    ],
  };
}

describe('assignPredictedToGoldV2 locale-independent pair-tuple ordering', () => {
  it('A ranks Z-gold before a-gold using UTF-16 code units', () => {
    assert.equal('Z-gold' < 'a-gold', true);
    const result = assignPredictedToGoldV2(zGoldTieBreakFixture());
    assert.deepEqual(
      result.pairs.map((pair) => [pair.goldItemId, pair.localItemKey]),
      [
        ['Z-gold', 'item-1'],
        ['a-gold', 'item-2'],
      ],
    );
  });

  it('B does not let delimiter serialization collapse distinct pair tuples', () => {
    const collapsedLeft = [{ goldItemId: 'a\0b', localItemKey: 'c' }];
    const collapsedRight = [{ goldItemId: 'a', localItemKey: 'b\0c' }];
    assert.equal(serializedDelimiterPairKey(collapsedLeft), serializedDelimiterPairKey(collapsedRight));
    assert.notDeepEqual(collapsedLeft, collapsedRight);
    assert.equal('a' < 'a\0b', true);

    const result = assignPredictedToGoldV2({
      goldItems: [
        goldNode({ goldItemId: 'a\0b', tier: 'required', kind: 'event', supports: ['m1'] }),
        goldNode({ goldItemId: 'a', tier: 'required', kind: 'event', supports: ['m1'] }),
      ],
      predictedItems: [predictedNode({ localItemKey: 'c', kind: 'event', supports: ['m1'] })],
    });
    assert.deepEqual(
      result.pairs.map((pair) => [pair.goldItemId, pair.localItemKey]),
      [['a', 'c']],
    );
  });

  it('C sorts returned pairs by the same code-unit comparator', () => {
    const result = assignPredictedToGoldV2(zGoldTieBreakFixture());
    const ids = result.pairs.map((pair) => pair.goldItemId);
    assert.deepEqual(ids, [...ids].sort(compareCodeUnitStrings));
    assert.deepEqual(ids, ['Z-gold', 'a-gold']);
  });

  it('does not call String.prototype.localeCompare during assignment', () => {
    const original = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare');
    let localeCalls = 0;
    try {
      Object.defineProperty(String.prototype, 'localeCompare', {
        configurable: true,
        enumerable: original ? original.enumerable : false,
        writable: true,
        value() {
          localeCalls += 1;
          throw new Error('LOCALECOMPARE_SENTINEL');
        },
      });
      const result = assignPredictedToGoldV2(zGoldTieBreakFixture());
      assert.deepEqual(
        result.pairs.map((pair) => [pair.goldItemId, pair.localItemKey]),
        [
          ['Z-gold', 'item-1'],
          ['a-gold', 'item-2'],
        ],
      );
      assert.equal(localeCalls, 0);
    } finally {
      if (original) Object.defineProperty(String.prototype, 'localeCompare', original);
      else delete String.prototype.localeCompare;
    }
  });

  it('D production source does not use localeCompare or delimiter tuple serialization', () => {
    const source = readFileSync(new URL('./evaluator-v2.mjs', import.meta.url), 'utf8');
    assert.equal(source.includes('localeCompare'), false);
    assert.equal(source.includes('canonicalTupleKey'), false);
    const start = source.indexOf('export function compareOverlapTotalsV2');
    const end = source.indexOf('export function evaluateCaseV2');
    assert.equal(start >= 0 && end > start, true);
    const assignmentPath = source.slice(start, end);
    assert.equal(/\.join\(\s*['"]\\n['"]\s*\)/.test(assignmentPath), false);
    assert.equal(assignmentPath.includes('canonicalTupleKey'), false);
  });
});

describe('assignPredictedToGoldV2 shuffle invariance', () => {
  it('keeps the pair set when gold and predicted arrays are permuted', () => {
    const goldItems = [
      goldNode({ goldItemId: 'R-A', tier: 'required', kind: 'event', supports: ['m1'] }),
      goldNode({ goldItemId: 'R-B', tier: 'required', kind: 'event', supports: ['m2'] }),
    ];
    const predictedItems = [
      predictedNode({ localItemKey: 'P-x', kind: 'event', supports: ['m1'] }),
      predictedNode({ localItemKey: 'P-y', kind: 'event', supports: ['m2'] }),
    ];
    const first = assignPredictedToGoldV2({ goldItems, predictedItems });
    const second = assignPredictedToGoldV2({
      goldItems: [goldItems[1], goldItems[0]],
      predictedItems: [predictedItems[1], predictedItems[0]],
    });
    assert.deepEqual(pairSet(first), pairSet(second));
  });
});

describe('assignPredictedToGoldV2 exact overlap ranking', () => {
  it('prefers overlap 2/3 over 1/2 when required and total counts tie', () => {
    const result = assignPredictedToGoldV2({
      goldItems: [
        goldNode({
          goldItemId: 'high-overlap',
          tier: 'required',
          kind: 'event',
          supports: ['m1', 'm2'],
        }),
        goldNode({
          goldItemId: 'low-overlap',
          tier: 'required',
          kind: 'event',
          supports: ['m1', 'm3', 'm4'],
        }),
      ],
      predictedItems: [predictedNode({ localItemKey: 'P1', kind: 'event', supports: ['m1'] })],
    });
    assert.deepEqual(pairSet(result), ['high-overlap:P1']);
  });

  it('treats equal reduced sums as equal regardless of addend order', () => {
    assert.equal(
      compareOverlapTotalsV2({ num: 2n, den: 3n }, { num: 4n, den: 6n }),
      0,
    );
  });
});

describe('assignPredictedToGoldV2 one-to-one constraint', () => {
  it('matches one prediction to one required gold and leaves the other unmatched', () => {
    const result = assignPredictedToGoldV2({
      goldItems: [
        goldNode({ goldItemId: 'G1', tier: 'required', kind: 'event', supports: ['m1'] }),
        goldNode({ goldItemId: 'G2', tier: 'required', kind: 'event', supports: ['m1'] }),
      ],
      predictedItems: [predictedNode({ localItemKey: 'P1', kind: 'event', supports: ['m1'] })],
    });
    assert.equal(result.pairs.length, 1);
    const empty = assignPredictedToGoldV2({ goldItems: [], predictedItems: [] });
    assert.deepEqual(empty.pairs, []);
  });
});

describe('typed recurrence candidate edges', () => {
  it('A rejects a contract-invalid one-observation-plus-confirmation extraction', () => {
    const gold = emptyGold();
    gold.required.recurrences = [goldRecurrence('required-recurrence-01')];
    const caseData = v2Case({ gold });
    const bad = extraction(caseData.caseId, [predictedItem('item-recurrence-1', 'recurrence')], [
      evidenceRow('item-recurrence-1', 'm1', {
        supportType: 'pattern_confirmation',
        episodeKey: null,
      }),
      evidenceRow('item-recurrence-1', 'm2', { supportType: 'episode_observation' }),
    ]);
    assert.throws(() => validateExtractionV2(bad, caseData), (error) => {
      assert.equal(String(error.message).startsWith(CONTRACT_PREFIX), true);
      return true;
    });
  });

  it('B assignment-only: incompatible supportType has no candidate edge', () => {
    const result = assignPredictedToGoldV2({
      goldItems: [
        goldNode({
          goldItemId: 'required-recurrence-01',
          tier: 'required',
          kind: 'recurrence',
          supports: ['m1\0episode_observation', 'm2\0episode_observation'],
        }),
      ],
      predictedItems: [
        predictedNode({
          localItemKey: 'item-recurrence-1',
          kind: 'recurrence',
          supports: ['m1\0pattern_confirmation'],
        }),
      ],
    });
    assert.equal(result.pairs.length, 0);
  });

  it('C1 contract-valid blocked edge is required FN with one extra FP', () => {
    const gold = emptyGold();
    gold.required.recurrences = [goldRecurrence('required-recurrence-01')];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-recurrence-1', 'recurrence')], [
        evidenceRow('item-recurrence-1', 'm3', { supportType: 'episode_observation' }),
        evidenceRow('item-recurrence-1', 'm4', { supportType: 'episode_observation' }),
      ]),
    );
    assert.equal(out.items.required.matched, 0);
    assert.equal(out.items.extraFalsePositives, 1);
    assert.equal(out.matches.length, 0);
  });

  it('C2 matches the item and scores typed supports TP2 FN1 FP1', () => {
    const gold = emptyGold();
    gold.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'pattern_confirmation'],
        episodeKeys: ['episode:m1', 'episode:m2', null],
      }),
    ];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-recurrence-1', 'recurrence')], [
        evidenceRow('item-recurrence-1', 'm1', { supportType: 'episode_observation' }),
        evidenceRow('item-recurrence-1', 'm2', { supportType: 'episode_observation' }),
        evidenceRow('item-recurrence-1', 'm3', {
          supportType: 'scope_boundary',
          episodeKey: null,
        }),
      ]),
    );
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.evidence.byRelation.supports.tp, 2);
    assert.equal(out.evidence.byRelation.supports.fn, 1);
    assert.equal(out.evidence.byRelation.supports.fp, 1);
  });
});

describe('evaluateCaseV2 required/acceptable item scoring', () => {
  it('A required plus acceptable matched, no extras', () => {
    const { caseData, extraction: ext } = scoringCaseRequiredAcceptable();
    const out = evaluateCaseV2(caseData, ext);
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.items.acceptable.matched, 1);
    assert.equal(out.items.overall.matched, 2);
    assert.equal(out.items.overall.predicted, 2);
    assert.equal(out.items.extraFalsePositives, 0);
    assert.equal(out.items.required.precision, 1);
    assert.equal(out.items.required.recall, 1);
    assert.equal(out.items.required.f1, 1);
    assert.equal(out.items.overall.precision, 1);
    assert.equal(out.items.overall.recall, 1);
    assert.equal(out.items.overall.f1, 1);
  });

  it('B required matched, acceptable omitted is not FN', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01')];
    gold.acceptable.events = [
      goldEvent('acceptable-event-01', { claim: 'Optional', supportMessageIds: ['m2'] }),
    ];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-required', 'event')], [
        evidenceRow('item-required', 'm1'),
      ]),
    );
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.items.acceptable.matched, 0);
    assert.equal(out.items.extraFalsePositives, 0);
    assert.equal(out.items.overall.precision, 1);
    assert.equal(out.items.overall.recall, 1);
    assert.equal(out.items.overall.f1, 1);
    assert.equal(out.items.required.gold, 1);
    assert.equal(out.evidence.overall.fn, 0);
  });

  it('C required plus acceptable plus one unlisted extra', () => {
    const { caseData, extraction: ext } = scoringCaseRequiredAcceptable([
      {
        item: predictedItem('item-extra', 'event', { claim: 'Unlisted extra' }),
        evidence: [evidenceRow('item-extra', 'm3')],
      },
    ]);
    const out = evaluateCaseV2(caseData, ext);
    assert.equal(out.items.overall.predicted, 3);
    assert.equal(out.items.overall.matched, 2);
    assert.equal(out.items.extraFalsePositives, 1);
    assert.equal(out.items.required.precision, 0.5);
    assert.equal(out.items.required.recall, 1);
    ratioClose(out.items.required.f1, 2 / 3);
    ratioClose(out.items.overall.precision, 2 / 3);
    assert.equal(out.items.overall.recall, 1);
    ratioClose(out.items.overall.f1, 0.8);
  });

  it('D only acceptable matched, required missing', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01')];
    gold.acceptable.events = [
      goldEvent('acceptable-event-01', { claim: 'Optional', supportMessageIds: ['m2'] }),
    ];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [
        predictedItem('item-acceptable', 'event', { claim: 'Optional' }),
      ], [evidenceRow('item-acceptable', 'm2')]),
    );
    assert.equal(out.items.overall.predicted, 1);
    assert.equal(out.items.overall.matched, 1);
    assert.equal(out.items.extraFalsePositives, 0);
    assert.equal(out.items.required.precision, 1);
    assert.equal(out.items.required.recall, 0);
    assert.equal(out.items.required.f1, 0);
    assert.equal(out.items.overall.precision, 1);
    assert.equal(out.items.overall.recall, 0);
    assert.equal(out.items.overall.f1, 0);
  });

  it('E omitted acceptable does not change recall numerator or denominator', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01')];
    gold.acceptable.events = [
      goldEvent('acceptable-event-01', { claim: 'Optional', supportMessageIds: ['m2'] }),
    ];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-required', 'event')], [
        evidenceRow('item-required', 'm1'),
      ]),
    );
    assert.equal(out.items.overall.gold, 1);
    assert.equal(out.items.required.gold, 1);
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.items.acceptable.gold, 1);
    assert.equal(out.items.acceptable.matched, 0);
  });

  it('G no predictions and one required missing', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01')];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(caseData, extraction(caseData.caseId, [], []));
    assert.equal(out.items.required.precision, 1);
    assert.equal(out.items.required.recall, 0);
    assert.equal(out.items.required.f1, 0);
    assert.equal(out.items.overall.predicted, 0);
    assert.equal(out.items.extraFalsePositives, 0);
  });
});

describe('evaluateCaseV2 correction-04 structural fixture', () => {
  function correctionCase() {
    const gold = emptyGold();
    gold.required.hypotheses = [goldHypothesis('required-hypothesis-01')];
    gold.acceptable.events = [
      goldEvent('acceptable-event-01', {
        claim: 'Остаётся до бонуса',
        supportMessageIds: ['m2'],
      }),
    ];
    return v2Case({ gold });
  }

  it('scores only the required rejected hypothesis', () => {
    const caseData = correctionCase();
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [
        predictedItem('item-h', 'hypothesis', {
          status: 'rejected',
          alternative: 'Синтетическая альтернатива',
        }),
      ], [
        evidenceRow('item-h', 'm1'),
        evidenceRow('item-h', 'm2', { relation: 'rejects', episodeKey: 'episode:m2' }),
      ]),
    );
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.items.acceptable.matched, 0);
    assert.equal(out.items.extraFalsePositives, 0);
    assert.equal(out.items.overall.precision, 1);
    assert.equal(out.items.overall.recall, 1);
    assert.equal(out.items.overall.f1, 1);
  });

  it('scores hypothesis plus acceptable event', () => {
    const caseData = correctionCase();
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [
        predictedItem('item-h', 'hypothesis', {
          status: 'rejected',
          alternative: 'Синтетическая альтернатива',
        }),
        predictedItem('item-e', 'event', { claim: 'Остаётся до бонуса' }),
      ], [
        evidenceRow('item-h', 'm1'),
        evidenceRow('item-h', 'm3', { relation: 'rejects', episodeKey: 'episode:m3' }),
        evidenceRow('item-e', 'm2'),
      ]),
    );
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.items.acceptable.matched, 1);
    assert.equal(out.items.extraFalsePositives, 0);
    assert.equal(out.items.overall.f1, 1);
  });

  it('scores only the acceptable event as required FN with precision 1', () => {
    const caseData = correctionCase();
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [
        predictedItem('item-e', 'event', { claim: 'Остаётся до бонуса' }),
      ], [evidenceRow('item-e', 'm2')]),
    );
    assert.equal(out.items.required.matched, 0);
    assert.equal(out.items.acceptable.matched, 1);
    assert.equal(out.items.extraFalsePositives, 0);
    assert.equal(out.items.overall.precision, 1);
    assert.equal(out.items.overall.recall, 0);
    assert.equal(out.items.overall.f1, 0);
  });
});

describe('evaluateCaseV2 evidence scoring', () => {
  it('counts extra predicted support as FP on a matched event', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01')];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-e', 'event')], [
        evidenceRow('item-e', 'm1'),
        evidenceRow('item-e', 'm2'),
      ]),
    );
    assert.equal(out.items.required.matched, 1);
    assert.equal(out.evidence.byRelation.supports.tp, 1);
    assert.equal(out.evidence.byRelation.supports.fp, 1);
    assert.equal(out.evidence.byRelation.supports.fn, 0);
  });

  it('treats unmatched required evidence as FN and unmatched acceptable evidence as neutral', () => {
    const gold = emptyGold();
    gold.required.events = [goldEvent('required-event-01')];
    gold.acceptable.events = [
      goldEvent('acceptable-event-01', { claim: 'Optional', supportMessageIds: ['m2'] }),
    ];
    const caseData = v2Case({ gold });
    const none = evaluateCaseV2(caseData, extraction(caseData.caseId, [], []));
    assert.equal(none.evidence.byRelation.supports.fn, 1);
    const extra = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-x', 'event', { claim: 'Extra' })], [
        evidenceRow('item-x', 'm3'),
      ]),
    );
    assert.equal(extra.evidence.byRelation.supports.fp, 1);
  });
});

describe('evaluateCaseV2 recurrence episode partition', () => {
  function recurrenceCase(episodeKeys = ['alpha', 'beta']) {
    const gold = emptyGold();
    gold.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'pattern_confirmation'],
        episodeKeys: [...episodeKeys, null],
      }),
    ];
    return v2Case({ gold });
  }

  function recurrenceExtraction(keys) {
    return extraction('eval-v2-case-01', [predictedItem('item-recurrence-1', 'recurrence')], [
      evidenceRow('item-recurrence-1', 'm1', {
        supportType: 'episode_observation',
        episodeKey: keys.m1,
      }),
      evidenceRow('item-recurrence-1', 'm2', {
        supportType: 'episode_observation',
        episodeKey: keys.m2,
      }),
      evidenceRow('item-recurrence-1', 'm3', {
        supportType: 'pattern_confirmation',
        episodeKey: null,
      }),
    ]);
  }

  it('treats opaque episodeKey rename as exact and ignores confirmation rows', () => {
    const caseData = recurrenceCase(['g1', 'g2']);
    const exact = evaluateCaseV2(caseData, recurrenceExtraction({ m1: 'opaque-a', m2: 'opaque-b' }));
    assert.deepEqual(exact.recurrenceEpisodes, { eligible: 1, exact: 1, accuracy: 1 });
  });

  it('scores a merge of two gold episodes as not exact', () => {
    const gold = emptyGold();
    gold.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'episode_observation'],
        episodeKeys: ['alpha', 'beta', 'gamma'],
      }),
    ];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-recurrence-1', 'recurrence')], [
        evidenceRow('item-recurrence-1', 'm1', {
          supportType: 'episode_observation',
          episodeKey: 'merged',
        }),
        evidenceRow('item-recurrence-1', 'm2', {
          supportType: 'episode_observation',
          episodeKey: 'merged',
        }),
        evidenceRow('item-recurrence-1', 'm3', {
          supportType: 'episode_observation',
          episodeKey: 'kept',
        }),
      ]),
    );
    assert.equal(out.recurrenceEpisodes.eligible, 1);
    assert.equal(out.recurrenceEpisodes.exact, 0);
  });

  it('scores a split of one gold episode as not exact', () => {
    const gold = emptyGold();
    gold.required.recurrences = [
      goldRecurrence('required-recurrence-01', {
        supportMessageIds: ['m1', 'm2', 'm3'],
        supportTypes: ['episode_observation', 'episode_observation', 'episode_observation'],
        episodeKeys: ['shared', 'shared', 'other'],
      }),
    ];
    const caseData = v2Case({ gold });
    const out = evaluateCaseV2(
      caseData,
      extraction(caseData.caseId, [predictedItem('item-recurrence-1', 'recurrence')], [
        evidenceRow('item-recurrence-1', 'm1', {
          supportType: 'episode_observation',
          episodeKey: 'left',
        }),
        evidenceRow('item-recurrence-1', 'm2', {
          supportType: 'episode_observation',
          episodeKey: 'right',
        }),
        evidenceRow('item-recurrence-1', 'm3', {
          supportType: 'episode_observation',
          episodeKey: 'other-opaque',
        }),
      ]),
    );
    assert.equal(out.recurrenceEpisodes.eligible, 1);
    assert.equal(out.recurrenceEpisodes.exact, 0);
  });
});

describe('evaluateCaseV2 contract boundary', () => {
  it('throws a V2 contract error and does not mutate inputs', () => {
    const caseData = v2Case();
    const snapshot = structuredClone(caseData);
    const bad = extraction(caseData.caseId, [predictedItem('item-e', 'event')], []);
    assert.throws(() => evaluateCaseV2(caseData, bad), (error) => {
      assert.equal(String(error.message).startsWith(CONTRACT_PREFIX), true);
      return true;
    });
    assert.deepEqual(caseData, snapshot);
  });
});

describe('evaluateDatasetV2', () => {
  it('F aggregates integer totals before ratios and does not average case-level precision', () => {
    const first = scoringCaseRequiredAcceptable();
    first.caseData.caseId = 'case-a';
    first.extraction.run.caseId = 'case-a';
    const second = scoringCaseRequiredAcceptable([
      {
        item: predictedItem('item-extra', 'event', { claim: 'Unlisted extra' }),
        evidence: [evidenceRow('item-extra', 'm3')],
      },
    ]);
    second.caseData.caseId = 'case-c';
    second.extraction.run.caseId = 'case-c';
    const dataset = {
      datasetId: 'eval-v2-synthetic',
      version: '2.0.0',
      cases: [first.caseData, second.caseData],
    };
    const report = evaluateDatasetV2(dataset, [first.extraction, second.extraction], {
      extractorVersion: EXTRACTOR_VERSION,
    });
    assert.equal(report.datasetId, 'eval-v2-synthetic');
    assert.equal(report.datasetVersion, '2.0.0');
    assert.equal(report.extractorVersion, EXTRACTOR_VERSION);
    assert.equal(report.aggregate.items.overall.predicted, 5);
    assert.equal(report.aggregate.items.overall.matched, 4);
    assert.equal(report.aggregate.items.extraFalsePositives, 1);
    ratioClose(report.aggregate.items.overall.precision, 4 / 5);
    assert.notEqual(report.aggregate.items.overall.precision, (1 + 2 / 3) / 2);
  });

  it('rejects duplicate, unknown, missing, mixed version, and non-data-only options', () => {
    const { caseData, extraction: ext } = scoringCaseRequiredAcceptable();
    const dataset = {
      datasetId: 'eval-v2-synthetic',
      version: '2.0.0',
      cases: [caseData],
    };
    assert.throws(() => evaluateDatasetV2(dataset, [ext, structuredClone(ext)]));
    const unknown = structuredClone(ext);
    unknown.run.caseId = 'missing';
    assert.throws(() => evaluateDatasetV2(dataset, [unknown]));
    assert.throws(() => evaluateDatasetV2(dataset, []));
    const secondCase = structuredClone(caseData);
    secondCase.caseId = 'eval-v2-case-02';
    const mixed = structuredClone(ext);
    mixed.run.caseId = 'eval-v2-case-02';
    mixed.run.extractorVersion = 'other';
    assert.throws(() =>
      evaluateDatasetV2({ ...dataset, cases: [caseData, secondCase] }, [ext, mixed]),
    );
    const getterOptions = {};
    Object.defineProperty(getterOptions, 'extractorVersion', {
      enumerable: true,
      get() {
        throw new Error(SENTINELS.key);
      },
    });
    assert.throws(() => evaluateDatasetV2(dataset, [ext], getterOptions), (error) => {
      assert.equal(String(error.message).includes(SENTINELS.key), false);
      return true;
    });
    const snapshot = structuredClone(dataset);
    evaluateDatasetV2(dataset, [ext], { extractorVersion: EXTRACTOR_VERSION });
    assert.deepEqual(dataset, snapshot);
  });

  it('rejects empty or non-string options.extractorVersion without executing getters', () => {
    const emptyDataset = {
      datasetId: 'eval-v2-synthetic',
      version: '2.0.0',
      cases: [],
    };
    assert.throws(() => evaluateDatasetV2(emptyDataset, [], { extractorVersion: '' }));
    assert.throws(() => evaluateDatasetV2(emptyDataset, [], { extractorVersion: 1 }));
    const getterOptions = {};
    Object.defineProperty(getterOptions, 'extractorVersion', {
      enumerable: true,
      get() {
        throw new Error(SENTINELS.key);
      },
    });
    assert.throws(() => evaluateDatasetV2(emptyDataset, [], getterOptions), (error) => {
      assert.equal(String(error.message).includes(SENTINELS.key), false);
      return true;
    });
    assert.throws(() => evaluateDatasetV2(emptyDataset, [], { unknown: true }));
  });
});

describe('renderMarkdownReportV2 privacy', () => {
  it('renders V2 sections without dialogue or secrets', () => {
    const { caseData, extraction: ext } = scoringCaseRequiredAcceptable();
    const dataset = {
      datasetId: 'eval-v2-synthetic',
      version: '2.0.0',
      cases: [caseData],
    };
    const report = evaluateDatasetV2(dataset, [ext], { extractorVersion: EXTRACTOR_VERSION });
    const markdown = renderMarkdownReportV2(report);
    assert.match(markdown, /required/i);
    assert.match(markdown, /acceptable/i);
    assert.match(markdown, /overall/i);
    assert.match(markdown, /false positive/i);
    assert.match(markdown, /not_evaluated|NOT EVALUATED/i);
    assert.match(markdown, /supportType/i);
    assert.equal(markdown.includes(SENTINELS.dialogue), false);
    assert.equal(markdown.includes(SENTINELS.key), false);
    assert.equal(markdown.includes(SENTINELS.auth), false);
    assert.equal(markdown.includes(caseData.messages[0].text), false);
  });
});

describe('evaluateCaseV2 shuffle of extraction arrays', () => {
  it('does not change metrics when items and evidence are permuted without changing keys', () => {
    const { caseData, extraction: ext } = scoringCaseRequiredAcceptable();
    const first = evaluateCaseV2(caseData, ext);
    const shuffled = {
      ...ext,
      items: [...ext.items].reverse(),
      evidence: [...ext.evidence].reverse(),
    };
    const second = evaluateCaseV2(caseData, shuffled);
    assert.deepEqual(second.items, first.items);
    assert.deepEqual(second.evidence.overall, first.evidence.overall);
  });
});
