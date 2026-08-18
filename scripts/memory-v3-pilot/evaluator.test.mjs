import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateCase,
  evaluateDataset,
  renderMarkdownReport,
} from './evaluator.mjs';

function message(id, text, day) {
  return {
    id,
    role: 'user',
    text,
    createdAt: `2025-01-${String(day).padStart(2, '0')}T10:00:00Z`,
  };
}

function fixtureCase() {
  return {
    caseId: 'eval-case-01',
    title: 'Controlled evaluator fixture',
    category: 'correction',
    messages: [
      message('m1', 'Я переехала в Казань в мае 2022.', 1),
      message('m2', 'Не в апреле, а именно в мае.', 2),
      message('m3', 'В июне 2023 я сменила работу.', 3),
      message('m4', 'В первой компании я брала все срочные задачи.', 4),
      message('m5', 'В новой компании снова отвечаю ночью.', 5),
      message('m6', 'В семье я часто всё организую сама.', 6),
      message('m7', 'Но иногда спокойно прошу сестру помочь.', 7),
      message('m8', 'Сегодня выпила чай.', 8),
    ],
    gold: {
      events: [
        {
          claim: 'Переезд в Казань в мае 2022 года',
          eventTimeStart: '2022-05-01',
          eventTimeEnd: '2022-05-31',
          supportMessageIds: ['m1'],
          correctedMessageIds: ['m2'],
        },
        {
          claim: 'Смена работы в июне 2023 года',
          eventTimeStart: '2023-06-01',
          eventTimeEnd: '2023-06-30',
          supportMessageIds: ['m3'],
        },
      ],
      recurrences: [
        {
          claim: 'Берёт на себя срочную работу в разных компаниях',
          supportMessageIds: ['m4', 'm5'],
          episodeKeys: ['job-one', 'job-two'],
        },
      ],
      hypotheses: [
        {
          claim: 'В семье может автоматически брать организацию на себя',
          supportMessageIds: ['m6'],
          contradictedMessageIds: ['m7'],
          alternative: 'В этих ситуациях у неё могло быть больше времени',
          mustNotBeFact: true,
        },
      ],
    },
    mustNotRemember: [],
  };
}

function item(localItemKey, kind, claim, overrides = {}) {
  return {
    localItemKey,
    kind,
    claim,
    scope: 'conversation',
    conversationId: 'fixture-conversation',
    eventTimeStart: null,
    eventTimeEnd: null,
    status: kind === 'hypothesis' ? 'candidate' : 'active',
    sensitivity: 'normal',
    alternative: kind === 'hypothesis' ? 'Возможна другая причина' : null,
    ...overrides,
  };
}

function evidence(itemKey, sourceMessageId, relation, episodeKey) {
  return {
    itemKey,
    sourceMessageId,
    episodeKey,
    relation,
    provenanceRole: 'user',
    mentionTime: '2025-01-10T10:00:00Z',
  };
}

function perfectExtraction(caseId = 'eval-case-01') {
  return {
    run: { caseId, extractorVersion: 'fixture-extractor-v1' },
    items: [
      item('event-move', 'event', 'В мае 2022 перебралась жить в Казань', {
        eventTimeStart: '2022-05-01',
        eventTimeEnd: '2022-05-31',
      }),
      item('event-job', 'event', 'Летом 2023 перешла на другую работу', {
        eventTimeStart: '2023-06-01',
        eventTimeEnd: '2023-06-30',
      }),
      item('rec-work', 'recurrence', 'В нескольких командах забирает срочные задачи'),
      item('hyp-family', 'hypothesis', 'Может автоматически становиться организатором семьи', {
        alternative: 'В конкретных случаях у неё могло быть больше свободного времени',
      }),
    ],
    evidence: [
      evidence('event-move', 'm1', 'supports', 'move-2022'),
      evidence('event-move', 'm2', 'corrects', 'move-2022'),
      evidence('event-job', 'm3', 'supports', 'job-2023'),
      evidence('rec-work', 'm4', 'supports', 'job-one'),
      evidence('rec-work', 'm5', 'supports', 'job-two'),
      evidence('hyp-family', 'm6', 'supports', 'family-organizing'),
      evidence('hyp-family', 'm7', 'contradicts', 'family-organizing'),
    ],
  };
}

function emptyExtraction(caseId, extractorVersion = 'fixture-extractor-v1') {
  return {
    run: { caseId, extractorVersion },
    items: [],
    evidence: [],
  };
}

