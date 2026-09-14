/**
 * Memory V3 offline extractor — strict core tests.
 * Fake adapters only. No network, provider, filesystem, or env I/O.
 * Run: node --test scripts/memory-v3-pilot/extractor-core.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeLocalItemKey, validateCase, validateExtraction } from './contracts.mjs';
import { buildExtractorRequest } from './extractor-prompt.mjs';
import * as extractorCore from './extractor-core.mjs';
import { extractCase, projectSafeExtractorDiagnostic } from './extractor-core.mjs';

const EXTRACTOR_VERSION = 'offline-core-v1';
const OPTIONS = Object.freeze({ extractorVersion: EXTRACTOR_VERSION });

const SENTINELS = Object.freeze({
  dialogue: 'RAW_DIALOGUE_SECRET_SENTINEL',
  claim: 'RAW_CLAIM_SECRET_SENTINEL',
  adapter: 'RAW_ADAPTER_ERROR_SENTINEL',
  getter: 'RAW_GETTER_SECRET_SENTINEL',
  fakeBrand: 'RAW_FAKE_BRAND_SECRET',
  gold: 'LEAK_GOLD_SENTINEL',
  forbidden: 'LEAK_FORBIDDEN_SENTINEL',
  title: 'LEAK_TITLE_SENTINEL',
  category: 'LEAK_CATEGORY_SENTINEL',
});

const RELATIONS = Object.freeze(['supports', 'contradicts', 'corrects', 'rejects']);

function sampleCase(overrides = {}) {
  return {
    caseId: 'core-case-01',
    title: SENTINELS.title,
    category: SENTINELS.category,
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: `${SENTINELS.dialogue} Переехала в Казань в мае 2022.`,
        createdAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'Это звучит как большой шаг.',
        createdAt: '2024-01-10T10:00:05.000Z',
      },
      {
        id: 'm3',
        role: 'user',
        text: 'Потом снова переезжала в 2023.',
        createdAt: '2024-01-10T10:01:00.000Z',
      },
      {
        id: 'm4',
        role: 'system',
        text: 'system note',
        createdAt: '2024-01-10T10:00:01.000Z',
      },
    ],
    gold: {
      events: [{ claim: SENTINELS.gold, supportMessageIds: ['m1'] }],
      recurrences: [],
      hypotheses: [],
    },
    mustNotRemember: [{ claim: SENTINELS.forbidden }],
    ...overrides,
  };
}

function validEventItem(overrides = {}) {
  return {
    itemRef: 'item-1',
    kind: 'event',
    claim: 'Переехала в Казань',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: '2022-05-01',
    eventTimeEnd: '2022-05-31',
    alternative: null,
    ...overrides,
  };
}

function validEventEvidence(overrides = {}) {
  return {
    itemRef: 'item-1',
    sourceMessageId: 'm1',
    episodeKey: 'move-kazan-2022',
    relation: 'supports',
    ...overrides,
  };
}

function validEventResponse(overrides = {}) {
  return {
    items: [validEventItem()],
    evidence: [validEventEvidence()],
    ...overrides,
  };
}

function expectedNormalizedEventItem() {
  return {
    kind: 'event',
    claim: 'Переехала в Казань',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: '2022-05-01',
    eventTimeEnd: '2022-05-31',
    alternative: null,
    scope: 'cross_conversation',
    conversationId: null,
  };
}

function recordingAdapter(payload) {
  const calls = [];
  const adapter = async (request) => {
    calls.push(request);
    return payload;
  };
  adapter.calls = calls;
  return adapter;
}

function assertStage(error, stage) {
  assert.match(String(error.message), new RegExp(`^\\[memory-v3:${stage}\\]`));
}

function assertNoSecrets(error) {
  const message = String(error && error.message);
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(message.includes(sentinel), false, `error.message leaked ${sentinel}`);
    assert.equal(serialized.includes(sentinel), false, `error serialization leaked ${sentinel}`);
  }
  assert.equal('cause' in error && error.cause != null, false);
}

async function assertRejectsStage(fn, stage) {
  await assert.rejects(fn, (error) => {
    assertStage(error, stage);
    assertNoSecrets(error);
    return true;
  });
}

describe('extractCase valid empty abstention', () => {
  it('returns a trusted empty extraction and calls the adapter once with the prompt request', async () => {
    const caseData = sampleCase();
    const snapshot = structuredClone(caseData);
    const adapter = recordingAdapter({ items: [], evidence: [] });

    const extraction = await extractCase(caseData, adapter, OPTIONS);

    assert.deepEqual(extraction, {
      run: { caseId: 'core-case-01', extractorVersion: EXTRACTOR_VERSION },
      items: [],
      evidence: [],
    });
    assert.doesNotThrow(() => validateExtraction(extraction, caseData));
    assert.equal(adapter.calls.length, 1);
    assert.deepEqual(adapter.calls[0], buildExtractorRequest(caseData));
    const serializedRequest = JSON.stringify(adapter.calls[0]);
    for (const sentinel of [SENTINELS.gold, SENTINELS.forbidden, SENTINELS.title, SENTINELS.category]) {
      assert.equal(serializedRequest.includes(sentinel), false, `request leaked ${sentinel}`);
    }
    assert.deepEqual(caseData, snapshot);
  });
});

describe('extractCase correction rejected-hypothesis fixture', () => {
  function correctionCase() {
    return {
      caseId: 'core-correction-rejected-hypothesis-01',
      title: 'Synthetic correction fixture',
      category: 'correction',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'Раньше мне казалось, что я остаюсь на этой работе из страха перемен.',
          createdAt: '2024-04-23T17:00:00.000Z',
        },
        {
          id: 'm2',
          role: 'user',
          text: 'После разговора с руководителем поняла: дело не в страхе. Я сознательно остаюсь до выплаты годового бонуса.',
          createdAt: '2024-10-23T17:00:00.000Z',
        },
      ],
      gold: { events: [], recurrences: [], hypotheses: [] },
      mustNotRemember: [],
    };
  }

  function correctionResponse() {
    return {
      items: [
        {
          itemRef: 'item-1',
          kind: 'hypothesis',
          claim: 'Решение остаться на работе могло быть связано со страхом перемен',
          status: 'rejected',
          sensitivity: 'normal',
          eventTimeStart: null,
          eventTimeEnd: null,
          alternative: 'осознанное ожидание годового бонуса',
        },
      ],
      evidence: [
        {
          itemRef: 'item-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          relation: 'supports',
        },
        {
          itemRef: 'item-1',
          sourceMessageId: 'm2',
          episodeKey: 'episode:m1',
          relation: 'rejects',
        },
      ],
    };
  }

  it('accepts a rejected hypothesis with user supports and later rejects', async () => {
    const caseData = correctionCase();
    const extraction = await extractCase(caseData, async () => correctionResponse(), OPTIONS);
    assert.doesNotThrow(() => validateExtraction(extraction, caseData));
    assert.equal(extraction.items.length, 1);
    assert.equal(extraction.items[0].kind, 'hypothesis');
    assert.equal(extraction.items[0].status, 'rejected');
    assert.equal(extraction.items[0].eventTimeStart, null);
    assert.equal(extraction.items[0].eventTimeEnd, null);
    assert.equal(extraction.items[0].sensitivity, 'normal');
    assert.equal(extraction.items[0].alternative, 'осознанное ожидание годового бонуса');
    assert.deepEqual(
      extraction.evidence.map((entry) => ({
        sourceMessageId: entry.sourceMessageId,
        relation: entry.relation,
        episodeKey: entry.episodeKey,
      })),
      [
        { sourceMessageId: 'm1', relation: 'supports', episodeKey: 'episode:m1' },
        { sourceMessageId: 'm2', relation: 'rejects', episodeKey: 'episode:m1' },
      ],
    );
  });
});

describe('extractCase JSON string and plain object', () => {
  it('accepts the same valid event as a plain object and as JSON.stringify', async () => {
    const caseData = sampleCase();
    const payload = validEventResponse();
    const asObject = await extractCase(caseData, async () => structuredClone(payload), OPTIONS);
    const asString = await extractCase(
      caseData,
      async () => JSON.stringify(payload),
      OPTIONS,
    );
    assert.deepEqual(asObject, asString);
    assert.doesNotThrow(() => validateExtraction(asObject, caseData));
  });

  for (const [label, payload] of [
    ['array', []],
    ['null', null],
    ['number', 1],
    ['boolean', true],
    ['parsed string', '"not-an-object"'],
    ['markdown fence', '```json\n{"items":[],"evidence":[]}\n```'],
    ['surrounding text', 'Here is JSON: {"items":[],"evidence":[]}'],
  ]) {
    it(`rejects ${label} adapter payload`, async () => {
      const stage = label === 'markdown fence' || label === 'surrounding text' ? 'parse' : 'shape';
      await assertRejectsStage(
        () => extractCase(sampleCase(), async () => payload, OPTIONS),
        stage,
      );
    });
  }
});

describe('extractCase valid event normalization', () => {
  it('adds trusted run, scope, keys, and cited-message provenance without mutating inputs', async () => {
    const caseData = sampleCase();
    const snapshot = structuredClone(caseData);
    const payload = validEventResponse();
    const payloadSnapshot = structuredClone(payload);

    const extraction = await extractCase(caseData, async () => payload, OPTIONS);
    const expectedItem = expectedNormalizedEventItem();
    const localItemKey = makeLocalItemKey(expectedItem, 0);

    assert.deepEqual(extraction.run, {
      caseId: 'core-case-01',
      extractorVersion: EXTRACTOR_VERSION,
    });
    assert.equal(extraction.items.length, 1);
    assert.equal(extraction.evidence.length, 1);
    assert.equal(extraction.items[0].scope, 'cross_conversation');
    assert.equal(extraction.items[0].conversationId, null);
    assert.equal(extraction.items[0].localItemKey, localItemKey);
    assert.equal('itemRef' in extraction.items[0], false);
    assert.equal('itemRef' in extraction.evidence[0], false);
    assert.equal(extraction.evidence[0].itemKey, localItemKey);
    assert.equal(extraction.evidence[0].provenanceRole, 'user');
    assert.equal(extraction.evidence[0].mentionTime, caseData.messages[0].createdAt);
    assert.deepEqual(Object.keys(extraction.items[0]).sort(), [
      'alternative',
      'claim',
      'conversationId',
      'eventTimeEnd',
      'eventTimeStart',
      'kind',
      'localItemKey',
      'scope',
      'sensitivity',
      'status',
    ]);
    assert.deepEqual(Object.keys(extraction.evidence[0]).sort(), [
      'episodeKey',
      'itemKey',
      'mentionTime',
      'provenanceRole',
      'relation',
      'sourceMessageId',
    ]);
    assert.doesNotThrow(() => validateExtraction(extraction, caseData));
    assert.deepEqual(caseData, snapshot);
    assert.deepEqual(payload, payloadSnapshot);
  });
});

describe('extractCase deterministic identity', () => {
  it('repeats the same run and keys for identical inputs and does not sort adapter items', async () => {
    const caseData = sampleCase();
    const payload = {
      items: [
        validEventItem({ itemRef: 'a', claim: 'Первый' }),
        validEventItem({ itemRef: 'b', claim: 'Второй', eventTimeStart: null, eventTimeEnd: null }),
      ],
      evidence: [
        validEventEvidence({ itemRef: 'a', episodeKey: 'ep-a' }),
        validEventEvidence({ itemRef: 'b', sourceMessageId: 'm3', episodeKey: 'ep-b' }),
      ],
    };

    const first = await extractCase(caseData, async () => structuredClone(payload), OPTIONS);
    const second = await extractCase(caseData, async () => structuredClone(payload), OPTIONS);
    assert.deepEqual(first, second);
    assert.equal(first.items[0].claim, 'Первый');
    assert.equal(first.items[1].claim, 'Второй');

    const swapped = {
      items: [payload.items[1], payload.items[0]],
      evidence: [payload.evidence[1], payload.evidence[0]],
    };
    const reordered = await extractCase(caseData, async () => swapped, OPTIONS);
    assert.equal(reordered.items[0].claim, 'Второй');
    assert.notEqual(reordered.items[0].localItemKey, first.items[0].localItemKey);
  });
});

describe('extractCase adapter call rules', () => {
  it('rejects a non-function adapter before any call', async () => {
    await assertRejectsStage(() => extractCase(sampleCase(), null, OPTIONS), 'shape');
  });

  it('rejects missing or empty extractorVersion before the adapter call', async () => {
    let calls = 0;
    const adapter = async () => {
      calls += 1;
      return { items: [], evidence: [] };
    };
    await assertRejectsStage(() => extractCase(sampleCase(), adapter, {}), 'shape');
    await assertRejectsStage(
      () => extractCase(sampleCase(), adapter, { extractorVersion: '' }),
      'shape',
    );
    await assertRejectsStage(
      () => extractCase(sampleCase(), adapter, { extractorVersion: '   ' }),
      'shape',
    );
    assert.equal(calls, 0);
  });

  it('rejects an invalid case before the adapter call', async () => {
    let calls = 0;
    const adapter = async () => {
      calls += 1;
      return { items: [], evidence: [] };
    };
    await assertRejectsStage(() => extractCase({ caseId: 'bad' }, adapter, OPTIONS), 'shape');
    assert.equal(calls, 0);
  });

  it('does not retry a sync throw or an async rejection', async () => {
    const counts = { sync: 0, async: 0 };
    const syncAdapter = () => {
      counts.sync += 1;
      throw new Error(SENTINELS.adapter);
    };
    const asyncAdapter = async () => {
      counts.async += 1;
      return Promise.reject(new Error(SENTINELS.adapter));
    };
    await assertRejectsStage(() => extractCase(sampleCase(), syncAdapter, OPTIONS), 'adapter');
    await assertRejectsStage(() => extractCase(sampleCase(), asyncAdapter, OPTIONS), 'adapter');
    assert.equal(counts.sync, 1);
    assert.equal(counts.async, 1);
  });
});

describe('extractCase strict allowlists', () => {
  it('rejects missing, unknown, and model-created identity fields', async () => {
    const caseData = sampleCase();
    const extraTopLevel = { items: [], evidence: [], run: { caseId: 'nope' } };
    await assertRejectsStage(
      () => extractCase(caseData, async () => extraTopLevel, OPTIONS),
      'shape',
    );

    const missingItemField = validEventResponse();
    delete missingItemField.items[0].alternative;
    await assertRejectsStage(
      () => extractCase(caseData, async () => missingItemField, OPTIONS),
      'shape',
    );

    const unknownItemField = validEventResponse();
    unknownItemField.items[0].reasoning = SENTINELS.claim;
    await assertRejectsStage(
      () => extractCase(caseData, async () => unknownItemField, OPTIONS),
      'shape',
    );

    const unknownEvidenceField = validEventResponse();
    unknownEvidenceField.evidence[0].mentionTime = '2024-01-10T10:00:00.000Z';
    await assertRejectsStage(
      () => extractCase(caseData, async () => unknownEvidenceField, OPTIONS),
      'shape',
    );

    for (const field of ['localItemKey', 'itemKey', 'scope', 'conversationId']) {
      const payload = validEventResponse();
      payload.items[0][field] = 'model-created';
      await assertRejectsStage(
        () => extractCase(caseData, async () => payload, OPTIONS),
        'shape',
      );
    }

    const diagnosis = validEventResponse();
    diagnosis.items[0].diagnosis = 'forbidden';
    await assertRejectsStage(
      () => extractCase(caseData, async () => diagnosis, OPTIONS),
      'shape',
    );
  });

  it('rejects sparse arrays and non-plain nested entries', async () => {
    const caseData = sampleCase();
    const sparse = validEventResponse();
    sparse.items[2] = validEventItem({ itemRef: 'item-2', claim: 'Другое' });
    await assertRejectsStage(() => extractCase(caseData, async () => sparse, OPTIONS), 'shape');

    await assertRejectsStage(
      () => extractCase(caseData, async () => ({ items: [new Date()], evidence: [] }), OPTIONS),
      'shape',
    );
  });
});

describe('extractCase itemRef integrity', () => {
  it('rejects empty, duplicate, and unresolved itemRef values', async () => {
    const caseData = sampleCase();

    await assertRejectsStage(
      () =>
        extractCase(
          caseData,
          async () => validEventResponse({ items: [validEventItem({ itemRef: '' })] }),
          OPTIONS,
        ),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          caseData,
          async () => ({
            items: [validEventItem(), validEventItem({ claim: 'Другое' })],
            evidence: [validEventEvidence()],
          }),
          OPTIONS,
        ),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          caseData,
          async () => validEventResponse({ evidence: [validEventEvidence({ itemRef: 'missing' })] }),
          OPTIONS,
        ),
      'shape',
    );
  });

  it('rejects an item without evidence as contract and evidence without an item as shape', async () => {
    const caseData = sampleCase();
    await assertRejectsStage(
      () =>
        extractCase(
          caseData,
          async () => ({ items: [validEventItem()], evidence: [] }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          caseData,
          async () => ({ items: [], evidence: [validEventEvidence()] }),
          OPTIONS,
        ),
      'shape',
    );
  });
});

describe('extractCase evidence source policy', () => {
  for (const relation of RELATIONS) {
    for (const { id, role } of [
      { id: 'm2', role: 'assistant' },
      { id: 'm4', role: 'system' },
    ]) {
      it(`rejects ${role} ${relation} evidence`, async () => {
        await assertRejectsStage(
          () =>
            extractCase(
              sampleCase(),
              async () =>
                validEventResponse({
                  evidence: [validEventEvidence({ sourceMessageId: id, relation })],
                }),
              OPTIONS,
            ),
          'contract',
        );
      });
    }
  }

  it('rejects an unknown sourceMessageId', async () => {
    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () =>
            validEventResponse({
              evidence: [validEventEvidence({ sourceMessageId: 'missing-message' })],
            }),
          OPTIONS,
        ),
      'shape',
    );
  });

  it('accepts user evidence when the status requires that relation', async () => {
    const extraction = await extractCase(
      sampleCase(),
      async () =>
        validEventResponse({
          items: [validEventItem({ status: 'corrected' })],
          evidence: [validEventEvidence({ relation: 'corrects' })],
        }),
      OPTIONS,
    );
    assert.equal(extraction.items[0].status, 'corrected');
    assert.equal(extraction.evidence[0].relation, 'corrects');
    assert.equal(extraction.evidence[0].provenanceRole, 'user');
    assert.doesNotThrow(() => validateExtraction(extraction, sampleCase()));
  });
});

describe('extractCase status/relation matrix via validateExtraction', () => {
  it('rejects an active event that only has contradicts evidence', async () => {
    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () =>
            validEventResponse({
              evidence: [validEventEvidence({ relation: 'contradicts' })],
            }),
          OPTIONS,
        ),
      'contract',
    );
  });

  it('accepts corrected and rejected events when the required user relation is present', async () => {
    const corrected = await extractCase(
      sampleCase(),
      async () =>
        validEventResponse({
          items: [validEventItem({ status: 'corrected' })],
          evidence: [validEventEvidence({ relation: 'corrects' })],
        }),
      OPTIONS,
    );
    assert.doesNotThrow(() => validateExtraction(corrected, sampleCase()));

    const rejected = await extractCase(
      sampleCase(),
      async () =>
        validEventResponse({
          items: [validEventItem({ status: 'rejected' })],
          evidence: [validEventEvidence({ relation: 'rejects' })],
        }),
      OPTIONS,
    );
    assert.doesNotThrow(() => validateExtraction(rejected, sampleCase()));
  });
});

describe('extractCase contract-invalid semantic output', () => {
  it('rejects a one-episode recurrence and a retelling of one episodeKey', async () => {
    const oneSupport = {
      items: [
        validEventItem({
          kind: 'recurrence',
          status: 'active',
          eventTimeStart: null,
          eventTimeEnd: null,
          claim: SENTINELS.claim,
        }),
      ],
      evidence: [validEventEvidence()],
    };
    await assertRejectsStage(
      () => extractCase(sampleCase(), async () => oneSupport, OPTIONS),
      'contract',
    );

    const sameEpisode = {
      items: [
        validEventItem({
          kind: 'recurrence',
          status: 'candidate',
          eventTimeStart: null,
          eventTimeEnd: null,
        }),
      ],
      evidence: [
        validEventEvidence({ episodeKey: 'same' }),
        validEventEvidence({ sourceMessageId: 'm3', episodeKey: 'same' }),
      ],
    };
    await assertRejectsStage(
      () => extractCase(sampleCase(), async () => sameEpisode, OPTIONS),
      'contract',
    );
  });

  it('rejects hypothesis without alternative and event with a non-null alternative', async () => {
    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () => ({
            items: [
              validEventItem({
                kind: 'hypothesis',
                status: 'candidate',
                alternative: null,
                claim: SENTINELS.claim,
              }),
            ],
            evidence: [validEventEvidence()],
          }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () => ({
            items: [validEventItem({ alternative: 'not-null' })],
            evidence: [validEventEvidence()],
          }),
          OPTIONS,
        ),
      'contract',
    );
  });

  it('rejects impossible dates, inverted ranges, invalid enums, and duplicate evidence', async () => {
    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () => validEventResponse({
            items: [validEventItem({ eventTimeStart: '2023-02-29', eventTimeEnd: '2023-02-29' })],
          }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () =>
            validEventResponse({
              items: [validEventItem({ eventTimeStart: '2022-06-01', eventTimeEnd: '2022-05-01' })],
            }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () => validEventResponse({ items: [validEventItem({ kind: 'memory' })] }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () =>
            validEventResponse({
              evidence: [validEventEvidence(), validEventEvidence()],
            }),
          OPTIONS,
        ),
      'contract',
    );
  });
});

describe('extractCase stable error stages and privacy', () => {
  it('keeps dialogue, claim, and adapter sentinels out of public errors', async () => {
    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          () => {
            throw new Error(SENTINELS.adapter);
          },
          OPTIONS,
        ),
      'adapter',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () =>
            validEventResponse({
              items: [validEventItem({ claim: SENTINELS.claim, reasoning: 'nope' })],
            }),
          OPTIONS,
        ),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCase(
          sampleCase(),
          async () =>
            validEventResponse({
              evidence: [validEventEvidence({ sourceMessageId: 'm2', relation: 'corrects' })],
            }),
          OPTIONS,
        ),
      'contract',
    );
  });

  it('classifies malformed JSON as parse and invalid options as shape', async () => {
    await assertRejectsStage(
      () => extractCase(sampleCase(), async () => '{', OPTIONS),
      'parse',
    );
    await assertRejectsStage(
      () => extractCase(sampleCase(), async () => ({ items: [], evidence: [] }), undefined),
      'shape',
    );
  });
});

function defineThrowingGetter(target, key) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(SENTINELS.getter);
    },
  });
  return target;
}

function defineAccessor(target, key, value) {
  let stored = value;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      return stored;
    },
    set(next) {
      stored = next;
    },
  });
  return target;
}

async function assertShapeOnce(payload) {
  let calls = 0;
  const adapter = async () => {
    calls += 1;
    return payload;
  };
  await assertRejectsStage(() => extractCase(sampleCase(), adapter, OPTIONS), 'shape');
  assert.equal(calls, 1);
}

describe('extractCase JSON-data-only objects', () => {
  it('rejects enumerable throwing getters on top-level, item, and evidence records', async () => {
    await assertShapeOnce(defineThrowingGetter({ evidence: [] }, 'items'));

    const item = defineThrowingGetter(validEventItem(), 'claim');
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });

    const evidence = defineThrowingGetter(validEventEvidence(), 'relation');
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });
  });

  it('rejects accessor properties on top-level, item, and evidence records', async () => {
    const top = validEventResponse();
    await assertShapeOnce(defineAccessor(top, 'items', top.items));

    const item = defineAccessor(validEventItem(), 'status', 'active');
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });

    const evidence = defineAccessor(validEventEvidence(), 'episodeKey', 'move-kazan-2022');
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });
  });

  it('rejects symbol-keyed properties on top-level, item, and evidence records', async () => {
    const top = validEventResponse();
    top[Symbol('hidden')] = SENTINELS.getter;
    await assertShapeOnce(top);

    const item = validEventItem();
    item[Symbol('hidden')] = SENTINELS.getter;
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });

    const evidence = validEventEvidence();
    evidence[Symbol('hidden')] = SENTINELS.getter;
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });
  });

  it('rejects non-enumerable unknown properties on top-level, item, and evidence records', async () => {
    const top = validEventResponse();
    Object.defineProperty(top, 'hidden', {
      enumerable: false,
      value: SENTINELS.getter,
    });
    await assertShapeOnce(top);

    const item = validEventItem();
    Object.defineProperty(item, 'hidden', {
      enumerable: false,
      value: SENTINELS.getter,
    });
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });

    const evidence = validEventEvidence();
    Object.defineProperty(evidence, 'hidden', {
      enumerable: false,
      value: SENTINELS.getter,
    });
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });
  });

  it('rejects a Proxy whose ownKeys throws', async () => {
    const top = new Proxy(validEventResponse(), {
      ownKeys() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce(top);

    const item = new Proxy(validEventItem(), {
      ownKeys() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });

    const evidence = new Proxy(validEventEvidence(), {
      ownKeys() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });
  });

  it('rejects a Proxy whose getPrototypeOf throws', async () => {
    const top = new Proxy(validEventResponse(), {
      getPrototypeOf() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce(top);

    const item = new Proxy(validEventItem(), {
      getPrototypeOf() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });

    const evidence = new Proxy(validEventEvidence(), {
      getPrototypeOf() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });
  });

  it('rejects arrays with extra named or symbol properties', async () => {
    const namedItems = validEventResponse();
    namedItems.items.extra = SENTINELS.getter;
    await assertShapeOnce(namedItems);

    const namedEvidence = validEventResponse();
    namedEvidence.evidence.extra = SENTINELS.getter;
    await assertShapeOnce(namedEvidence);

    const symbolItems = validEventResponse();
    symbolItems.items[Symbol('hidden')] = SENTINELS.getter;
    await assertShapeOnce(symbolItems);

    const symbolEvidence = validEventResponse();
    symbolEvidence.evidence[Symbol('hidden')] = SENTINELS.getter;
    await assertShapeOnce(symbolEvidence);
  });

  it('rejects a cyclic object used as claim', async () => {
    const cyclic = {};
    cyclic.self = cyclic;
    await assertShapeOnce({
      items: [validEventItem({ claim: cyclic })],
      evidence: [validEventEvidence()],
    });
  });

  it('rejects non-string identity and enum fields as shape', async () => {
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ itemRef: 1 })] }),
    );
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ kind: 1 })] }),
    );
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ status: true })] }),
    );
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ sensitivity: {} })] }),
    );
  });

  it('rejects dates and alternative that are not string or null', async () => {
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ eventTimeStart: 2022 })] }),
    );
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ eventTimeEnd: false })] }),
    );
    await assertShapeOnce(
      validEventResponse({ items: [validEventItem({ alternative: 0 })] }),
    );
  });

  it('rejects evidence fields that are not strings', async () => {
    await assertShapeOnce(
      validEventResponse({ evidence: [validEventEvidence({ itemRef: 1 })] }),
    );
    await assertShapeOnce(
      validEventResponse({
        evidence: [validEventEvidence({ sourceMessageId: ['m1'] })],
      }),
    );
    await assertShapeOnce(
      validEventResponse({ evidence: [validEventEvidence({ episodeKey: 1 })] }),
    );
    await assertShapeOnce(
      validEventResponse({ evidence: [validEventEvidence({ relation: null })] }),
    );
  });

  it('does not trust a spoofed MemoryV3ExtractorError name from adapter objects', async () => {
    function fakeMemoryV3Error() {
      const error = new Error(SENTINELS.fakeBrand);
      error.name = 'MemoryV3ExtractorError';
      return error;
    }

    const items = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') throw fakeMemoryV3Error();
        return Reflect.get(target, property, receiver);
      },
    });

    await assertShapeOnce({
      items,
      evidence: [],
    });
  });
});

describe('projectSafeExtractorDiagnostic', () => {
  async function thrownFrom(payloadOrAdapter) {
    const adapter =
      typeof payloadOrAdapter === 'function' ? payloadOrAdapter : async () => payloadOrAdapter;
    try {
      await extractCase(sampleCase(), adapter, OPTIONS);
    } catch (error) {
      return error;
    }
    throw new Error('expected extractCase to throw');
  }

  function assertSafeCode(error, code) {
    assert.equal(projectSafeExtractorDiagnostic(error), code);
    assert.equal(error.diagnosticCode, code);
    assert.equal(error.cause == null, true);
    assert.equal(String(error.message).includes('retry'), false);
    assertNoSecrets(error);
  }

  it('projects allowlisted codes from branded extractor failures', async () => {
    const table = [
      {
        name: 'missing required relation',
        code: 'extractor_contract_missing_required_relation',
        payload: validEventResponse({
          evidence: [validEventEvidence({ relation: 'contradicts' })],
        }),
      },
      {
        name: 'insufficient recurrence episodes',
        code: 'extractor_contract_insufficient_recurrence_episodes',
        payload: {
          items: [
            validEventItem({
              kind: 'recurrence',
              status: 'active',
              eventTimeStart: null,
              eventTimeEnd: null,
              claim: SENTINELS.claim,
            }),
          ],
          evidence: [validEventEvidence()],
        },
      },
      {
        name: 'hypothesis alternative',
        code: 'extractor_contract_hypothesis_alternative',
        payload: {
          items: [
            validEventItem({
              kind: 'hypothesis',
              status: 'candidate',
              alternative: null,
              claim: SENTINELS.claim,
            }),
          ],
          evidence: [validEventEvidence()],
        },
      },
      {
        name: 'invalid status',
        code: 'extractor_contract_invalid_status',
        payload: validEventResponse({
          items: [validEventItem({ status: 'candidate', claim: SENTINELS.claim })],
        }),
      },
      {
        name: 'duplicate evidence',
        code: 'extractor_contract_duplicate_evidence',
        payload: validEventResponse({
          evidence: [validEventEvidence(), validEventEvidence()],
        }),
      },
      {
        name: 'invalid date',
        code: 'extractor_contract_invalid_date',
        payload: validEventResponse({
          items: [validEventItem({ eventTimeStart: '2023-02-29', eventTimeEnd: '2023-02-29' })],
        }),
      },
      {
        name: 'generic contract',
        code: 'extractor_contract_invalid',
        payload: validEventResponse({
          evidence: [validEventEvidence({ sourceMessageId: 'm2', relation: 'supports' })],
        }),
      },
      {
        name: 'shape',
        code: 'extractor_shape_invalid',
        payload: validEventResponse({ extra: true }),
      },
      {
        name: 'parse',
        code: 'extractor_parse_invalid',
        payload: '{',
      },
    ];

    for (const entry of table) {
      const error = await thrownFrom(entry.payload);
      assertSafeCode(error, entry.code);
    }

    const adapterCalls = [];
    const adapterError = await thrownFrom(async () => {
      adapterCalls.push(1);
      throw new Error(SENTINELS.adapter);
    });
    assertSafeCode(adapterError, 'extractor_adapter_failed');
    assert.equal(adapterCalls.length, 1);
  });

  it('rejects spoofed diagnostics and does not execute getters', async () => {
    let getterCalls = 0;
    const spoof = {
      name: 'MemoryV3ExtractorError',
      message: '[memory-v3:contract] normalized extraction is contract-invalid',
      diagnosticCode: 'extractor_contract_invalid',
    };
    Object.defineProperty(spoof, 'diagnosticCode', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    assert.equal(projectSafeExtractorDiagnostic(spoof), null);
    assert.equal(projectSafeExtractorDiagnostic({ diagnosticCode: 'extractor_contract_invalid' }), null);
    assert.equal(getterCalls, 0);

    const branded = await thrownFrom(
      validEventResponse({
        items: [validEventItem({ status: 'candidate', claim: SENTINELS.claim })],
      }),
    );
    Object.defineProperty(branded, 'name', { value: 'SpoofedName' });
    assert.equal(projectSafeExtractorDiagnostic(branded), 'extractor_contract_invalid_status');
  });
});

describe('extractor diagnostic allowlist naming', () => {
  it('treats allowlisted as a value check, not a branding proof', () => {
    assert.equal('isTrustedExtractorDiagnosticCode' in extractorCore, false);
    assert.equal(typeof extractorCore.isAllowlistedExtractorDiagnosticCode, 'function');
    assert.equal(
      extractorCore.isAllowlistedExtractorDiagnosticCode('extractor_unknown_failure'),
      true,
    );
    assert.equal(
      extractorCore.isAllowlistedExtractorDiagnosticCode('extractor_adapter_failed'),
      true,
    );
    const spoof = { diagnosticCode: 'extractor_adapter_failed' };
    assert.equal(projectSafeExtractorDiagnostic(spoof), null);
    assert.equal(
      extractorCore.isAllowlistedExtractorDiagnosticCode(spoof.diagnosticCode),
      true,
    );
  });
});
