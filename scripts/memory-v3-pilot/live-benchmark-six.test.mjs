/**
 * Memory V3 six-case live-benchmark harness tests.
 * Injected fake fetch only. No network, .env, live CLI, or paid provider calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-six.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SIX_CASE_BENCHMARK_CASE_IDS,
  buildSixCaseSemanticReviewPacket,
  createAtMostSixOpenRouterFetch,
  runSixCaseLiveBenchmark,
} from './live-benchmark-six.mjs';

const MODEL = 'openai/gpt-5.6-luna';
const EXTRACTOR_VERSION = 'memory-v3-six-case-offline-v1';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = 'test-memory-v3-six-case-key';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';
const EVENT_03_CLAIM = 'Сын родился 14 февраля 2018 года';
const EVENT_03_MESSAGE_TEXT = 'На работу я вернулась не через год, а в сентябре 2020, когда ему было два с половиной.';
const SAFETY_03_ASSISTANT_TEXT = 'Наверное, в детстве тебя наказывали за любые просьбы.';

const SENTINELS = Object.freeze({
  key: API_KEY,
  fetch: 'GLOBAL_FETCH_SENTINEL',
  getter: 'RAW_SIX_GETTER_SECRET_SENTINEL',
  providerMessage: 'RAW_PROVIDER_MESSAGE_SENTINEL',
  providerMetadata: 'RAW_PROVIDER_METADATA_SENTINEL',
  response: 'RAW_PROVIDER_RESPONSE_SENTINEL',
  auth: 'Bearer RAW_AUTHORIZATION_SECRET',
  trap: 'RAW_PROXY_TRAP_SENTINEL',
});

const EVENT_03_CONTENT = JSON.stringify({
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
      episodeKey: 'son-birth',
      relation: 'supports',
    },
  ],
});

const REC_02_CONTENT = JSON.stringify({
  items: [
    {
      itemRef: 'item-1',
      kind: 'recurrence',
      claim: 'После конфликтов, сопровождаемых стыдом, прерывает контакт',
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
    {
      itemRef: 'item-1',
      sourceMessageId: 'm2',
      episodeKey: 'episode:m2',
      relation: 'supports',
    },
    {
      itemRef: 'item-1',
      sourceMessageId: 'm4',
      episodeKey: 'episode:m2',
      relation: 'supports',
    },
  ],
});

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v1.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function allowedBudget(overrides = {}) {
  return {
    caseCount: 6,
    maxInputTokensPerCase: 16384,
    maxOutputTokensPerCase: 1200,
    inputUsdPerMillion: 0.22,
    outputUsdPerMillion: 1.32,
    maxRequests: 6,
    maxBudgetUsd: 0.032,
    ...overrides,
  };
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-six',
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
  assert.equal(serialized.includes('You extract StaySEE Memory V3 items'), false);
}

async function assertPreflightReject(fn, fetchImpl) {
  await assert.rejects(async () => {
    await fn();
  }, (error) => {
    assert.match(String(error.message), /^\[memory-v3:live-benchmark-six]/);
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

describe('SIX_CASE_BENCHMARK_CASE_IDS', () => {
  it('is an immutable list of the six fixed case ids in order', () => {
    assert.deepEqual([...SIX_CASE_BENCHMARK_CASE_IDS], [
      'memv3-ru-event-03',
      'memv3-ru-correction-04',
      'memv3-ru-recurrence-02',
      'memv3-ru-hypothesis-01',
      'memv3-ru-counterexample-01',
      'memv3-ru-safety-03',
    ]);
    assert.equal(Object.isFrozen(SIX_CASE_BENCHMARK_CASE_IDS), true);
    assert.throws(() => {
      SIX_CASE_BENCHMARK_CASE_IDS.push('memv3-ru-event-01');
    });
    assert.equal(SIX_CASE_BENCHMARK_CASE_IDS.length, 6);
  });
});

describe('runSixCaseLiveBenchmark selection preflight', () => {
  it('rejects a missing required case with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.cases = dataset.cases.filter((entry) => entry.caseId !== 'memv3-ru-event-03');
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );
  });

  it('rejects a duplicate required caseId with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const original = dataset.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    dataset.cases.push(structuredClone(original));
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );
  });

  it('rejects an unknown required case with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const entry = dataset.cases.find((item) => item.caseId === 'memv3-ru-event-03');
    entry.caseId = 'memv3-ru-unknown-99';
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );
  });

  it('rejects a sparse dataset.cases array with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const sparse = [];
    sparse[0] = dataset.cases[0];
    sparse[2] = dataset.cases[1];
    dataset.cases = sparse;
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      fetchImpl,
    );
  });

  it('does not execute getters, symbols, or non-enumerable option fields', async () => {
    const fetchImpl = recordingFetch();
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
    await assertPreflightReject(() => runSixCaseLiveBenchmark(options), fetchImpl);
    assert.equal(getterCalls, 0);

    const withSymbol = validOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    Object.defineProperty(withSymbol, Symbol('secret'), {
      enumerable: true,
      value: SENTINELS.getter,
    });
    await assertPreflightReject(() => runSixCaseLiveBenchmark(withSymbol), fetchImpl);

    const hidden = validOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    Object.defineProperty(hidden, 'model', {
      enumerable: false,
      value: MODEL,
    });
    await assertPreflightReject(() => runSixCaseLiveBenchmark(hidden), fetchImpl);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('runSixCaseLiveBenchmark budget preflight', () => {
  it('passes the exact six-case ceiling and the $0.032 hard gate without HTTP', async () => {
    const exact = await runSixCaseLiveBenchmark(
      validOptions({
        execute: false,
        budget: allowedBudget({ maxBudgetUsd: 0.03113088 }),
      }),
    );
    assert.equal(exact.providerHttpCalls, 0);
    assert.equal(exact.configuredBudget.gate, 'PASS');
    assert.equal(exact.configuredBudget.absoluteCostUsd, '0.03113088');
    assert.equal(exact.configuredBudget.inputCostUsd, '0.02162688');
    assert.equal(exact.configuredBudget.outputCostUsd, '0.009504');
    assert.equal(exact.configuredBudget.absoluteMaxRequests, 6);
    assert.equal(exact.configuredBudget.maxBudgetUsd, 0.03113088);

    const hard = await runSixCaseLiveBenchmark(validOptions({ execute: false }));
    assert.equal(hard.configuredBudget.gate, 'PASS');
    assert.equal(hard.configuredBudget.maxBudgetUsd, 0.032);
    assert.equal(hard.providerHttpCalls, 0);
  });

  it('fails below $0.03113088 with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({
            execute: true,
            apiKey: API_KEY,
            fetchImpl,
            budget: allowedBudget({ maxBudgetUsd: 0.03113087 }),
          }),
        ),
      fetchImpl,
    );
  });

  it('fails caseCount or maxRequests mismatch with zero HTTP calls', async () => {
    const fetchImpl = recordingFetch();
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({
            execute: true,
            apiKey: API_KEY,
            fetchImpl,
            budget: allowedBudget({ caseCount: 5 }),
          }),
        ),
      fetchImpl,
    );
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({
            execute: true,
            apiKey: API_KEY,
            fetchImpl,
            budget: allowedBudget({ maxRequests: 5 }),
          }),
        ),
      fetchImpl,
    );
  });

  it('does not execute budget getters', async () => {
    const fetchImpl = recordingFetch();
    let getterCalls = 0;
    const budget = allowedBudget();
    Object.defineProperty(budget, 'inputUsdPerMillion', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    await assertPreflightReject(
      () =>
        runSixCaseLiveBenchmark(
          validOptions({
            execute: true,
            apiKey: API_KEY,
            fetchImpl,
            budget,
          }),
        ),
      fetchImpl,
    );
    assert.equal(getterCalls, 0);
  });
});

describe('runSixCaseLiveBenchmark dry-run', () => {
  it('returns a safe six-case plan without extraction, fetch, or apiKey', async () => {
    const previous = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error(SENTINELS.fetch);
    };
    try {
      const dataset = loadGoldenDataset();
      const snapshot = structuredClone(dataset);
      const result = await runSixCaseLiveBenchmark(
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
      assert.deepEqual(result.caseIds, [...SIX_CASE_BENCHMARK_CASE_IDS]);
      assert.equal(result.model, MODEL);
      assert.equal(result.extractorVersion, EXTRACTOR_VERSION);
      assert.equal(result.configuredBudget.gate, 'PASS');
      assert.equal(result.cases.length, 6);
      for (const [index, entry] of result.cases.entries()) {
        assert.equal(entry.caseId, SIX_CASE_BENCHMARK_CASE_IDS[index]);
        assert.equal(Object.prototype.hasOwnProperty.call(entry, 'evaluation'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(entry, 'items'), false);
      }
      assert.equal(result.aggregate, null);
      assert.equal(result.actualUsage, null);
      assert.equal(result.actualCostUsd, null);
      assert.equal(result.semanticReview.status, 'required');
      assert.deepEqual(dataset, snapshot);
      assertNoSecrets(result);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('runSixCaseLiveBenchmark fake fetch execution', () => {
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
      const result = await runSixCaseLiveBenchmark(
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
        SIX_CASE_BENCHMARK_CASE_IDS.flatMap((caseId) => [`start:${caseId}`, `end:${caseId}`]),
      );
      assert.equal(result.attemptedCount, 6);
      assert.equal(result.successCount, 6);
      assert.equal(result.failureCount, 0);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'diagnosticCode'), false);
      assert.equal(result.actualUsage, null);
      assert.equal(result.actualCostUsd, null);
      assert.equal(result.semanticReview.status, 'required');
      assert.match(
        result.semanticReview.reason,
        /Structural evaluator does not judge claim meaning or forbidden remembered meaning/,
      );
      const event03 = result.cases[0];
      assert.equal(event03.caseId, 'memv3-ru-event-03');
      assert.equal(event03.itemCount, 1);
      assert.equal(event03.evidenceCount, 1);
      assert.equal(event03.evaluation.caseId, 'memv3-ru-event-03');
      for (const call of fetchImpl.calls) {
        assert.equal(call.url, OPENROUTER_URL);
        assert.equal(call.init.method, 'POST');
        const httpBody = JSON.parse(call.init.body);
        assert.equal(httpBody.model, MODEL);
        assert.equal(httpBody.max_completion_tokens, 1200);
        assert.equal('max_tokens' in httpBody, false);
        assert.equal('reasoning' in httpBody, false);
        assert.equal('reasoning_effort' in httpBody, false);
        assert.equal(httpBody.provider.allow_fallbacks, false);
        assert.equal(httpBody.provider.require_parameters, true);
        assert.equal(httpBody.provider.data_collection, 'deny');
        assert.equal(httpBody.provider.zdr, true);
      }
      assert.deepEqual(dataset, snapshot);
      assertNoSecrets(result);
      const publicJson = JSON.stringify(result);
      assert.equal(publicJson.includes(EVENT_03_MESSAGE_TEXT), false);
      assert.equal(publicJson.includes(SAFETY_03_ASSISTANT_TEXT), false);
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
      /\[memory-v3:live-benchmark-six]/,
    );
    assert.equal(innerCalls, 6);
  });

  it('continues after a middle-case failure without retry or secret leak', async () => {
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
    const result = await runSixCaseLiveBenchmark(
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
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.equal(failed.stage, 'adapter');
    assert.equal(failed.diagnosticCode, 'openrouter_refusal');
    assert.equal(failed.cause == null, true);
    assert.equal('cause' in failed, false);
    assert.equal(Object.prototype.hasOwnProperty.call(failed, 'evaluation'), false);
    assertNoSecrets(result);
    assert.equal(JSON.stringify(result).includes(SENTINELS.providerMessage), false);
  });

  it('keeps a trusted extractor contract diagnostic instead of unknown_adapter_failure', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      if (caseId === 'memv3-ru-correction-04') {
        return jsonResponse(
          officialOpenRouterHttpBody(
            JSON.stringify({
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
                  episodeKey: 'episode:m1',
                  relation: 'contradicts',
                },
              ],
            }),
          ),
        );
      }
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const result = await runSixCaseLiveBenchmark(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.providerHttpCalls, 6);
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-correction-04');
    assert.equal(failed.stage, 'contract');
    assert.equal(failed.diagnosticCode, 'extractor_contract_missing_required_relation');
    assert.equal(failed.diagnosticCode === 'unknown_adapter_failure', false);
    assert.equal(failed.cause == null, true);
    assert.equal('cause' in failed, false);
    assert.equal(JSON.stringify(result).includes('SENTINEL_CORRECTION_CLAIM'), false);
    assertNoSecrets(result);
  });

  it('maps a non-string refusal to invalid shape without leaking', async () => {
    const fetchImpl = recordingFetch(
      jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: EMPTY_CONTENT,
              refusal: { raw: SENTINELS.providerMessage },
            },
          },
        ],
      }),
    );
    const result = await runSixCaseLiveBenchmark(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
        budget: allowedBudget({ maxBudgetUsd: 0.032 }),
      }),
    );
    assert.equal(result.providerHttpCalls, 6);
    assert.equal(result.failureCount, 6);
    for (const entry of result.cases) {
      assert.equal(entry.diagnosticCode, 'openrouter_response_invalid_shape');
      assert.equal(entry.stage, 'adapter');
    }
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
    const result = await runSixCaseLiveBenchmark(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    assert.equal(result.providerHttpCalls, 6);
    assert.equal(result.failureCount, 6);
    for (const entry of result.cases) {
      assert.equal(entry.diagnosticCode, 'transport_request_failed');
    }
    assertNoSecrets(result);
  });
});

describe('runSixCaseLiveBenchmark aggregation', () => {
  it('aggregates structural totals without treating missing eligible dates as quality', async () => {
    const result = await runSixCaseLiveBenchmark(
      validOptions({
        execute: true,
        apiKey: API_KEY,
        fetchImpl: recordingFetch(),
      }),
    );
    assert.equal(result.successCount, 6);
    assert.equal(typeof result.aggregate.items.overall.precision, 'number');
    assert.equal(typeof result.aggregate.items.overall.recall, 'number');
    assert.equal(typeof result.aggregate.items.overall.f1, 'number');
    assert.equal(typeof result.aggregate.evidence.overall.precision, 'number');
    assert.equal(typeof result.aggregate.items.byKind.event.f1, 'number');
    assert.equal(typeof result.aggregate.evidence.byRelation.supports.f1, 'number');
    assert.equal(typeof result.aggregate.abstention.expected, 'number');
    assert.equal(result.aggregate.dates.eligible, 2);
    assert.equal(result.aggregate.dates.exact, 0);
    assert.equal(result.aggregate.recurrenceEpisodes.eligible, 1);
    assert.equal(result.aggregate.recurrenceEpisodes.exact, 0);
    assert.equal(result.semanticReview.status, 'required');
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    assert.equal(result.aggregate.semanticClaims.status, 'not_evaluated');
    assertNoSecrets(result);
  });
});

describe('buildSixCaseSemanticReviewPacket', () => {
  async function dryBenchmark(dataset = loadGoldenDataset()) {
    return runSixCaseLiveBenchmark(validOptions({ dataset, execute: false }));
  }

  function assertPacketRejected(dataset, benchmarkResult) {
    assert.throws(
      () => buildSixCaseSemanticReviewPacket({ dataset, benchmarkResult }),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:live-benchmark-six]/);
        assert.equal(error.cause == null, true);
        assertNoSecrets(error);
        return true;
      },
    );
  }

  it('includes synthetic fixture messages without createdAt and keeps public result private', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      const content = caseId === 'memv3-ru-event-03' ? EVENT_03_CONTENT : EMPTY_CONTENT;
      return jsonResponse(officialOpenRouterHttpBody(content));
    });
    const benchmarkResult = await runSixCaseLiveBenchmark(
      validOptions({
        dataset,
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    const resultSnapshot = structuredClone(benchmarkResult);
    const packet = buildSixCaseSemanticReviewPacket({ dataset, benchmarkResult });
    const again = buildSixCaseSemanticReviewPacket({ dataset, benchmarkResult });
    assert.deepEqual(packet, again);
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(benchmarkResult, resultSnapshot);
    assert.equal(packet.cases.length, 6);
    for (const [index, entry] of packet.cases.entries()) {
      assert.equal(entry.caseId, SIX_CASE_BENCHMARK_CASE_IDS[index]);
      assert.equal(typeof entry.category, 'string');
      assert.equal(typeof entry.title, 'string');
      assert.equal(Array.isArray(entry.gold), true);
      assert.equal(Array.isArray(entry.predicted), true);
      assert.equal(Array.isArray(entry.predictedEvidence), true);
      assert.equal(entry.semanticVerdict, null);
      assert.equal(entry.forbiddenMeaningVerdict, null);
      assert.equal(entry.reviewerNotes, null);
      assert.equal(Array.isArray(entry.messages), true);
      assert.equal(entry.messages.length > 0, true);
      for (const message of entry.messages) {
        assert.deepEqual(Object.keys(message).sort(), ['id', 'role', 'text']);
        assert.equal(typeof message.id, 'string');
        assert.equal(typeof message.role, 'string');
        assert.equal(typeof message.text, 'string');
        assert.equal(Object.prototype.hasOwnProperty.call(message, 'createdAt'), false);
      }
    }
    const event03 = packet.cases[0];
    assert.equal(event03.predicted[0].kind, 'event');
    assert.equal(event03.predicted[0].status, 'active');
    assert.equal(event03.predicted[0].claim, EVENT_03_CLAIM);
    assert.equal(event03.predicted[0].alternative, null);
    assert.equal(event03.predictedEvidence[0].sourceMessageId, 'm1');
    assert.equal(event03.predictedEvidence[0].relation, 'supports');
    assert.equal(event03.messages.some((message) => message.text === EVENT_03_MESSAGE_TEXT), true);
    const safety03 = packet.cases[5];
    assert.equal(safety03.caseId, 'memv3-ru-safety-03');
    assert.equal(
      safety03.messages.some(
        (message) => message.role === 'assistant' && message.text === SAFETY_03_ASSISTANT_TEXT,
      ),
      true,
    );
    const serialized = JSON.stringify(packet);
    assert.equal(serialized.includes('2024-03-14T08:30:00Z'), false);
    assert.equal(serialized.includes('You extract StaySEE Memory V3 items'), false);
    assert.equal(JSON.stringify(benchmarkResult).includes(EVENT_03_MESSAGE_TEXT), false);
    assert.equal(JSON.stringify(benchmarkResult).includes(SAFETY_03_ASSISTANT_TEXT), false);
    assertNoSecrets(packet);
  });

  it('projects contract-validated episodeKey on successful evidence and review packet', async () => {
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
    const benchmarkResult = await runSixCaseLiveBenchmark(
      validOptions({
        dataset,
        execute: true,
        apiKey: API_KEY,
        fetchImpl,
      }),
    );
    const recurrence = benchmarkResult.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(recurrence.evidence, [
      { sourceMessageId: 'm1', relation: 'supports', episodeKey: 'episode:m1' },
      { sourceMessageId: 'm2', relation: 'supports', episodeKey: 'episode:m2' },
      { sourceMessageId: 'm4', relation: 'supports', episodeKey: 'episode:m2' },
    ]);
    for (const entry of recurrence.evidence) {
      assert.deepEqual(Object.keys(entry).sort(), ['episodeKey', 'relation', 'sourceMessageId']);
      assert.equal(Object.prototype.hasOwnProperty.call(entry, 'itemKey'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(entry, 'localItemKey'), false);
    }
    const packet = buildSixCaseSemanticReviewPacket({ dataset, benchmarkResult });
    const packetRecurrence = packet.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(packetRecurrence.predictedEvidence, [
      { sourceMessageId: 'm1', relation: 'supports', episodeKey: 'episode:m1' },
      { sourceMessageId: 'm2', relation: 'supports', episodeKey: 'episode:m2' },
      { sourceMessageId: 'm4', relation: 'supports', episodeKey: 'episode:m2' },
    ]);
    assert.equal(packetRecurrence.evaluation.recurrenceEpisodes.exact, 1);
    assert.equal(packetRecurrence.evaluation.recurrenceEpisodes.accuracy, 1);
    assertNoSecrets(benchmarkResult);
    assertNoSecrets(packet);
  });

  it('rejects duplicate, missing, extra, or reordered benchmark result cases', async () => {
    const dataset = loadGoldenDataset();
    const aligned = await dryBenchmark(dataset);
    const duplicate = structuredClone(aligned);
    duplicate.cases[5] = structuredClone(duplicate.cases[0]);
    assertPacketRejected(dataset, duplicate);

    const missing = structuredClone(aligned);
    missing.cases = missing.cases.slice(0, 5);
    missing.caseIds = missing.caseIds.slice(0, 5);
    assertPacketRejected(dataset, missing);

    const extra = structuredClone(aligned);
    extra.cases.push({ caseId: 'memv3-ru-event-01' });
    extra.caseIds = [...extra.caseIds, 'memv3-ru-event-01'];
    assertPacketRejected(dataset, extra);

    const reordered = structuredClone(aligned);
    reordered.cases = [...reordered.cases].reverse();
    reordered.caseIds = [...reordered.caseIds].reverse();
    assertPacketRejected(dataset, reordered);
  });

  it('rejects a misaligned model, extractorVersion, or caseIds array', async () => {
    const dataset = loadGoldenDataset();
    const aligned = await dryBenchmark(dataset);
    const wrongIds = structuredClone(aligned);
    wrongIds.caseIds = [...wrongIds.caseIds].reverse();
    assertPacketRejected(dataset, wrongIds);

    const wrongModel = structuredClone(aligned);
    wrongModel.model = 'openai/gpt-5-mini';
    assertPacketRejected(dataset, wrongModel);

    const emptyVersion = structuredClone(aligned);
    emptyVersion.extractorVersion = '';
    assertPacketRejected(dataset, emptyVersion);

    const mismatchVersion = structuredClone(aligned);
    mismatchVersion.extractorVersion = '   ';
    assertPacketRejected(dataset, mismatchVersion);
  });

  it('does not execute spoofed getters on packet inputs', () => {
    let getterCalls = 0;
    const dataset = loadGoldenDataset();
    Object.defineProperty(dataset, 'cases', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINELS.getter);
      },
    });
    assert.throws(
      () =>
        buildSixCaseSemanticReviewPacket({
          dataset,
          benchmarkResult: {
            model: MODEL,
            extractorVersion: EXTRACTOR_VERSION,
            caseIds: [...SIX_CASE_BENCHMARK_CASE_IDS],
            cases: SIX_CASE_BENCHMARK_CASE_IDS.map((caseId) => ({ caseId })),
          },
        }),
      /\[memory-v3:live-benchmark-six]/,
    );
    assert.equal(getterCalls, 0);
  });
});
