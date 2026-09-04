/**
 * Memory V3 V2 six-case live-benchmark harness tests.
 * Injected fake fetch only. No network, .env, live CLI, or paid provider calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-six-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SIX_CASE_BENCHMARK_CASE_IDS } from './live-benchmark-six.mjs';
import {
  SIX_CASE_BENCHMARK_V2_CASE_IDS,
  SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION,
  buildSixCaseSemanticReviewPacketV2,
  createAtMostSixOpenRouterFetch,
  runSixCaseLiveBenchmarkV2,
} from './live-benchmark-six-v2.mjs';

const MODEL = 'google/gemini-3.7-flash';
const EXTRACTOR_VERSION =
  'memory-v3-openrouter-gemini-3.7-flash-six-v2-layer-decision-r2';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = 'test-memory-v3-six-case-v2-key';
const EMPTY_CONTENT = JSON.stringify({
  layerDecisions: [
    { kind: 'event', decision: 'omit', itemRefs: [] },
    { kind: 'recurrence', decision: 'omit', itemRefs: [] },
    { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
  ],
  items: [],
  evidence: [],
});
const EVENT_03_CLAIM = 'Сын родился 14 февраля 2018 года';
const EVENT_03_MESSAGE_TEXT =
  'На работу я вернулась не через год, а в сентябре 2020, когда ему было два с половиной.';
const SAFETY_03_ASSISTANT_TEXT = 'Наверное, в детстве тебя наказывали за любые просьбы.';
const CONFIG_PREFIX = '[memory-v3:live-benchmark-six-v2]';

const SENTINELS = Object.freeze({
  key: API_KEY,
  fetch: 'GLOBAL_FETCH_SENTINEL',
  getter: 'RAW_SIX_V2_GETTER_SECRET_SENTINEL',
  providerMessage: 'RAW_PROVIDER_MESSAGE_SENTINEL',
  providerMetadata: 'RAW_PROVIDER_METADATA_SENTINEL',
  response: 'RAW_PROVIDER_RESPONSE_SENTINEL',
  auth: 'Bearer RAW_AUTHORIZATION_SECRET',
  trap: 'RAW_PROXY_TRAP_SENTINEL',
});

const EVENT_03_CONTENT = JSON.stringify({
  layerDecisions: [
    { kind: 'event', decision: 'emit', itemRefs: ['item-1'] },
    { kind: 'recurrence', decision: 'omit', itemRefs: [] },
    { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
  ],
  items: [
    {
      itemRef: 'item-1',
      kind: 'event',
      claim: EVENT_03_CLAIM,
      status: 'active',
      sensitivity: 'normal',
      eventTimeStart: '2018-02-14',
      eventTimeEnd: '2018-02-14',
      alternative: null,
    },
  ],
  evidence: [
    {
      itemRef: 'item-1',
      sourceMessageId: 'm1',
      relation: 'supports',
      supportType: null,
      episodeKey: 'episode:m1',
    },
  ],
});

const REC_02_CONTENT = JSON.stringify({
  layerDecisions: [
    { kind: 'event', decision: 'omit', itemRefs: [] },
    { kind: 'recurrence', decision: 'emit', itemRefs: ['item-1'] },
    { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
  ],
  items: [
    {
      itemRef: 'item-1',
      kind: 'recurrence',
      claim: 'После конфликтов, сопровождаемых стыдом, прерывает контакт вместо разговора',
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
      relation: 'supports',
      supportType: 'episode_observation',
      episodeKey: 'episode:m1',
    },
    {
      itemRef: 'item-1',
      sourceMessageId: 'm2',
      relation: 'supports',
      supportType: 'episode_observation',
      episodeKey: 'episode:m2',
    },
    {
      itemRef: 'item-1',
      sourceMessageId: 'm4',
      relation: 'supports',
      supportType: 'pattern_confirmation',
      episodeKey: null,
    },
  ],
});

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function allowedBudget(overrides = {}) {
  return {
    caseCount: 6,
    maxInputTokensPerCase: 16384,
    maxOutputTokensPerCase: 1200,
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    maxRequests: 6,
    maxBudgetUsd: 0.11,
    ...overrides,
  };
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-six-v2',
    object: 'chat.completion',
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content, refusal: null },
      },
    ],
    usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
    secretProbe: SENTINELS.response,
  };
}

function jsonResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    async text() {
      return text;
    },
  };
}

function recordingFetch(payload = jsonResponse(officialOpenRouterHttpBody())) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (typeof payload === 'function') return payload(url, init);
    return payload;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function validOptions(overrides = {}) {
  return {
    dataset: overrides.dataset ?? loadGoldenDataset(),
    model: overrides.model ?? MODEL,
    extractorVersion: overrides.extractorVersion ?? EXTRACTOR_VERSION,
    budget: overrides.budget ?? allowedBudget(),
    maxPromptRequestBytesPerCase: overrides.maxPromptRequestBytesPerCase ?? 20000,
    execute: overrides.execute ?? false,
    ...overrides,
  };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `leaked ${sentinel}`);
  }
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('OPENROUTER_API_KEY'), false);
  assert.equal(serialized.includes('You extract StaySEE Memory V3 V2 items'), false);
}

async function assertPreflightReject(fn, fetchImpl) {
  await assert.rejects(async () => {
    await fn();
  }, (error) => {
    assert.match(String(error.message), /^\[memory-v3:live-benchmark-six-v2]/);
    assert.equal(error.cause == null, true);
    assert.equal('cause' in error, false);
    assertNoSecrets(error);
    return true;
  });
  if (fetchImpl && fetchImpl.calls) {
    assert.equal(fetchImpl.calls.length, 0);
  }
}

function caseIdFromRequest(init) {
  const body = JSON.parse(init.body);
  const input = JSON.parse(body.messages[1].content);
  return input.caseId;
}

describe('V2 six-case exports and frozen ids', () => {
  it('freezes the six case ids and locks V1/V2 extractor versions', () => {
    assert.deepEqual([...SIX_CASE_BENCHMARK_V2_CASE_IDS], [
      'memv3-ru-event-03',
      'memv3-ru-correction-04',
      'memv3-ru-recurrence-02',
      'memv3-ru-hypothesis-01',
      'memv3-ru-counterexample-01',
      'memv3-ru-safety-03',
    ]);
    assert.equal(Object.isFrozen(SIX_CASE_BENCHMARK_V2_CASE_IDS), true);
    assert.throws(() => {
      SIX_CASE_BENCHMARK_V2_CASE_IDS.push('memv3-ru-event-01');
    });
    assert.deepEqual([...SIX_CASE_BENCHMARK_CASE_IDS], [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
    assert.equal(SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION, EXTRACTOR_VERSION);
    const v1Cli = readFileSync(fileURLToPath(new URL('./live-benchmark-six-cli.mjs', import.meta.url)), 'utf8');
    assert.match(v1Cli, /memory-v3-openrouter-luna-six-v1/);
    const v2Source = readFileSync(fileURLToPath(new URL('./live-benchmark-six-v2.mjs', import.meta.url)), 'utf8');
    assert.equal(/runSixCaseLiveBenchmark(?!V2)\(/.test(v2Source), false);
    assert.equal(/from '\.\/live-benchmark-six\.mjs'/.test(v2Source), false);
    assert.equal(/from '\.\/evaluator\.mjs'/.test(v2Source), false);
    assert.equal(/from '\.\/benchmark-runner\.mjs'/.test(v2Source), false);
    assert.match(v2Source, /runOfflineBenchmarkV2/);
    assert.match(v2Source, /evaluateCaseV2/);
    assert.match(v2Source, /evaluateDatasetV2/);
    assert.match(v2Source, /validateCaseV2/);
    assert.match(v2Source, /buildExtractorRequestV2/);
  });
});

describe('runSixCaseLiveBenchmarkV2 selection preflight', () => {
  it('rejects V1 dataset identity and missing/duplicate/misaligned cases before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const v1Identity = loadGoldenDataset();
    v1Identity.datasetId = 'memory-v3-ru-golden-v1';
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({ dataset: v1Identity, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );

    const wrongVersion = loadGoldenDataset();
    wrongVersion.version = '1.0.0';
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({ dataset: wrongVersion, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );

    const dataset = loadGoldenDataset();
    dataset.cases = dataset.cases.filter((entry) => entry.caseId !== 'memv3-ru-event-03');
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );

    const duplicated = loadGoldenDataset();
    const original = duplicated.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    duplicated.cases.push(structuredClone(original));
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({ dataset: duplicated, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );

    const unknown = loadGoldenDataset();
    const entry = unknown.cases.find((item) => item.caseId === 'memv3-ru-event-03');
    entry.caseId = 'memv3-ru-unknown-99';
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({ dataset: unknown, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );
  });

  it('rejects sparse cases and does not execute option getters', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const sparse = [];
    sparse[0] = dataset.cases[0];
    sparse[2] = dataset.cases[1];
    dataset.cases = sparse;
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );

    let getterCalls = 0;
    const options = validOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    Object.defineProperty(options, 'extractorVersion', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertPreflightReject(() => runSixCaseLiveBenchmarkV2(options), fetchImpl);
    assert.equal(getterCalls, 0);
  });
});

describe('runSixCaseLiveBenchmarkV2 budget preflight', () => {
  it('passes the exact Gemini six-case ceiling and the $0.11 hard gate without HTTP', async () => {
    const exact = await runSixCaseLiveBenchmarkV2(
      validOptions({
        execute: false,
        budget: allowedBudget({ maxBudgetUsd: 0.100728 }),
      }),
    );
    assert.equal(exact.providerHttpCalls, 0);
    assert.equal(exact.configuredBudget.gate, 'PASS');
    assert.equal(exact.configuredBudget.absoluteCostUsd, '0.100728');
    assert.equal(exact.configuredBudget.inputCostUsd, '0.073728');
    assert.equal(exact.configuredBudget.outputCostUsd, '0.027');
    assert.equal(exact.configuredBudget.absoluteMaxRequests, 6);
    assert.equal(exact.configuredBudget.maxBudgetUsd, 0.100728);

    const hard = await runSixCaseLiveBenchmarkV2(validOptions({ execute: false }));
    assert.equal(hard.configuredBudget.gate, 'PASS');
    assert.equal(hard.configuredBudget.maxBudgetUsd, 0.11);
    assert.equal(hard.providerHttpCalls, 0);
  });

  it('fails below $0.100728 or mismatched counts with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({
            execute: true,
            apiKey: API_KEY,
            fetchImpl,
            budget: allowedBudget({ maxBudgetUsd: 0.10072799 }),
          }),
        ),
      fetchImpl,
    );
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmarkV2(
          validOptions({
            execute: true,
            apiKey: API_KEY,
            fetchImpl,
            budget: allowedBudget({ caseCount: 5 }),
          }),
        ),
      fetchImpl,
    );
  });
});

describe('runSixCaseLiveBenchmarkV2 dry-run', () => {
  it('returns a safe six-case plan without extraction, fetch, or dialogue text', async () => {
    const previous = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    try {
      const dataset = loadGoldenDataset();
      const snapshot = structuredClone(dataset);
      const result = await runSixCaseLiveBenchmarkV2(
        validOptions({
          dataset,
          execute: false,
        }),
      );
      assert.equal(globalFetchCalls, 0);
      assert.equal(result.providerHttpCalls, 0);
      assert.equal(result.attemptedCount, 0);
      assert.equal(result.successCount, 0);
      assert.equal(result.failureCount, 0);
      assert.equal(result.maxActive, 1);
      assert.deepEqual(result.caseIds, [...SIX_CASE_BENCHMARK_V2_CASE_IDS]);
      assert.equal(result.model, MODEL);
      assert.equal(result.extractorVersion, EXTRACTOR_VERSION);
      assert.equal(result.aggregate, null);
      assert.equal(result.actualUsage, null);
      assert.equal(result.actualCostUsd, null);
      assert.equal(result.cases.length, 6);
      for (const [index, entry] of result.cases.entries()) {
        assert.equal(entry.caseId, SIX_CASE_BENCHMARK_V2_CASE_IDS[index]);
        assert.equal(Object.prototype.hasOwnProperty.call(entry, 'evaluation'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(entry, 'items'), false);
      }
      assert.deepEqual(dataset, snapshot);
      assertNoSecrets(result);
      assert.equal(JSON.stringify(result).includes(EVENT_03_MESSAGE_TEXT), false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('runSixCaseLiveBenchmarkV2 fake fetch execution', () => {
  it('runs six successful cases sequentially with one POST each and official refusal null', async () => {
    const previous = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    try {
      let active = 0;
      let maxActive = 0;
      const order = [];
      const fetchImpl = recordingFetch(async (url, init) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const caseId = caseIdFromRequest(init);
        order.push(`start:${caseId}`);
        await Promise.resolve();
        order.push(`end:${caseId}`);
        active -= 1;
        const content = caseId === 'memv3-ru-event-03' ? EVENT_03_CONTENT : EMPTY_CONTENT;
        return jsonResponse(officialOpenRouterHttpBody(content));
      });
      const dataset = loadGoldenDataset();
      const snapshot = structuredClone(dataset);
      const result = await runSixCaseLiveBenchmarkV2(
        validOptions({
          dataset,
          execute: true,
          apiKey: API_KEY,
          fetchImpl,
        }),
      );
      assert.equal(globalFetchCalls, 0);
      assert.equal(fetchImpl.calls.length, 6);
      assert.equal(result.providerHttpCalls, 6);
      assert.equal(result.maxActive, 1);
      assert.equal(maxActive, 1);
      assert.deepEqual(
        order,
        SIX_CASE_BENCHMARK_V2_CASE_IDS.flatMap((caseId) => [`start:${caseId}`, `end:${caseId}`]),
      );
      assert.equal(result.attemptedCount, 6);
      assert.equal(result.successCount, 6);
      assert.equal(result.failureCount, 0);
      assert.equal(result.actualUsage, null);
      assert.equal(result.actualCostUsd, null);
      const event03 = result.cases[0];
      assert.equal(event03.caseId, 'memv3-ru-event-03');
      assert.equal(event03.itemCount, 1);
      assert.equal(event03.evidenceCount, 1);
      assert.equal(event03.evaluation.caseId, 'memv3-ru-event-03');
      assert.equal(event03.evidence[0].supportType, null);
      for (const call of fetchImpl.calls) {
        assert.equal(call.url, OPENROUTER_URL);
        assert.equal(call.init.method, 'POST');
        const httpBody = JSON.parse(call.init.body);
        assert.equal(httpBody.model, MODEL);
        assert.equal(httpBody.max_tokens, 1200);
        assert.equal('max_completion_tokens' in httpBody, false);
        assert.deepEqual(httpBody.reasoning, { effort: 'low' });
        assert.equal('reasoning_effort' in httpBody, false);
        assert.equal(httpBody.provider.allow_fallbacks, true);
        assert.equal(httpBody.provider.require_parameters, true);
        assert.equal(httpBody.provider.data_collection, 'deny');
        assert.equal(httpBody.provider.zdr, true);
        const jsonSchema = httpBody.response_format.json_schema;
        const evidence = jsonSchema.schema.properties.evidence.items;
        assert.equal(jsonSchema.name, 'memory_v3_v2_layered_extractor_response');
        assert.deepEqual(
          [...evidence.required].sort(),
          ['episodeKey', 'itemRef', 'relation', 'sourceMessageId', 'supportType'],
        );
        assert.deepEqual(evidence.properties.supportType, { type: ['string', 'null'] });
        assert.deepEqual(evidence.properties.episodeKey, { type: ['string', 'null'] });
      }
      assert.deepEqual(dataset, snapshot);
      assertNoSecrets(result);
      assert.equal(JSON.stringify(result).includes(EVENT_03_MESSAGE_TEXT), false);
      assert.equal(JSON.stringify(result).includes(SAFETY_03_ASSISTANT_TEXT), false);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('blocks a seventh fetch before the inner HTTP call', async () => {
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createAtMostSixOpenRouterFetch(inner);
    for (let index = 0; index < 6; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    assert.equal(innerCalls, 6);
    await assert.rejects(
      () => guarded(OPENROUTER_URL, { method: 'POST' }),
      (error) => String(error.message).startsWith(CONFIG_PREFIX),
    );
    assert.equal(innerCalls, 6);
  });

  it('continues after a middle-case failure without retry or inventing aggregate', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      if (caseId === 'memv3-ru-recurrence-02') {
        return jsonResponse({
          id: 'chatcmpl-fail',
          object: 'chat.completion',
          created: 1,
          model: MODEL,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: EMPTY_CONTENT,
                refusal: SENTINELS.providerMessage,
              },
            },
          ],
        });
      }
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const result = await runSixCaseLiveBenchmarkV2(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.providerHttpCalls, 6);
    assert.equal(result.attemptedCount, 6);
    assert.equal(result.successCount, 5);
    assert.equal(result.failureCount, 1);
    assert.equal(result.aggregate, null);
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(Object.keys(failed).sort(), ['caseId', 'diagnosticCode', 'stage']);
    assert.equal(failed.stage, 'adapter');
    assert.equal(failed.diagnosticCode, 'openrouter_refusal');
    assert.equal(Object.prototype.hasOwnProperty.call(failed, 'evaluation'), false);
    assertNoSecrets(result);
  });

  it('keeps a trusted V2 extractor contract diagnostic', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      if (caseId === 'memv3-ru-correction-04') {
        return jsonResponse(
          officialOpenRouterHttpBody(
            JSON.stringify({
              layerDecisions: [
                { kind: 'event', decision: 'emit', itemRefs: ['item-1'] },
                { kind: 'recurrence', decision: 'omit', itemRefs: [] },
                { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
              ],
              items: [
                {
                  itemRef: 'item-1',
                  kind: 'event',
                  claim: 'SENTINEL_CORRECTION_CLAIM',
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
                  relation: 'contradicts',
                  supportType: null,
                  episodeKey: 'episode:m1',
                },
              ],
            }),
          ),
        );
      }
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const result = await runSixCaseLiveBenchmarkV2(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-correction-04');
    assert.equal(failed.stage, 'contract');
    assert.equal(failed.diagnosticCode, 'extractor_v2_contract_missing_required_relation');
    assert.equal(JSON.stringify(result).includes('SENTINEL_CORRECTION_CLAIM'), false);
    assertNoSecrets(result);
  });

  it('does not trust a spoofed diagnosticCode from fetchImpl', async () => {
    const fetchImpl = recordingFetch(async () => {
      const error = new Error(SENTINELS.providerMessage);
      error.name = 'MemoryV3OpenRouterError';
      Object.defineProperty(error, 'diagnosticCode', {
        value: 'openrouter_http_402',
        enumerable: true,
      });
      throw error;
    });
    const result = await runSixCaseLiveBenchmarkV2(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    assert.equal(result.providerHttpCalls, 6);
    assert.equal(result.failureCount, 6);
    assert.equal(result.aggregate, null);
    for (const entry of result.cases) {
      assert.equal(entry.diagnosticCode, 'transport_request_failed');
      assert.deepEqual(Object.keys(entry).sort(), ['caseId', 'diagnosticCode', 'stage']);
    }
    assertNoSecrets(result);
  });
});

describe('runSixCaseLiveBenchmarkV2 aggregation', () => {
  it('aggregates V2 required/acceptable totals without semantic scoring', async () => {
    const result = await runSixCaseLiveBenchmarkV2(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl: recordingFetch(),
      }),
    );
    assert.equal(result.successCount, 6);
    assert.equal(result.aggregate.items.required.gold, 6);
    assert.equal(result.aggregate.items.required.matched, 0);
    assert.equal(result.aggregate.items.acceptable.gold, 2);
    assert.equal(result.aggregate.items.acceptable.matched, 0);
    assert.equal(result.aggregate.items.extraFalsePositives, 0);
    assert.equal(result.aggregate.recurrenceEpisodes.eligible, 1);
    assert.equal(result.aggregate.recurrenceEpisodes.exact, 0);
    assert.equal(result.aggregate.semanticClaims.status, 'not_evaluated');
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    assertNoSecrets(result);
  });
});

describe('buildSixCaseSemanticReviewPacketV2', () => {
  function assertPacketRejected(dataset, benchmarkResult) {
    assert.throws(
      () => buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult }),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:live-benchmark-six-v2]/);
        assert.equal(error.cause == null, true);
        assertNoSecrets(error);
        return true;
      },
    );
  }

  it('includes synthetic messages, goldItemId/tier, and supportType without mutating inputs', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      const content = caseId === 'memv3-ru-event-03' ? EVENT_03_CONTENT : EMPTY_CONTENT;
      return jsonResponse(officialOpenRouterHttpBody(content));
    });
    const benchmarkResult = await runSixCaseLiveBenchmarkV2(
      validOptions({
        dataset,
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    const resultSnapshot = structuredClone(benchmarkResult);
    const packet = buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult });
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(benchmarkResult, resultSnapshot);
    assert.equal(packet.cases.length, 6);
    for (const [index, entry] of packet.cases.entries()) {
      assert.equal(entry.caseId, SIX_CASE_BENCHMARK_V2_CASE_IDS[index]);
      assert.equal(typeof entry.category, 'string');
      assert.equal(typeof entry.title, 'string');
      assert.equal(Array.isArray(entry.gold.required), true);
      assert.equal(Array.isArray(entry.gold.acceptable), true);
      assert.equal(entry.semanticVerdict, null);
      assert.equal(entry.forbiddenMeaningVerdict, null);
      assert.equal(entry.reviewerNotes, null);
      for (const message of entry.messages) {
        assert.deepEqual(Object.keys(message).sort(), ['id', 'role', 'text']);
        assert.equal(Object.prototype.hasOwnProperty.call(message, 'createdAt'), false);
      }
      for (const item of [...entry.gold.required, ...entry.gold.acceptable]) {
        assert.equal(typeof item.goldItemId, 'string');
        assert.equal(item.tier === 'required' || item.tier === 'acceptable', true);
      }
    }
    const event03 = packet.cases[0];
    assert.equal(event03.gold.required[0].goldItemId, 'required-event-01');
    assert.equal(event03.gold.required[0].tier, 'required');
    assert.equal(event03.gold.acceptable.length, 0);
    assert.equal(event03.predicted[0].claim, EVENT_03_CLAIM);
    assert.equal(event03.predictedEvidence[0].supportType, null);
    assert.equal(event03.messages.some((message) => message.text === EVENT_03_MESSAGE_TEXT), true);
    const hypothesis01 = packet.cases[3];
    assert.equal(hypothesis01.gold.required.some((item) => item.kind === 'hypothesis'), true);
    assert.equal(hypothesis01.gold.acceptable[0].goldItemId, 'acceptable-recurrence-01');
    assert.equal(hypothesis01.gold.acceptable[0].tier, 'acceptable');
    assert.equal(
      hypothesis01.gold.required.some((item) => item.goldItemId === 'acceptable-recurrence-01'),
      false,
    );
    const safety03 = packet.cases[5];
    assert.equal(
      safety03.messages.some(
        (message) => message.role === 'assistant' && message.text === SAFETY_03_ASSISTANT_TEXT,
      ),
      true,
    );
    assert.equal(JSON.stringify(benchmarkResult).includes(EVENT_03_MESSAGE_TEXT), false);
    assertNoSecrets(packet);
  });

  it('keeps typed recurrence supportType and null episodeKey on confirmation rows', async () => {
    const dataset = loadGoldenDataset();
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      const content =
        caseId === 'memv3-ru-recurrence-02'
          ? REC_02_CONTENT
          : caseId === 'memv3-ru-event-03'
            ? EVENT_03_CONTENT
            : EMPTY_CONTENT;
      return jsonResponse(officialOpenRouterHttpBody(content));
    });
    const benchmarkResult = await runSixCaseLiveBenchmarkV2(
      validOptions({
        dataset,
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    const recurrence = benchmarkResult.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(recurrence.evidence, [
      {
        sourceMessageId: 'm1',
        relation: 'supports',
        supportType: 'episode_observation',
        episodeKey: 'episode:m1',
      },
      {
        sourceMessageId: 'm2',
        relation: 'supports',
        supportType: 'episode_observation',
        episodeKey: 'episode:m2',
      },
      {
        sourceMessageId: 'm4',
        relation: 'supports',
        supportType: 'pattern_confirmation',
        episodeKey: null,
      },
    ]);
    const packet = buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult });
    const packetRecurrence = packet.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(packetRecurrence.predictedEvidence, recurrence.evidence);
    assert.equal(packetRecurrence.evaluation.recurrenceEpisodes.exact, 1);
    assertNoSecrets(packet);
  });

  it('copies recurrence gold supportTypes and episodeKeys without aliasing Golden arrays', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const benchmarkResult = await runSixCaseLiveBenchmarkV2(
      validOptions({ dataset, execute: false }),
    );
    const resultSnapshot = structuredClone(benchmarkResult);
    const packet = buildSixCaseSemanticReviewPacketV2({ dataset, benchmarkResult });
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(benchmarkResult, resultSnapshot);

    const recurrence = packet.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    const goldItem = recurrence.gold.required.find(
      (item) => item.goldItemId === 'required-recurrence-01',
    );
    assert.equal(goldItem.kind, 'recurrence');
    assert.equal(goldItem.tier, 'required');
    assert.deepEqual(goldItem.supportMessageIds, ['m1', 'm2', 'm4']);
    assert.deepEqual(goldItem.supportTypes, [
      'episode_observation',
      'episode_observation',
      'pattern_confirmation',
    ]);
    assert.deepEqual(goldItem.episodeKeys, ['episode:m1', 'episode:m2', null]);

    const originalGold = dataset.cases
      .find((entry) => entry.caseId === 'memv3-ru-recurrence-02')
      .gold.required.recurrences.find((entry) => entry.goldItemId === 'required-recurrence-01');
    assert.notEqual(goldItem.supportMessageIds, originalGold.supportMessageIds);
    assert.notEqual(goldItem.supportTypes, originalGold.supportTypes);
    assert.notEqual(goldItem.episodeKeys, originalGold.episodeKeys);
    goldItem.supportMessageIds.push('m-mutated');
    goldItem.supportTypes[0] = 'mutated-support-type';
    goldItem.episodeKeys[2] = 'mutated-episode-key';
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(originalGold.supportMessageIds, ['m1', 'm2', 'm4']);
    assert.deepEqual(originalGold.supportTypes, [
      'episode_observation',
      'episode_observation',
      'pattern_confirmation',
    ]);
    assert.deepEqual(originalGold.episodeKeys, ['episode:m1', 'episode:m2', null]);

    for (const entry of packet.cases) {
      for (const item of [...entry.gold.required, ...entry.gold.acceptable]) {
        if (item.kind === 'recurrence') {
          assert.equal(Array.isArray(item.supportTypes), true);
          assert.equal(Array.isArray(item.episodeKeys), true);
        } else {
          assert.equal(Object.prototype.hasOwnProperty.call(item, 'supportTypes'), false);
          assert.equal(Object.prototype.hasOwnProperty.call(item, 'episodeKeys'), false);
        }
      }
    }

    const publicJson = JSON.stringify(benchmarkResult);
    assert.equal(publicJson.includes('required-recurrence-01'), false);
    assert.equal(publicJson.includes('episode_observation'), false);
    assert.equal(publicJson.includes('pattern_confirmation'), false);
    assert.equal(publicJson.includes(EVENT_03_MESSAGE_TEXT), false);
    assertNoSecrets(packet);
  });

  it('rejects duplicate, missing, extra, or reordered benchmark result cases', async () => {
    const dataset = loadGoldenDataset();
    const aligned = await runSixCaseLiveBenchmarkV2(validOptions({ dataset, execute: false }));
    const duplicate = structuredClone(aligned);
    duplicate.cases[5] = structuredClone(duplicate.cases[0]);
    assertPacketRejected(dataset, duplicate);
    const missing = structuredClone(aligned);
    missing.cases = missing.cases.slice(0, 5);
    missing.caseIds = missing.caseIds.slice(0, 5);
    assertPacketRejected(dataset, missing);
    const reordered = structuredClone(aligned);
    reordered.cases = [...reordered.cases].reverse();
    reordered.caseIds = [...reordered.caseIds].reverse();
    assertPacketRejected(dataset, reordered);
  });
});
