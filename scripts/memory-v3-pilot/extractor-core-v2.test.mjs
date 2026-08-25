/**
 * Memory V3 V2 extractor core tests.
 * Fake adapters only. No network, provider, filesystem, or env I/O.
 * Run: node --test scripts/memory-v3-pilot/extractor-core-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { makeLocalItemKey, makeRunKey, validateCase, validateExtraction } from './contracts.mjs';
import { V2_ADAPTER_EVIDENCE_FIELDS, validateCaseV2, validateExtractionV2 } from './contracts-v2.mjs';
import { extractCase } from './extractor-core.mjs';
import { extractCaseV2, projectSafeExtractorDiagnosticV2 } from './extractor-core-v2.mjs';
import { buildExtractorRequestV2 } from './extractor-prompt-v2.mjs';

const EXTRACTOR_VERSION = 'memory-v3-v2-test';
const OPTIONS = Object.freeze({ extractorVersion: EXTRACTOR_VERSION });
const RELATIONS = Object.freeze(['supports', 'contradicts', 'corrects', 'rejects']);
const ITEM_ADAPTER_FIELDS = Object.freeze([
  'itemRef',
  'kind',
  'claim',
  'status',
  'sensitivity',
  'eventTimeStart',
  'eventTimeEnd',
  'alternative',
]);

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

function emptyGold() {
  return {
    required: { events: [], recurrences: [], hypotheses: [] },
    acceptable: { events: [], recurrences: [], hypotheses: [] },
  };
}

function v2Case(overrides = {}) {
  return {
    caseId: 'core-v2-case-01',
    title: SENTINELS.title,
    category: SENTINELS.category,
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: `${SENTINELS.dialogue} Синтетический первый эпизод.`,
        createdAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'user',
        text: 'Синтетический второй эпизод.',
        createdAt: '2024-01-10T10:01:00.000Z',
      },
      {
        id: 'mA',
        role: 'assistant',
        text: 'Контекст ассистента.',
        createdAt: '2024-01-10T10:00:05.000Z',
      },
      {
        id: 'mS',
        role: 'system',
        text: 'Системный контекст.',
        createdAt: '2024-01-10T10:00:01.000Z',
      },
    ],
    gold: {
      required: {
        events: [
          {
            goldItemId: 'required-event-01',
            claim: SENTINELS.gold,
            supportMessageIds: ['m1'],
          },
        ],
        recurrences: [],
        hypotheses: [],
      },
      acceptable: { events: [], recurrences: [], hypotheses: [] },
    },
    mustNotRemember: [{ claim: SENTINELS.forbidden, reason: 'x', sourceMessageIds: ['m1'] }],
    ...overrides,
  };
}

function twoEpisodeCase() {
  return v2Case({ gold: emptyGold() });
}

function v1Case() {
  return {
    caseId: 'core-v1-regression-01',
    title: SENTINELS.title,
    category: SENTINELS.category,
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'Синтетический V1 эпизод.',
        createdAt: '2024-01-10T10:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'Контекст.',
        createdAt: '2024-01-10T10:00:05.000Z',
      },
    ],
    gold: {
      events: [{ claim: 'Синтетическое событие', supportMessageIds: ['m1'] }],
      recurrences: [],
      hypotheses: [],
    },
  };
}

function validEventItem(overrides = {}) {
  return {
    itemRef: 'item-1',
    kind: 'event',
    claim: 'Синтетическое событие',
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
    relation: 'supports',
    supportType: null,
    episodeKey: 'episode:m1',
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
    claim: 'Синтетическое событие',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: '2022-05-01',
    eventTimeEnd: '2022-05-31',
    alternative: null,
    scope: 'cross_conversation',
    conversationId: null,
  };
}

function validRecurrenceItem(overrides = {}) {
  return {
    itemRef: 'r1',
    kind: 'recurrence',
    claim: 'Синтетическое повторение',
    status: 'active',
    sensitivity: 'normal',
    eventTimeStart: null,
    eventTimeEnd: null,
    alternative: null,
    ...overrides,
  };
}

function validRecurrenceResponse() {
  return {
    items: [validRecurrenceItem()],
    evidence: [
      {
        itemRef: 'r1',
        sourceMessageId: 'm1',
        relation: 'supports',
        supportType: 'episode_observation',
        episodeKey: 'episode:m1',
      },
      {
        itemRef: 'r1',
        sourceMessageId: 'm2',
        relation: 'supports',
        supportType: 'episode_observation',
        episodeKey: 'episode:m2',
      },
    ],
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
  assert.match(String(error.message), new RegExp(`^\\[memory-v3:v2-${stage}\\]`));
}

function assertNoSecrets(error) {
  const message = String(error && error.message);
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(message.includes(sentinel), false, `error.message leaked ${sentinel}`);
    assert.equal(serialized.includes(sentinel), false, `error serialization leaked ${sentinel}`);
  }
  assert.equal(Object.hasOwn(error, 'cause'), false);
}

async function assertRejectsStage(fn, stage) {
  await assert.rejects(fn, (error) => {
    assertStage(error, stage);
    assertNoSecrets(error);
    return true;
  });
}

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
  await assertRejectsStage(() => extractCaseV2(v2Case(), adapter, OPTIONS), 'shape');
  assert.equal(calls, 1);
}

describe('extractCaseV2 valid empty abstention', () => {
  it('returns a trusted empty extraction and calls the adapter once with the prompt request', async () => {
    const caseData = v2Case();
    const snapshot = structuredClone(caseData);
    assert.doesNotThrow(() => validateCaseV2(caseData));
    const adapter = recordingAdapter({ items: [], evidence: [] });

    const extraction = await extractCaseV2(caseData, adapter, OPTIONS);

    assert.deepEqual(extraction, {
      run: { caseId: 'core-v2-case-01', extractorVersion: EXTRACTOR_VERSION },
      items: [],
      evidence: [],
    });
    assert.doesNotThrow(() => validateExtractionV2(extraction, caseData));
    assert.equal(adapter.calls.length, 1);
    assert.deepEqual(adapter.calls[0], buildExtractorRequestV2(caseData));
    const serializedRequest = JSON.stringify(adapter.calls[0]);
    for (const sentinel of [SENTINELS.gold, SENTINELS.forbidden, SENTINELS.title, SENTINELS.category, 'goldItemId', 'mustNotRemember']) {
      assert.equal(serializedRequest.includes(sentinel), false, `request leaked ${sentinel}`);
    }
    assert.deepEqual(caseData, snapshot);
  });
});

describe('extractCaseV2 valid event normalization', () => {
  it('adds trusted run, scope, keys, and cited-message provenance without mutating inputs', async () => {
    const caseData = v2Case();
    const snapshot = structuredClone(caseData);
    const payload = validEventResponse();
    const payloadSnapshot = structuredClone(payload);
    assert.deepEqual(Object.keys(payload.items[0]).sort(), [...ITEM_ADAPTER_FIELDS].sort());
    assert.deepEqual(Object.keys(payload.evidence[0]), [...V2_ADAPTER_EVIDENCE_FIELDS]);

    const extraction = await extractCaseV2(caseData, async () => payload, OPTIONS);
    const expectedItem = expectedNormalizedEventItem();
    const localItemKey = makeLocalItemKey(expectedItem, 0);

    assert.deepEqual(extraction.run, {
      caseId: 'core-v2-case-01',
      extractorVersion: EXTRACTOR_VERSION,
    });
    assert.equal(extraction.items[0].scope, 'cross_conversation');
    assert.equal(extraction.items[0].conversationId, null);
    assert.equal(extraction.items[0].localItemKey, localItemKey);
    assert.equal('itemRef' in extraction.items[0], false);
    assert.equal('itemRef' in extraction.evidence[0], false);
    assert.equal(extraction.evidence[0].itemKey, localItemKey);
    assert.equal(extraction.evidence[0].provenanceRole, 'user');
    assert.equal(extraction.evidence[0].mentionTime, caseData.messages[0].createdAt);
    assert.equal(extraction.evidence[0].supportType, null);
    assert.equal(extraction.evidence[0].episodeKey, 'episode:m1');
    assert.deepEqual(caseData, snapshot);
    assert.deepEqual(payload, payloadSnapshot);
    assert.doesNotThrow(() => validateExtractionV2(extraction, caseData));
  });
});

describe('extractCaseV2 valid recurrence', () => {
  it('calls the adapter once and keeps supportType', async () => {
    const adapter = recordingAdapter(validRecurrenceResponse());
    const out = await extractCaseV2(twoEpisodeCase(), adapter, OPTIONS);
    assert.equal(adapter.calls.length, 1);
    assert.equal(out.evidence[0].supportType, 'episode_observation');
    assert.equal(out.evidence[1].supportType, 'episode_observation');
    assert.equal(out.evidence[0].episodeKey, 'episode:m1');
    assert.equal(out.evidence[1].episodeKey, 'episode:m2');
    assert.equal(out.items[0].scope, 'cross_conversation');
    assert.doesNotThrow(() => validateExtractionV2(out, twoEpisodeCase()));
  });
});

describe('extractCaseV2 JSON string and plain object', () => {
  it('accepts the same valid event as a plain object and as JSON.stringify', async () => {
    const caseData = v2Case();
    const payload = validEventResponse();
    const asObject = await extractCaseV2(caseData, async () => structuredClone(payload), OPTIONS);
    const asString = await extractCaseV2(caseData, async () => JSON.stringify(payload), OPTIONS);
    assert.deepEqual(asObject, asString);
    assert.doesNotThrow(() => validateExtractionV2(asObject, caseData));
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
        () => extractCaseV2(v2Case(), async () => payload, OPTIONS),
        stage,
      );
    });
  }
});

describe('extractCaseV2 strict top-level item and evidence shape', () => {
  it('rejects missing, unknown, duplicate, and unresolved adapter fields', async () => {
    await assertRejectsStage(
      () => extractCaseV2(v2Case(), async () => ({ items: [], evidence: [], run: { caseId: 'nope' } }), OPTIONS),
      'shape',
    );

    const missingSupportType = validEventResponse();
    delete missingSupportType.evidence[0].supportType;
    await assertRejectsStage(
      () => extractCaseV2(v2Case(), async () => missingSupportType, OPTIONS),
      'shape',
    );

    const unknownEvidenceField = validEventResponse();
    unknownEvidenceField.evidence[0].mentionTime = '2024-01-10T10:00:00.000Z';
    await assertRejectsStage(
      () => extractCaseV2(v2Case(), async () => unknownEvidenceField, OPTIONS),
      'shape',
    );

    const missingItemField = validEventResponse();
    delete missingItemField.items[0].alternative;
    await assertRejectsStage(
      () => extractCaseV2(v2Case(), async () => missingItemField, OPTIONS),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCaseV2(
          v2Case(),
          async () => validEventResponse({ items: [validEventItem({ itemRef: '' })] }),
          OPTIONS,
        ),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCaseV2(
          v2Case(),
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
        extractCaseV2(
          v2Case(),
          async () => validEventResponse({ evidence: [validEventEvidence({ itemRef: 'missing' })] }),
          OPTIONS,
        ),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCaseV2(
          v2Case(),
          async () =>
            validEventResponse({
              evidence: [validEventEvidence({ sourceMessageId: 'missing-message' })],
            }),
          OPTIONS,
        ),
      'shape',
    );
  });
});

describe('extractCaseV2 JSON-data-only objects', () => {
  it('rejects enumerable throwing getters on top-level, item, evidence, and options', async () => {
    await assertShapeOnce(defineThrowingGetter({ evidence: [] }, 'items'));
    const item = defineThrowingGetter(validEventItem(), 'claim');
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });
    const evidence = defineThrowingGetter(validEventEvidence(), 'relation');
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });

    let calls = 0;
    const adapter = async () => {
      calls += 1;
      return { items: [], evidence: [] };
    };
    await assertRejectsStage(
      () => extractCaseV2(v2Case(), adapter, defineThrowingGetter({ extractorVersion: EXTRACTOR_VERSION }, 'extractorVersion')),
      'shape',
    );
    assert.equal(calls, 0);
  });

  it('rejects accessor, symbol, and non-enumerable fields', async () => {
    const top = validEventResponse();
    await assertShapeOnce(defineAccessor(top, 'items', top.items));
    const item = defineAccessor(validEventItem(), 'status', 'active');
    await assertShapeOnce({ items: [item], evidence: [validEventEvidence()] });
    const evidence = defineAccessor(validEventEvidence(), 'episodeKey', 'episode:m1');
    await assertShapeOnce({ items: [validEventItem()], evidence: [evidence] });

    const withSymbol = validEventResponse();
    withSymbol[Symbol('hidden')] = SENTINELS.getter;
    await assertShapeOnce(withSymbol);

    const hidden = validEventResponse();
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: SENTINELS.getter });
    await assertShapeOnce(hidden);
  });

  it('rejects sparse arrays, extra array keys, throwing proxies, and cyclic claims', async () => {
    const sparse = validEventResponse();
    sparse.items[2] = validEventItem({ itemRef: 'item-2', claim: 'Другое' });
    await assertShapeOnce(sparse);

    const namedItems = validEventResponse();
    namedItems.items.extra = SENTINELS.getter;
    await assertShapeOnce(namedItems);

    const ownKeysProxy = new Proxy(validEventResponse(), {
      ownKeys() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce(ownKeysProxy);

    const protoProxy = new Proxy(validEventResponse(), {
      getPrototypeOf() {
        throw new Error(SENTINELS.getter);
      },
    });
    await assertShapeOnce(protoProxy);

    const cyclic = {};
    cyclic.self = cyclic;
    await assertShapeOnce({
      items: [validEventItem({ claim: cyclic })],
      evidence: [validEventEvidence()],
    });
  });
});

describe('extractCaseV2 adapter call rules', () => {
  it('rejects a non-function adapter, invalid options, and invalid case before any call', async () => {
    let calls = 0;
    const adapter = async () => {
      calls += 1;
      return { items: [], evidence: [] };
    };
    await assertRejectsStage(() => extractCaseV2(v2Case(), null, OPTIONS), 'shape');
    await assertRejectsStage(() => extractCaseV2(v2Case(), adapter, {}), 'shape');
    await assertRejectsStage(() => extractCaseV2(v2Case(), adapter, { extractorVersion: '' }), 'shape');
    await assertRejectsStage(
      () => extractCaseV2(v2Case(), adapter, { extractorVersion: EXTRACTOR_VERSION, retry: true }),
      'shape',
    );
    await assertRejectsStage(() => extractCaseV2({ caseId: 'bad' }, adapter, OPTIONS), 'shape');
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
    await assertRejectsStage(() => extractCaseV2(v2Case(), syncAdapter, OPTIONS), 'adapter');
    await assertRejectsStage(() => extractCaseV2(v2Case(), asyncAdapter, OPTIONS), 'adapter');
    assert.equal(counts.sync, 1);
    assert.equal(counts.async, 1);
  });
});

describe('extractCaseV2 evidence source policy', () => {
  for (const relation of RELATIONS) {
    for (const { id, role } of [
      { id: 'mA', role: 'assistant' },
      { id: 'mS', role: 'system' },
    ]) {
      it(`rejects ${role} ${relation} evidence`, async () => {
        await assertRejectsStage(
          () =>
            extractCaseV2(
              v2Case(),
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

  it('accepts user evidence when the status requires that relation and ignores adapter provenance', async () => {
    const extraction = await extractCaseV2(
      v2Case(),
      async () =>
        validEventResponse({
          items: [validEventItem({ status: 'corrected' })],
          evidence: [validEventEvidence({ relation: 'corrects' })],
        }),
      OPTIONS,
    );
    assert.equal(extraction.evidence[0].relation, 'corrects');
    assert.equal(extraction.evidence[0].provenanceRole, 'user');
    assert.equal(extraction.evidence[0].mentionTime, '2024-01-10T10:00:00.000Z');
    assert.equal('scope' in validEventItem(), false);
  });
});

describe('extractCaseV2 semantic contract delegation', () => {
  it('rejects one observation, confirmation instead of a second observation, and missing alternative', async () => {
    await assertRejectsStage(
      () =>
        extractCaseV2(
          twoEpisodeCase(),
          async () => ({
            items: [validRecurrenceItem()],
            evidence: [
              {
                itemRef: 'r1',
                sourceMessageId: 'm1',
                relation: 'supports',
                supportType: 'episode_observation',
                episodeKey: 'episode:m1',
              },
            ],
          }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCaseV2(
          twoEpisodeCase(),
          async () => ({
            items: [validRecurrenceItem()],
            evidence: [
              {
                itemRef: 'r1',
                sourceMessageId: 'm1',
                relation: 'supports',
                supportType: 'episode_observation',
                episodeKey: 'episode:m1',
              },
              {
                itemRef: 'r1',
                sourceMessageId: 'm2',
                relation: 'supports',
                supportType: 'pattern_confirmation',
                episodeKey: null,
              },
            ],
          }),
          OPTIONS,
        ),
      'contract',
    );

    const missingSupportType = validRecurrenceResponse();
    delete missingSupportType.evidence[1].supportType;
    await assertRejectsStage(
      () => extractCaseV2(twoEpisodeCase(), async () => missingSupportType, OPTIONS),
      'shape',
    );

    await assertRejectsStage(
      () =>
        extractCaseV2(
          v2Case(),
          async () => ({
            items: [
              validEventItem({
                kind: 'hypothesis',
                status: 'candidate',
                alternative: null,
                eventTimeStart: null,
                eventTimeEnd: null,
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
        extractCaseV2(
          v2Case(),
          async () =>
            validEventResponse({
              evidence: [validEventEvidence({ relation: 'contradicts' })],
            }),
          OPTIONS,
        ),
      'contract',
    );

    await assertRejectsStage(
      () =>
        extractCaseV2(
          v2Case(),
          async () => validEventResponse({ items: [validEventItem({ eventTimeStart: 'not-a-date' })] }),
          OPTIONS,
        ),
      'contract',
    );
  });
});

describe('extractCaseV2 diagnostics', () => {
  async function thrownFrom(payloadOrAdapter) {
    const adapter =
      typeof payloadOrAdapter === 'function' ? payloadOrAdapter : async () => payloadOrAdapter;
    try {
      await extractCaseV2(v2Case(), adapter, OPTIONS);
    } catch (error) {
      return error;
    }
    throw new Error('expected extractCaseV2 to throw');
  }

  function assertSafeCode(error, code) {
    assert.equal(projectSafeExtractorDiagnosticV2(error), code);
    assert.equal(error.diagnosticCode, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(String(error.message).includes('retry'), false);
    assertNoSecrets(error);
  }

  it('projects allowlisted codes from branded V2 extractor failures', async () => {
    const table = [
      {
        code: 'extractor_v2_adapter_failed',
        payload: () => {
          throw new Error(SENTINELS.adapter);
        },
      },
      {
        code: 'extractor_v2_parse_invalid',
        payload: '{',
      },
      {
        code: 'extractor_v2_shape_invalid',
        payload: validEventResponse({ evidence: [validEventEvidence({ extra: true })] }),
      },
      {
        code: 'extractor_v2_contract_missing_required_relation',
        payload: validEventResponse({
          evidence: [validEventEvidence({ relation: 'contradicts' })],
        }),
      },
      {
        code: 'extractor_v2_contract_insufficient_recurrence_episodes',
        payload: {
          items: [validRecurrenceItem({ claim: SENTINELS.claim })],
          evidence: [
            {
              itemRef: 'r1',
              sourceMessageId: 'm1',
              relation: 'supports',
              supportType: 'episode_observation',
              episodeKey: 'episode:m1',
            },
          ],
        },
      },
      {
        code: 'extractor_v2_contract_hypothesis_alternative',
        payload: {
          items: [
            validEventItem({
              kind: 'hypothesis',
              status: 'candidate',
              alternative: null,
              eventTimeStart: null,
              eventTimeEnd: null,
              claim: SENTINELS.claim,
            }),
          ],
          evidence: [validEventEvidence()],
        },
      },
      {
        code: 'extractor_v2_contract_invalid',
        payload: validEventResponse({ items: [validEventItem({ eventTimeStart: 'not-a-date' })] }),
      },
    ];

    for (const row of table) {
      const error = await thrownFrom(row.payload);
      assertSafeCode(error, row.code);
    }
  });

  it('does not trust spoofed diagnostics, getters, or V1 branded errors', async () => {
    const spoofed = new Error('plain');
    spoofed.name = 'MemoryV3ExtractorError';
    spoofed.diagnosticCode = 'extractor_v2_adapter_failed';
    assert.equal(projectSafeExtractorDiagnosticV2(spoofed), null);

    const getterError = {};
    Object.defineProperty(getterError, 'diagnosticCode', {
      enumerable: true,
      get() {
        throw new Error(SENTINELS.getter);
      },
    });
    assert.equal(projectSafeExtractorDiagnosticV2(getterError), null);

    try {
      await extractCase(v1Case(), async () => ({ items: [], evidence: [] }), {
        extractorVersion: 'offline-core-v1',
      });
    } catch {
      assert.fail('V1 empty abstention should succeed');
    }
    try {
      await extractCase(v1Case(), () => {
        throw new Error(SENTINELS.adapter);
      }, { extractorVersion: 'offline-core-v1' });
    } catch (v1Error) {
      assert.equal(projectSafeExtractorDiagnosticV2(v1Error), null);
    }
  });
});

describe('extractCaseV2 deterministic identity', () => {
  it('repeats the same run and keys for identical inputs and does not sort adapter items', async () => {
    const caseData = v2Case();
    const payload = {
      items: [
        validEventItem({ itemRef: 'a', claim: 'Первый' }),
        validEventItem({ itemRef: 'b', claim: 'Второй', eventTimeStart: null, eventTimeEnd: null }),
      ],
      evidence: [
        validEventEvidence({ itemRef: 'a', episodeKey: 'ep-a' }),
        validEventEvidence({ itemRef: 'b', sourceMessageId: 'm2', episodeKey: 'ep-b' }),
      ],
    };
    const first = await extractCaseV2(caseData, async () => structuredClone(payload), OPTIONS);
    const second = await extractCaseV2(caseData, async () => structuredClone(payload), OPTIONS);
    assert.deepEqual(first, second);
    assert.equal(first.items[0].claim, 'Первый');
    assert.equal(first.items[1].claim, 'Второй');
    const runKeyA = makeRunKey({ caseId: caseData.caseId, extractorVersion: EXTRACTOR_VERSION });
    const runKeyB = makeRunKey({ caseId: caseData.caseId, extractorVersion: 'other-v2' });
    assert.notEqual(runKeyA, runKeyB);

    const swapped = {
      items: [payload.items[1], payload.items[0]],
      evidence: [payload.evidence[1], payload.evidence[0]],
    };
    const reordered = await extractCaseV2(caseData, async () => swapped, OPTIONS);
    assert.equal(reordered.items[0].claim, 'Второй');
    assert.notEqual(reordered.items[0].localItemKey, first.items[0].localItemKey);
  });
});

describe('extractCaseV2 validated-case composition', () => {
  it('E builds the same prompt request from a revalidated case without leaking gold', () => {
    const caseData = v2Case();
    const snapshot = structuredClone(caseData);
    const validated = validateCaseV2(caseData);
    const fromValidated = buildExtractorRequestV2(validated);
    const fromRaw = buildExtractorRequestV2(caseData);
    assert.deepEqual(fromValidated, fromRaw);
    const serialized = JSON.stringify(fromValidated);
    for (const sentinel of [SENTINELS.gold, SENTINELS.forbidden, SENTINELS.title, SENTINELS.category, 'goldItemId', 'mustNotRemember']) {
      assert.equal(serialized.includes(sentinel), false, `request leaked ${sentinel}`);
    }
    assert.deepEqual(caseData, snapshot);
    assert.deepEqual(validateCaseV2(validated), validated);
  });

  it('F extracts through the first validateCaseV2 result as the request and contract source', async () => {
    const source = readFileSync(new URL('./extractor-core-v2.mjs', import.meta.url), 'utf8');
    assert.match(source, /buildExtractorRequestV2\(\s*validated\s*\)/);
    assert.match(source, /validateExtractionV2\(\s*extraction\s*,\s*validated\s*\)/);
    assert.doesNotMatch(source, /\boriginalCase\b/);
    assert.doesNotMatch(source, /buildExtractorRequestV2\(\s*caseData\s*\)/);
    assert.doesNotMatch(source, /validateExtractionV2\([^)]*caseData/);

    const raw = v2Case();
    const snapshot = structuredClone(raw);
    const validated = validateCaseV2(raw);
    const adapter = recordingAdapter(validEventResponse());
    const extraction = await extractCaseV2(validated, adapter, OPTIONS);

    assert.equal(adapter.calls.length, 1);
    assert.deepEqual(adapter.calls[0], buildExtractorRequestV2(validated));
    assert.doesNotThrow(() => validateExtractionV2(extraction, validated));
    assert.deepEqual(await extractCaseV2(raw, recordingAdapter(validEventResponse()), OPTIONS), extraction);
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(validateCaseV2(validated), validated);
  });
});

describe('extractCaseV2 frozen V1 regression', () => {
  it('keeps public V1 extractCase working and rejects V2 typed evidence in V1', async () => {
    const extraction = await extractCase(v1Case(), async () => ({
      items: [
        {
          itemRef: 'item-1',
          kind: 'event',
          claim: 'Синтетическое событие',
          status: 'active',
          sensitivity: 'normal',
          eventTimeStart: null,
          eventTimeEnd: null,
          alternative: null,
        },
      ],
      evidence: [
        {
          itemRef: 'item-1',
          sourceMessageId: 'm1',
          episodeKey: 'episode:m1',
          relation: 'supports',
        },
      ],
    }), { extractorVersion: 'offline-core-v1' });
    assert.doesNotThrow(() => validateExtraction(extraction, v1Case()));
    assert.doesNotThrow(() => validateCase(v1Case()));

    await assert.rejects(
      () =>
        extractCase(
          v1Case(),
          async () => ({
            items: [
              {
                itemRef: 'item-1',
                kind: 'event',
                claim: 'Синтетическое событие',
                status: 'active',
                sensitivity: 'normal',
                eventTimeStart: null,
                eventTimeEnd: null,
                alternative: null,
              },
            ],
            evidence: [
              {
                itemRef: 'item-1',
                sourceMessageId: 'm1',
                episodeKey: 'episode:m1',
                relation: 'supports',
                supportType: null,
              },
            ],
          }),
          { extractorVersion: 'offline-core-v1' },
        ),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:shape\]/);
        return true;
      },
    );
  });
});