describe('evaluateCase', () => {
  it('scores a structurally perfect extraction without pretending to score claim semantics', () => {
    const report = evaluateCase(fixtureCase(), perfectExtraction());

    assert.deepEqual(report.items.overall, {
      gold: 4,
      predicted: 4,
      matched: 4,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    assert.equal(report.evidence.overall.f1, 1);
    assert.deepEqual(report.dates, { eligible: 2, exact: 2, accuracy: 1 });
    assert.deepEqual(report.recurrenceEpisodes, { eligible: 1, exact: 1, accuracy: 1 });
    assert.deepEqual(report.semanticClaims, {
      status: 'not_evaluated',
      reason: 'Structural evaluator does not judge paraphrase meaning',
    });
    assert.deepEqual(report.forbiddenClaims, {
      status: 'not_evaluated',
      reason: 'Structural evaluator cannot judge mustNotRemember claims by meaning',
    });
  });

  it('penalizes unsupported extra items and missing gold items', () => {
    const extraction = perfectExtraction();
    extraction.items = extraction.items.filter((entry) => entry.localItemKey !== 'event-job');
    extraction.evidence = extraction.evidence.filter((entry) => entry.itemKey !== 'event-job');
    extraction.items.push(item('event-tea', 'event', 'Любит чай'));
    extraction.evidence.push(evidence('event-tea', 'm8', 'supports', 'tea-today'));

    const report = evaluateCase(fixtureCase(), extraction);

    assert.equal(report.items.overall.gold, 4);
    assert.equal(report.items.overall.predicted, 4);
    assert.equal(report.items.overall.matched, 3);
    assert.equal(report.items.overall.precision, 0.75);
    assert.equal(report.items.overall.recall, 0.75);
    assert.equal(report.items.byKind.event.matched, 1);
  });

  it('does not match an item using correction evidence without positive support overlap', () => {
    const extraction = perfectExtraction();
    const moveSupport = extraction.evidence.find(
      (entry) => entry.itemKey === 'event-move' && entry.relation === 'supports',
    );
    moveSupport.sourceMessageId = 'm8';
    moveSupport.episodeKey = 'unrelated-tea';

    const report = evaluateCase(fixtureCase(), extraction);

    assert.equal(report.items.overall.matched, 3);
    assert.equal(report.items.byKind.event.matched, 1);
  });

  it('separately catches wrong recurrence episode identities', () => {
    const extraction = perfectExtraction();
    extraction.evidence.find((entry) => entry.sourceMessageId === 'm5').episodeKey = 'wrong-episode';

    const report = evaluateCase(fixtureCase(), extraction);

    assert.equal(report.items.byKind.recurrence.f1, 1);
    assert.deepEqual(report.recurrenceEpisodes, { eligible: 1, exact: 0, accuracy: 0 });
  });

  it('does not call an event date exact when the extractor invents a missing boundary', () => {
    const caseData = fixtureCase();
    delete caseData.gold.events[0].eventTimeStart;

    const report = evaluateCase(caseData, perfectExtraction());

    assert.deepEqual(report.dates, { eligible: 2, exact: 1, accuracy: 0.5 });
  });

  it('marks a false positive in a gold-empty case as failed abstention', () => {
    const caseData = {
      caseId: 'eval-empty-01',
      messages: [message('m1', 'Это история моей коллеги, не моя.', 1)],
      gold: { events: [], recurrences: [], hypotheses: [] },
    };
    const extraction = {
      run: { caseId: caseData.caseId, extractorVersion: 'fixture-extractor-v1' },
      items: [item('false-event', 'event', 'Пользователь часто переезжает')],
      evidence: [evidence('false-event', 'm1', 'supports', 'third-party-story')],
    };

    const report = evaluateCase(caseData, extraction);

    assert.deepEqual(report.abstention, { expected: true, passed: false, falsePositiveItems: 1 });
  });
});

describe('evaluateDataset and report rendering', () => {
  it('aggregates present and missing runs and renders no raw dialogue text', () => {
    const secondCase = {
      caseId: 'eval-empty-02',
      messages: [message('m1', 'RAW_PRIVATE_SENTINEL', 1)],
      gold: { events: [], recurrences: [], hypotheses: [] },
    };
    const dataset = {
      datasetId: 'eval-dataset-v1',
      version: '1.0.0',
      cases: [fixtureCase(), secondCase],
    };

    const report = evaluateDataset(dataset, [perfectExtraction()], {
      extractorVersion: 'fixture-extractor-v1',
    });
    const markdown = renderMarkdownReport(report);

    assert.equal(report.cases.length, 2);
    assert.equal(report.aggregate.items.overall.gold, 4);
    assert.equal(report.aggregate.items.overall.matched, 4);
    assert.equal(report.aggregate.abstention.expected, 1);
    assert.equal(report.aggregate.abstention.passed, 1);
    assert.match(markdown, /Semantic claims: NOT EVALUATED/);
    assert.match(markdown, /Forbidden claims: NOT EVALUATED/);
    assert.match(markdown, /Gold-empty abstention accuracy/);
    assert.doesNotMatch(markdown, /^- Abstention accuracy:/m);
    assert.match(markdown, /eval-case-01/);
    assert.match(markdown, /eval-empty-02/);
    assert.doesNotMatch(markdown, /RAW_PRIVATE_SENTINEL/);
  });

  it('rejects duplicate and unknown extraction case ids', () => {
    const dataset = {
      datasetId: 'eval-dataset-v1',
      version: '1.0.0',
      cases: [fixtureCase()],
    };
    const duplicate = [perfectExtraction(), perfectExtraction()];
    const unknown = [emptyExtraction('unknown-case')];

    assert.throws(
      () => evaluateDataset(dataset, duplicate, { extractorVersion: 'fixture-extractor-v1' }),
      /duplicate.*caseId/i,
    );
    assert.throws(
      () => evaluateDataset(dataset, unknown, { extractorVersion: 'fixture-extractor-v1' }),
      /unknown.*caseId/i,
    );
  });

  it('infers one extractor version and rejects mixed-version reports', () => {
    const secondCase = {
      caseId: 'eval-empty-02',
      messages: [message('m1', 'Обычная нейтральная реплика.', 1)],
      gold: { events: [], recurrences: [], hypotheses: [] },
    };
    const dataset = {
      datasetId: 'eval-dataset-v1',
      version: '1.0.0',
      cases: [fixtureCase(), secondCase],
    };
    const sameVersion = [perfectExtraction(), emptyExtraction('eval-empty-02')];
    const mixedVersions = [
      perfectExtraction(),
      emptyExtraction('eval-empty-02', 'different-extractor-v2'),
    ];

    assert.equal(evaluateDataset(dataset, sameVersion).extractorVersion, 'fixture-extractor-v1');
    assert.throws(() => evaluateDataset(dataset, mixedVersions), /mixed.*extractorVersion/i);
  });
});
