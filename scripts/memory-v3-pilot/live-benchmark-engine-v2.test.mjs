/**
 * Memory V3 V2 shared live-benchmark engine tests.
 * Injected fake fetch only. No network, .env, live CLI, or paid provider calls.
 * Run: node --test scripts/memory-v3-pilot/live-benchmark-engine-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildProfileSemanticReviewPacketV2,
  createProfileBoundedOpenRouterFetch,
  runProfileLiveBenchmarkV2,
} from './live-benchmark-engine-v2.mjs';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3.7-flash';
const API_KEY = 'test-memory-v3-profile-v2-key';
const SENTINEL = 'RAW_ENGINE_GETTER_SENTINEL';
const AMBIENT_SECRET_SENTINEL = 'AMBIENT_SECRET_SENTINEL';
const ATTACKER_INHERITED_KIND = 'attacker-inherited-kind';
const ATTACKER_INHERITED_SOURCE = 'attacker-inherited-source-message-id';
const LENGTH_SENTINEL = 'RAW_LENGTH_SENTINEL';
const SECRET_CYCLE_KEY = 'SUPER_SECRET_PROPERTY_NAME';
const EMPTY_CONTENT = '{"items":[],"evidence":[]}';
const SIX_PREFIX = '[memory-v3:live-benchmark-six-v2]';
const SIX_NAME = 'MemoryV3SixCaseBenchmarkV2Error';
const HYPOTHESIS_PREFIX = '[memory-v3:live-benchmark-hypothesis-four-v2]';
const HYPOTHESIS_NAME = 'MemoryV3HypothesisFourBenchmarkV2Error';
const GENERIC_PREFIX = '[memory-v3:live-benchmark-engine-v2]';
const GENERIC_NAME = 'MemoryV3ProfileLiveBenchmarkV2Error';
const APPROVED_ENGINE_IMPORTS = Object.freeze([
  './contracts-v2.mjs',
  './evaluator-v2.mjs',
  './extractor-prompt-v2.mjs',
  './benchmark-runner-v2.mjs',
  './benchmark-budget.mjs',
  './openrouter-adapter.mjs',
  './openrouter-fetch-transport.mjs',
  './live-benchmark-profiles-v2.mjs',
]);

const PROFILE_OWN_KEYS = Object.freeze([
  'profileId',
  'caseIds',
  'model',
  'extractorVersion',
  'datasetId',
  'datasetVersion',
  'reasoningEffort',
  'maxOutputTokensPerCase',
  'maxInputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'maxBudgetUsd',
  'maxRequests',
  'caseCount',
  'timeoutMs',
  'maxResponseBytes',
  'maxPromptRequestBytesPerCase',
  'maxTokensParameter',
  'allowFallbacks',
  'responseContract',
  'executeFlag',
  'maxBudgetUsdArg',
  'engineErrorPrefix',
  'engineErrorName',
  'cliErrorPrefix',
  'cliErrorName',
  'runErrorPrefix',
  'runErrorName',
  'httpCapError',
]);

const SIX_BUDGET = Object.freeze({
  caseCount: 6,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxRequests: 6,
  maxBudgetUsd: 0.11,
});

const HYPOTHESIS_BUDGET = Object.freeze({
  caseCount: 4,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxRequests: 4,
  maxBudgetUsd: 0.075,
});

const SIX_CASE_IDS = Object.freeze([
  'memv3-ru-event-03',
  'memv3-ru-correction-04',
  'memv3-ru-recurrence-02',
  'memv3-ru-hypothesis-01',
  'memv3-ru-counterexample-01',
  'memv3-ru-safety-03',
]);

const HYPOTHESIS_CASE_IDS = Object.freeze([
  'memv3-ru-hypothesis-01',
  'memv3-ru-hypothesis-02',
  'memv3-ru-hypothesis-03',
  'memv3-ru-hypothesis-04',
]);

const REC_02_CONTENT = JSON.stringify({
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

function withProfileIdDescriptor(baseOptions, kind, probe) {
  const options = Object.assign({}, baseOptions);
  delete options.profileId;
  if (kind === 'valid-own-enumerable-string') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return options;
  }
  if (kind === 'getter') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      get() {
        probe.getterCalls += 1;
        return 'six-category-v2';
      },
    });
    return options;
  }
  if (kind === 'setter-only') {
    Object.defineProperty(options, 'profileId', {
      enumerable: true,
      configurable: true,
      set() {
        probe.setterCalls += 1;
      },
    });
    return options;
  }
  if (kind === 'non-enumerable') {
    Object.defineProperty(options, 'profileId', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return options;
  }
  if (kind === 'symbol-keyed') {
    Object.defineProperty(options, Symbol('profileId'), {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return options;
  }
  if (kind === 'inherited') {
    const proto = { profileId: 'six-category-v2' };
    return Object.assign(Object.create(proto), options);
  }
  throw new Error('unknown descriptor kind');
}

function loadGoldenDataset() {
  const url = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function officialOpenRouterHttpBody(content = EMPTY_CONTENT) {
  return {
    id: 'chatcmpl-profile-v2',
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
  };
}

function jsonResponse(body) {
  return {
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init);
    return jsonResponse(officialOpenRouterHttpBody());
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function caseIdFromRequest(init) {
  const body = JSON.parse(init.body);
  const input = JSON.parse(body.messages[1].content);
  return input.caseId;
}

function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes('OPENROUTER_API_KEY'), false);
  assert.equal(text.includes('Authorization'), false);
  assert.equal(text.includes('.env'), false);
}

function sixEngineOptions(overrides = {}) {
  return {
    dataset: loadGoldenDataset(),
    profileId: 'six-category-v2',
    model: MODEL,
    extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-six-v2',
    budget: { ...SIX_BUDGET },
    maxPromptRequestBytesPerCase: 20000,
    execute: false,
    ...overrides,
  };
}

function stringifyError(error) {
  try {
    return JSON.stringify(error);
  } catch {
    return '';
  }
}

function assertProfileEngineError(error, prefix, name) {
  assert.equal(error.name, name);
  assert.equal(String(error.message).startsWith(`${prefix} `), true);
  assert.equal(error.cause == null, true);
  assert.equal('cause' in error, false);
  const text = `${String(error.message)}\n${stringifyError(error)}`;
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes(SENTINEL), false);
  assert.equal(text.includes(LENGTH_SENTINEL), false);
  assert.equal(text.includes(SECRET_CYCLE_KEY), false);
  assert.equal(text.includes('Maximum call stack'), false);
  return true;
}

function collectImportSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:\bfrom\s+|(?:^|\n)\s*import\s+)(['"])([^'"\n]+)\1/g;
  let match = pattern.exec(source);
  while (match) {
    specifiers.push(match[2]);
    match = pattern.exec(source);
  }
  return specifiers;
}

function attachOwnProto(target, value) {
  Object.defineProperty(target, '__proto__', {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

function withObjectPrototypeOwn(key, descriptor, run) {
  const had = Object.prototype.hasOwnProperty.call(Object.prototype, key);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: false,
    ...descriptor,
  });
  try {
    return run();
  } finally {
    if (had) Object.defineProperty(Object.prototype, key, previous);
    else delete Object.prototype[key];
  }
}

function resultWithCaseItems(dry, caseId, items, evidence) {
  return {
    ...dry,
    cases: dry.cases.map((entry) => {
      if (entry.caseId !== caseId) return { ...entry };
      const next = { ...entry, items };
      if (evidence !== undefined) next.evidence = evidence;
      return next;
    }),
  };
}

function assertSentinelAbsent(value) {
  const message = value && typeof value === 'object' && 'message' in value ? String(value.message) : '';
  const serialized = typeof value === 'string' ? value : stringifyError(value);
  const blob = `${message}\n${serialized}`;
  assert.equal(blob.includes(AMBIENT_SECRET_SENTINEL), false);
  assert.equal(blob.includes(ATTACKER_INHERITED_KIND), false);
  assert.equal(blob.includes(ATTACKER_INHERITED_SOURCE), false);
}

function assertBrandedOrUndefined(error) {
  if (error === undefined) return;
  assert.equal(error instanceof TypeError && error.name === 'TypeError', false);
  assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
  assertSentinelAbsent(error);
}

function hypothesisEngineOptions(overrides = {}) {
  return {
    dataset: loadGoldenDataset(),
    profileId: 'hypothesis-four-v2',
    model: MODEL,
    extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
    budget: { ...HYPOTHESIS_BUDGET },
    maxPromptRequestBytesPerCase: 20000,
    execute: false,
    ...overrides,
  };
}

describe('runProfileLiveBenchmarkV2 identity', () => {
  it('rejects a profile clone as options.profileId inside otherwise valid options, with zero HTTP', async () => {
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    const fetchImpl = recordingFetch();
    const structuralCopy = {
      profileId: 'six-category-v2',
      caseIds: [...canonical.caseIds],
      model: canonical.model,
      extractorVersion: canonical.extractorVersion,
      inputUsdPerMillion: canonical.inputUsdPerMillion,
      outputUsdPerMillion: canonical.outputUsdPerMillion,
      maxRequests: canonical.maxRequests,
      maxBudgetUsd: canonical.maxBudgetUsd,
    };
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: { ...canonical }, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          profileId: Object.freeze({ ...canonical }),
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: structuralCopy, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: canonical, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ profileId: 'full-24-v2', fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects unknown outer field profile with zero HTTP', async () => {
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          profile: canonical,
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects invalid profileId descriptors without executing getters and with zero HTTP', async () => {
    const fetchImpl = recordingFetch();
    const base = sixEngineOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      const forged = withProfileIdDescriptor(base, kind, probe);
      await assert.rejects(() => runProfileLiveBenchmarkV2(forged));
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
    }
    const valid = withProfileIdDescriptor(base, 'valid-own-enumerable-string', {
      getterCalls: 0,
      setterCalls: 0,
    });
    valid.execute = false;
    const dry = await runProfileLiveBenchmarkV2(valid);
    assert.equal(dry.providerHttpCalls, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('does not leak rejected profileId values into public errors', async () => {
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            profileId: { ...canonical },
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => {
        const text = String(error.message);
        assert.equal(text.includes(JSON.stringify(canonical.caseIds)), false);
        assert.equal(text.includes(API_KEY), false);
        return true;
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('dry-run six-category-v2 returns a plan with zero HTTP and null costs', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(sixEngineOptions({ fetchImpl }));
    assert.equal(result.providerHttpCalls, 0);
    assert.equal(result.maxActive, 1);
    assert.equal(result.attemptedCount, 0);
    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 0);
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    assert.equal(result.configuredBudget.absoluteCostUsd, '0.100728');
    assert.equal(result.configuredBudget.absoluteCostNanodollars, '100728000');
    assert.equal(result.configuredBudget.gate, 'PASS');
    assert.deepEqual(result.caseIds, [...SIX_CASE_IDS]);
    assert.deepEqual(
      result.cases,
      SIX_CASE_IDS.map((caseId) => ({ caseId })),
    );
    assert.equal(result.aggregate, null);
    assert.equal(result.semanticReview.status, 'required');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(PROFILE_OWN_KEYS.includes('budget'), false);
    assertNoSecrets(result);
  });

  it('execute six-category-v2 is sequential, N=6, and blocks the seventh fetch', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.providerHttpCalls, 6);
    assert.equal(result.maxActive, 1);
    assert.equal(result.actualUsage, null);
    assert.equal(result.actualCostUsd, null);
    for (const call of fetchImpl.calls) {
      assert.equal(call.url, OPENROUTER_URL);
      assert.equal(call.init.method, 'POST');
    }
    const guarded = createProfileBoundedOpenRouterFetch(fetchImpl, 'six-category-v2');
    for (let index = 0; index < 6; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    assert.equal(guarded.callCount, 6);
    await assert.rejects(
      () => guarded(OPENROUTER_URL, { method: 'POST' }),
      (error) =>
        error.name === 'MemoryV3SixCaseBenchmarkV2Error' &&
        String(error.message) ===
          '[memory-v3:live-benchmark-six-v2] seventh fetch is not allowed',
    );
    assert.equal(guarded.callCount, 6);
    const inner = recordingFetch();
    const capped = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2', 100);
    for (let index = 0; index < 6; index += 1) {
      await capped(OPENROUTER_URL, { method: 'POST' });
    }
    await assert.rejects(() => capped(OPENROUTER_URL, { method: 'POST' }));
    assert.equal(inner.calls.length, 6);
    assert.equal(capped.callCount, 6);
    assert.throws(() => createProfileBoundedOpenRouterFetch(inner, { maxRequests: 100 }));
    assert.throws(() => createProfileBoundedOpenRouterFetch(inner, { profileId: 'six-category-v2' }));
  });

  it('counts an inner fetch rejection as an attempt and still blocks the seventh call', async () => {
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      if (innerCalls === 1) {
        throw new Error('inner boom');
      }
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2');
    const callCountDesc = Object.getOwnPropertyDescriptor(guarded, 'callCount');
    assert.equal(callCountDesc.enumerable, true);
    assert.equal(typeof callCountDesc.get, 'function');
    await assert.rejects(() => guarded(OPENROUTER_URL, { method: 'POST' }));
    assert.equal(innerCalls, 1);
    assert.equal(guarded.callCount, 1);
    for (let index = 0; index < 5; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    assert.equal(innerCalls, 6);
    assert.equal(guarded.callCount, 6);
    await assert.rejects(() => guarded(OPENROUTER_URL, { method: 'POST' }));
    assert.equal(innerCalls, 6);
    assert.equal(guarded.callCount, 6);
  });

  it('execute hypothesis-four-v2 uses four ids, $0.067152 ceiling, and fifth-fetch cap', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2({
      dataset: loadGoldenDataset(),
      profileId: 'hypothesis-four-v2',
      model: MODEL,
      extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
      budget: { ...HYPOTHESIS_BUDGET },
      maxPromptRequestBytesPerCase: 20000,
      execute: true,
      apiKey: API_KEY,
      fetchImpl,
    });
    assert.equal(fetchImpl.calls.length, 4);
    assert.equal(result.providerHttpCalls, 4);
    assert.equal(result.maxActive, 1);
    assert.deepEqual(result.caseIds, [...HYPOTHESIS_CASE_IDS]);
    assert.equal(result.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2');
    assert.equal(result.configuredBudget.absoluteInputTokens, 65536);
    assert.equal(result.configuredBudget.absoluteOutputTokens, 4800);
    assert.equal(result.configuredBudget.inputCostUsd, '0.049152');
    assert.equal(result.configuredBudget.outputCostUsd, '0.018');
    assert.equal(result.configuredBudget.absoluteCostUsd, '0.067152');
    assert.equal(result.configuredBudget.absoluteCostNanodollars, '67152000');
    assert.equal(result.configuredBudget.gate, 'PASS');
    const inner = recordingFetch();
    const capped = createProfileBoundedOpenRouterFetch(inner, 'hypothesis-four-v2');
    for (let index = 0; index < 4; index += 1) {
      await capped(OPENROUTER_URL, { method: 'POST' });
    }
    await assert.rejects(
      () => capped(OPENROUTER_URL, { method: 'POST' }),
      (error) =>
        error.name === 'MemoryV3HypothesisFourBenchmarkV2Error' &&
        String(error.message) ===
          '[memory-v3:live-benchmark-hypothesis-four-v2] fifth fetch is not allowed',
    );
    assert.equal(inner.calls.length, 4);
    assert.equal(capped.callCount, 4);
  });

  it('continues after a middle-case failure without retry', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      if (caseIdFromRequest(init) === 'memv3-ru-recurrence-02') {
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
                refusal: 'RAW_PROVIDER_MESSAGE_SENTINEL',
              },
            },
          ],
        });
      }
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.failureCount, 1);
    assert.equal(result.successCount, 5);
    assert.equal(result.aggregate, null);
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(Object.keys(failed).sort(), ['caseId', 'diagnosticCode', 'stage']);
    assertNoSecrets(result);
    assert.equal(JSON.stringify(result).includes('RAW_PROVIDER_MESSAGE_SENTINEL'), false);
  });

  it('does not trust a spoofed diagnosticCode from fetchImpl', async () => {
    const fetchImpl = recordingFetch(async () => {
      const error = new Error('RAW_PROVIDER_MESSAGE_SENTINEL');
      error.name = 'MemoryV3OpenRouterError';
      Object.defineProperty(error, 'diagnosticCode', {
        value: 'openrouter_http_402',
        enumerable: true,
      });
      throw error;
    });
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
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

  it('keeps a trusted V2 extractor contract diagnostic', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      if (caseIdFromRequest(init) === 'memv3-ru-correction-04') {
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
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
    );
    assert.equal(fetchImpl.calls.length, 6);
    const failed = result.cases.find((entry) => entry.caseId === 'memv3-ru-correction-04');
    assert.equal(failed.stage, 'contract');
    assert.equal(failed.diagnosticCode, 'extractor_v2_contract_missing_required_relation');
    assert.equal(JSON.stringify(result).includes('SENTINEL_CORRECTION_CLAIM'), false);
    assertNoSecrets(result);
  });
});

describe('buildProfileSemanticReviewPacketV2', () => {
  it('rejects a profile clone as profileId while dataset and benchmarkResult are valid', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const canonical = getLiveBenchmarkProfileV2('six-category-v2');
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: { ...canonical },
        dataset,
        benchmarkResult: dry,
      });
    });
    assert.throws(() => {
      buildProfileSemanticReviewPacketV2({
        profileId: Object.freeze({ ...canonical }),
        dataset,
        benchmarkResult: dry,
      });
    });
    assert.equal(packet, undefined);
  });

  it('rejects invalid profileId descriptors and returns no packet', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const base = {
      profileId: 'six-category-v2',
      dataset: loadGoldenDataset(),
      benchmarkResult: dry,
    };
    for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      let packet;
      assert.throws(() => {
        packet = buildProfileSemanticReviewPacketV2(
          withProfileIdDescriptor(base, kind, probe),
        );
      });
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
      assert.equal(packet, undefined);
    }
    const valid = withProfileIdDescriptor(base, 'valid-own-enumerable-string', {
      getterCalls: 0,
      setterCalls: 0,
    });
    const packet = buildProfileSemanticReviewPacketV2(valid);
    assert.deepEqual(
      packet.cases.map((entry) => entry.caseId),
      [...SIX_CASE_IDS],
    );
  });

  it('rejects unknown outer field profile and returns no packet', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset: loadGoldenDataset(),
        benchmarkResult: dry,
        profile: getLiveBenchmarkProfileV2('six-category-v2'),
      });
    });
    assert.equal(packet, undefined);
  });

  it('aligns hypothesis-four packet cases to canonical order', async () => {
    const dry = await runProfileLiveBenchmarkV2(hypothesisEngineOptions());
    const packet = buildProfileSemanticReviewPacketV2({
      profileId: 'hypothesis-four-v2',
      dataset: loadGoldenDataset(),
      benchmarkResult: dry,
    });
    assert.deepEqual(
      packet.cases.map((entry) => entry.caseId),
      [...HYPOTHESIS_CASE_IDS],
    );
    assert.equal(packet.extractorVersion, 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2');
    for (const entry of packet.cases) {
      assert.equal(entry.semanticVerdict, null);
      assert.equal(entry.forbiddenMeaningVerdict, null);
      assert.equal(entry.reviewerNotes, null);
      for (const message of entry.messages) {
        assert.deepEqual(Object.keys(message).sort(), ['id', 'role', 'text']);
      }
    }
  });

  it('rejects duplicate, missing, extra, or reordered benchmarkResult cases', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const reordered = {
      ...dry,
      caseIds: [...dry.caseIds].reverse(),
      cases: [...dry.cases].reverse(),
    };
    const missing = {
      ...dry,
      caseIds: dry.caseIds.slice(1),
      cases: dry.cases.slice(1),
    };
    const extra = {
      ...dry,
      caseIds: [...dry.caseIds, 'memv3-ru-event-01'],
      cases: [...dry.cases, { caseId: 'memv3-ru-event-01' }],
    };
    const duplicate = {
      ...dry,
      caseIds: [...dry.caseIds, dry.caseIds[0]],
      cases: [...dry.cases, dry.cases[0]],
    };
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: reordered,
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: missing,
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: extra,
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: duplicate,
      }),
    );
  });

  it('rejects benchmarkResult model or extractorVersion mismatch', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: { ...dry, model: 'openai/gpt-5.6-luna' },
      }),
    );
    assert.throws(() =>
      buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: {
          ...dry,
          extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
        },
      }),
    );
  });

  it('copies recurrence gold supportTypes and episodeKeys without aliasing inputs', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions({ dataset }));
    const resultSnapshot = structuredClone(dry);
    const packet = buildProfileSemanticReviewPacketV2({
      profileId: 'six-category-v2',
      dataset,
      benchmarkResult: dry,
    });
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(dry, resultSnapshot);
    const recurrence = packet.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    const goldItem = recurrence.gold.required.find(
      (item) => item.goldItemId === 'required-recurrence-01',
    );
    assert.deepEqual(goldItem.supportTypes, [
      'episode_observation',
      'episode_observation',
      'pattern_confirmation',
    ]);
    assert.deepEqual(goldItem.episodeKeys, ['episode:m1', 'episode:m2', null]);
    const originalGold = dataset.cases
      .find((entry) => entry.caseId === 'memv3-ru-recurrence-02')
      .gold.required.recurrences.find((entry) => entry.goldItemId === 'required-recurrence-01');
    assert.notEqual(goldItem.supportTypes, originalGold.supportTypes);
    assert.notEqual(goldItem.episodeKeys, originalGold.episodeKeys);
    goldItem.episodeKeys[2] = 'mutated-episode-key';
    assert.deepEqual(originalGold.episodeKeys, ['episode:m1', 'episode:m2', null]);
    assert.deepEqual(dataset, datasetSnapshot);
  });

  it('keeps typed predicted evidence including literal null episodeKey', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      const content = caseId === 'memv3-ru-recurrence-02' ? REC_02_CONTENT : EMPTY_CONTENT;
      return jsonResponse(officialOpenRouterHttpBody(content));
    });
    const dataset = loadGoldenDataset();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ dataset, execute: true, apiKey: API_KEY, fetchImpl }),
    );
    const packet = buildProfileSemanticReviewPacketV2({
      profileId: 'six-category-v2',
      dataset,
      benchmarkResult: result,
    });
    const packetRecurrence = packet.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.deepEqual(packetRecurrence.predictedEvidence, [
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
    assertNoSecrets(packet);
  });
});

describe('runProfileLiveBenchmarkV2 preflight negatives', () => {
  it('rejects wrong datasetId before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.datasetId = 'memory-v3-ru-golden-v1';
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects wrong dataset version before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.version = '1.0.0';
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects missing or duplicate selected cases before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const missing = JSON.parse(JSON.stringify(dataset));
    missing.cases = missing.cases.filter((entry) => entry.caseId !== 'memv3-ru-event-03');
    const duplicate = JSON.parse(JSON.stringify(dataset));
    const copy = duplicate.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    duplicate.cases.push(JSON.parse(JSON.stringify(copy)));
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset: missing, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset: duplicate, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('keeps canonical case order when dataset.cases is reversed, with zero HTTP', async () => {
    const fetchImpl = recordingFetch();
    const reversed = JSON.parse(JSON.stringify(loadGoldenDataset()));
    reversed.cases.reverse();
    const dry = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ dataset: reversed, fetchImpl }),
    );
    assert.deepEqual(dry.caseIds, [...SIX_CASE_IDS]);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects wrong model before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          model: 'openai/gpt-5.6-luna',
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects wrong extractorVersion before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2',
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects missing, extra, or mismatched budget fields before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const missing = { ...SIX_BUDGET };
    delete missing.maxRequests;
    const extra = { ...SIX_BUDGET, absoluteMaxRequests: 6 };
    const mismatched = { ...SIX_BUDGET, maxRequests: 24 };
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ budget: missing, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ budget: extra, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ budget: mismatched, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects maxPromptRequestBytesPerCase mismatch before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({
          maxPromptRequestBytesPerCase: 19999,
          fetchImpl,
          execute: true,
          apiKey: API_KEY,
        }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects actual prompt byte overflow before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = JSON.parse(JSON.stringify(loadGoldenDataset()));
    const target = dataset.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    target.messages[0].text = 'x'.repeat(30000);
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects sparse cases and getter options before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const sparse = { ...dataset, cases: dataset.cases.slice() };
    sparse.cases[2] = undefined;
    await assert.rejects(() =>
      runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset: sparse, fetchImpl, execute: true, apiKey: API_KEY }),
      ),
    );
    const withModelGetter = sixEngineOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    let modelReads = 0;
    Object.defineProperty(withModelGetter, 'model', {
      enumerable: true,
      configurable: true,
      get() {
        modelReads += 1;
        return MODEL;
      },
    });
    await assert.rejects(() => runProfileLiveBenchmarkV2(withModelGetter));
    assert.equal(modelReads, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('live-benchmark-engine-v2 source isolation', () => {
  it('does not import six or hypothesis wrappers', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-engine-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.equal(source.includes('live-benchmark-six-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-run-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-hypothesis-four-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-hypothesis-four-run-v2.mjs'), false);
    assert.equal(source.includes('createAtMostNOpenRouterFetch'), false);
    assert.equal(source.includes('process.env'), false);
  });

  it('imports only the approved shared-engine modules', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-engine-v2.mjs', import.meta.url)),
      'utf8',
    );
    const imports = collectImportSpecifiers(source);
    assert.equal(imports.length, 8);
    assert.deepEqual(imports, [...APPROVED_ENGINE_IMPORTS]);
    assert.equal(/^\s*import\s+['"]/m.test(source), false);
    assert.equal(source.includes('node:fs'), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('globalThis.fetch'), false);
    assert.equal(source.includes('live-benchmark-six.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-cli.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-run.mjs'), false);
    assert.equal(source.includes('evaluator.mjs'), false);
    assert.equal(source.includes('live-benchmark-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-run-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-run-v2.mjs'), false);
  });

  it('does not export createAtMostNOpenRouterFetch', async () => {
    const mod = await import('./live-benchmark-engine-v2.mjs');
    assert.equal('createAtMostNOpenRouterFetch' in mod, false);
    assert.equal(typeof mod.runProfileLiveBenchmarkV2, 'function');
    assert.equal(typeof mod.buildProfileSemanticReviewPacketV2, 'function');
    assert.equal(typeof mod.createProfileBoundedOpenRouterFetch, 'function');
  });
});

describe('review blockers: proto, cycles, dataset, cap, branding', () => {
  it('rejects own enumerable __proto__ on an otherwise valid budget before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const budget = { ...SIX_BUDGET };
    attachOwnProto(budget, null);
    const protoBefore = Object.getOwnPropertyDescriptor(budget, '__proto__');
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ budget, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(Object.getOwnPropertyDescriptor(budget, '__proto__'), protoBefore);
  });

  it('rejects a benchmarkResult that only exposes required fields through own __proto__', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const forged = {};
    attachOwnProto(forged, {
      model: dry.model,
      extractorVersion: dry.extractorVersion,
      caseIds: dry.caseIds,
      cases: dry.cases,
    });
    const namesBefore = Object.getOwnPropertyNames(forged);
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: forged,
      });
    }, (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME));
    assert.equal(packet, undefined);
    assert.deepEqual(Object.getOwnPropertyNames(forged), namesBefore);
  });

  it('rejects own enumerable __proto__ as an extra benchmarkResult field', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const extra = { ...dry };
    attachOwnProto(extra, null);
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: extra,
      });
    }, (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME));
    assert.equal(packet, undefined);
  });

  it('rejects a cyclic options.budget with a branded engine error, not RangeError', async () => {
    const fetchImpl = recordingFetch();
    const budget = { ...SIX_BUDGET };
    budget.caseCount = budget;
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ budget, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => {
        assert.equal(error.name, SIX_NAME);
        assert.equal(error instanceof RangeError, false);
        assert.equal(String(error.message).includes('Maximum call stack'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(budget.caseCount, budget);
  });

  it('rejects a cyclic benchmarkResult with a branded engine error, not RangeError', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const dataset = loadGoldenDataset();
    const cyclic = { ...dry };
    cyclic.cases = cyclic;
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset,
        benchmarkResult: cyclic,
      });
    }, (error) => {
      assert.equal(error instanceof RangeError, false);
      assert.equal(String(error.message).includes('Maximum call stack'), false);
      return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
    });
    assert.equal(packet, undefined);
    assert.equal(cyclic.cases, cyclic);
  });

  it('rejects an invalid unselected dataset case before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const unselected = dataset.cases.find((entry) => entry.caseId === 'memv3-ru-event-01');
    unselected.messages = [];
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects a duplicated unselected dataset caseId before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const dataset = JSON.parse(JSON.stringify(loadGoldenDataset()));
    const unselected = dataset.cases.find((entry) => entry.caseId === 'memv3-ru-event-01');
    dataset.cases.push(JSON.parse(JSON.stringify(unselected)));
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('does not execute init.method getters and keeps the sentinel out of public errors', async () => {
    let getterCalls = 0;
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2');
    const init = {};
    Object.defineProperty(init, 'method', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINEL);
      },
    });
    await assert.rejects(
      () => guarded(OPENROUTER_URL, init),
      (error) => {
        assert.equal(String(error.message).includes(SENTINEL), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(getterCalls, 0);
    assert.equal(innerCalls, 0);
  });

  it('checks the six-category cap before reading url or init on the seventh call', async () => {
    let getterCalls = 0;
    let trapCalls = 0;
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2');
    for (let index = 0; index < 6; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    assert.equal(innerCalls, 6);
    const init = new Proxy(
      {},
      {
        get(_target, prop) {
          trapCalls += 1;
          if (prop === 'method') getterCalls += 1;
          return 'POST';
        },
      },
    );
    await assert.rejects(
      () => guarded(OPENROUTER_URL, init),
      (error) =>
        error.name === SIX_NAME &&
        String(error.message) === `${SIX_PREFIX} seventh fetch is not allowed`,
    );
    assert.equal(getterCalls, 0);
    assert.equal(trapCalls, 0);
    assert.equal(guarded.callCount, 6);
    assert.equal(innerCalls, 6);
  });

  it('checks the hypothesis-four cap before reading init on the fifth call', async () => {
    let getterCalls = 0;
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createProfileBoundedOpenRouterFetch(inner, 'hypothesis-four-v2');
    for (let index = 0; index < 4; index += 1) {
      await guarded(OPENROUTER_URL, { method: 'POST' });
    }
    const init = {};
    Object.defineProperty(init, 'method', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 'POST';
      },
    });
    await assert.rejects(
      () => guarded(OPENROUTER_URL, init),
      (error) =>
        error.name === HYPOTHESIS_NAME &&
        String(error.message) === `${HYPOTHESIS_PREFIX} fifth fetch is not allowed`,
    );
    assert.equal(getterCalls, 0);
    assert.equal(guarded.callCount, 4);
    assert.equal(innerCalls, 4);
  });

  it('brands unknown outer fields with the canonical six-category engine error', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            profile: getLiveBenchmarkProfileV2('six-category-v2'),
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('brands a getter on another engine option with six-category branding and does not execute it', async () => {
    const fetchImpl = recordingFetch();
    const options = sixEngineOptions({ fetchImpl, execute: true, apiKey: API_KEY });
    let getterCalls = 0;
    Object.defineProperty(options, 'model', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINEL);
      },
    });
    await assert.rejects(
      () => runProfileLiveBenchmarkV2(options),
      (error) => {
        assert.equal(String(error.message).includes(SENTINEL), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(getterCalls, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('brands an unknown packet field with six-category engine branding', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset: loadGoldenDataset(),
        benchmarkResult: dry,
        extra: true,
      });
    }, (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME));
    assert.equal(packet, undefined);
  });

  it('brands a getter inside benchmarkResult with six-category branding and does not execute it', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const forged = { ...dry };
    let getterCalls = 0;
    Object.defineProperty(forged, 'model', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(SENTINEL);
      },
    });
    let packet;
    assert.throws(() => {
      packet = buildProfileSemanticReviewPacketV2({
        profileId: 'six-category-v2',
        dataset: loadGoldenDataset(),
        benchmarkResult: forged,
      });
    }, (error) => {
      assert.equal(String(error.message).includes(SENTINEL), false);
      return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
    });
    assert.equal(getterCalls, 0);
    assert.equal(packet, undefined);
  });

  it('brands hypothesis-four unknown fields with the hypothesis engine error', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          hypothesisEngineOptions({
            profile: getLiveBenchmarkProfileV2('hypothesis-four-v2'),
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => assertProfileEngineError(error, HYPOTHESIS_PREFIX, HYPOTHESIS_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects invalid dataset before requiring execute credentials', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.datasetId = 'memory-v3-ru-golden-v1';
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            dataset,
            execute: true,
            fetchImpl,
          }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('api key'), false);
        assert.equal(String(error.message).includes('fetchImpl is required'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects invalid budget before requiring execute fetchImpl', async () => {
    const missing = { ...SIX_BUDGET };
    delete missing.maxRequests;
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            budget: missing,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('fetchImpl is required'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });

  it('measures actual maxActive of 1 and canonical start/end order without retry', async () => {
    let active = 0;
    let measuredMaxActive = 0;
    const order = [];
    const fetchImpl = recordingFetch(async (url, init) => {
      active += 1;
      measuredMaxActive = Math.max(measuredMaxActive, active);
      const caseId = caseIdFromRequest(init);
      order.push(`start:${caseId}`);
      await Promise.resolve();
      order.push(`end:${caseId}`);
      active -= 1;
      return jsonResponse(officialOpenRouterHttpBody());
    });
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl }),
    );
    assert.equal(measuredMaxActive, 1);
    assert.equal(result.maxActive, 1);
    assert.deepEqual(
      order,
      SIX_CASE_IDS.flatMap((caseId) => [`start:${caseId}`, `end:${caseId}`]),
    );
    assert.equal(fetchImpl.calls.length, 6);
    assert.equal(result.attemptedCount, 6);
  });
});

describe('review blockers: proxy traps, cycle names, credential order', () => {
  it('rejects a dataset.cases Proxy whose length getter throws a sentinel', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    let lengthGets = 0;
    dataset.cases = new Proxy(dataset.cases, {
      get(target, prop, receiver) {
        if (prop === 'length') {
          lengthGets += 1;
          throw new Error(LENGTH_SENTINEL);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => {
        assert.equal(error instanceof TypeError, false);
        assert.equal(String(error.message).includes(LENGTH_SENTINEL), false);
        assert.equal(stringifyError(error).includes(LENGTH_SENTINEL), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
    assert.ok(lengthGets <= 1);
  });

  it('rejects a dataset.cases Proxy that throws on a later getOwnPropertyDescriptor call', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    let gopdCalls = 0;
    dataset.cases = new Proxy(dataset.cases, {
      getOwnPropertyDescriptor(target, prop) {
        gopdCalls += 1;
        if (gopdCalls > 1) {
          throw new Error(LENGTH_SENTINEL);
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => {
        assert.equal(String(error.message).includes(LENGTH_SENTINEL), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects a revoked dataset.cases Proxy without leaking TypeError', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const { proxy, revoke } = Proxy.revocable(dataset.cases, {});
    revoke();
    dataset.cases = proxy;
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => {
        assert.equal(error.name === 'TypeError', false);
        assert.equal(String(error.message).includes('revoked'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects a revoked top-level options Proxy with generic pre-profile branding', async () => {
    const fetchImpl = recordingFetch();
    const { proxy, revoke } = Proxy.revocable(
      sixEngineOptions({ fetchImpl, execute: true, apiKey: API_KEY }),
      {},
    );
    revoke();
    await assert.rejects(
      () => runProfileLiveBenchmarkV2(proxy),
      (error) => {
        assert.equal(error.name === 'TypeError', false);
        return assertProfileEngineError(error, GENERIC_PREFIX, GENERIC_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects a revoked packet benchmarkResult with six-category branding', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const { proxy, revoke } = Proxy.revocable(dry, {});
    revoke();
    let packet;
    assert.throws(
      () => {
        packet = buildProfileSemanticReviewPacketV2({
          profileId: 'six-category-v2',
          dataset: loadGoldenDataset(),
          benchmarkResult: proxy,
        });
      },
      (error) => {
        assert.equal(error.name === 'TypeError', false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(packet, undefined);
  });

  it('rejects revoked bounded-fetch init before cap without incrementing callCount', async () => {
    let innerCalls = 0;
    const inner = async () => {
      innerCalls += 1;
      return jsonResponse(officialOpenRouterHttpBody());
    };
    const guarded = createProfileBoundedOpenRouterFetch(inner, 'six-category-v2');
    const { proxy, revoke } = Proxy.revocable({ method: 'POST' }, {});
    revoke();
    await assert.rejects(
      () => guarded(OPENROUTER_URL, proxy),
      (error) => {
        assert.equal(error.name === 'TypeError', false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(guarded.callCount, 0);
    assert.equal(innerCalls, 0);
  });

  it('does not leak a sentinel from a stateful getOwnPropertyDescriptor trap', async () => {
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    const snapshots = new Map();
    dataset.cases = new Proxy(dataset.cases, {
      getOwnPropertyDescriptor(target, prop) {
        if (snapshots.has(prop)) {
          throw new Error(LENGTH_SENTINEL);
        }
        const desc = Reflect.getOwnPropertyDescriptor(target, prop);
        snapshots.set(prop, desc);
        return desc;
      },
    });
    let thrown;
    try {
      await runProfileLiveBenchmarkV2(
        sixEngineOptions({ dataset, fetchImpl, execute: false }),
      );
    } catch (error) {
      thrown = error;
      assert.equal(String(error.message).includes(LENGTH_SENTINEL), false);
      assert.equal(stringifyError(error).includes(LENGTH_SENTINEL), false);
      assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
    }
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(thrown === undefined || thrown.name === SIX_NAME, true);
  });

  it('does not rethrow a stolen branded engine error from a Proxy trap', async () => {
    let stolen;
    try {
      await runProfileLiveBenchmarkV2(sixEngineOptions({ model: 'openai/gpt-5.6-luna' }));
    } catch (error) {
      stolen = error;
    }
    assert.equal(stolen.name, SIX_NAME);
    const fetchImpl = recordingFetch();
    const dataset = loadGoldenDataset();
    dataset.cases = new Proxy(dataset.cases, {
      getOwnPropertyDescriptor() {
        throw stolen;
      },
    });
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ dataset, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => {
        assert.notEqual(error, stolen);
        assert.equal(String(error.message).includes('model is not allowed'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('does not leak attacker-controlled cycle property names from budget', async () => {
    const fetchImpl = recordingFetch();
    const budget = { ...SIX_BUDGET };
    budget[SECRET_CYCLE_KEY] = budget;
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ budget, fetchImpl, execute: true, apiKey: API_KEY }),
        ),
      (error) => {
        assert.equal(error instanceof RangeError, false);
        assert.equal(String(error.message).includes(SECRET_CYCLE_KEY), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(budget[SECRET_CYCLE_KEY], budget);
  });

  it('does not leak attacker-controlled cycle property names from benchmarkResult', async () => {
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions());
    const cyclic = { ...dry };
    cyclic[SECRET_CYCLE_KEY] = cyclic;
    let packet;
    assert.throws(
      () => {
        packet = buildProfileSemanticReviewPacketV2({
          profileId: 'six-category-v2',
          dataset: loadGoldenDataset(),
          benchmarkResult: cyclic,
        });
      },
      (error) => {
        assert.equal(error instanceof RangeError, false);
        assert.equal(String(error.message).includes(SECRET_CYCLE_KEY), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(packet, undefined);
    assert.equal(cyclic[SECRET_CYCLE_KEY], cyclic);
  });

  it('rejects invalid dataset before malformed apiKey type checking', async () => {
    const dataset = loadGoldenDataset();
    dataset.datasetId = 'memory-v3-ru-golden-v1';
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            dataset,
            execute: true,
            apiKey: 123,
            fetchImpl: recordingFetch(),
          }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('apiKey must be a string'), false);
        assert.equal(String(error.message).includes('fetchImpl must be a function'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });

  it('rejects invalid dataset before malformed fetchImpl type checking', async () => {
    const dataset = loadGoldenDataset();
    dataset.datasetId = 'memory-v3-ru-golden-v1';
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            dataset,
            execute: true,
            apiKey: API_KEY,
            fetchImpl: 123,
          }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('apiKey must be a string'), false);
        assert.equal(String(error.message).includes('fetchImpl must be a function'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });

  it('rejects prompt overflow before malformed credentials', async () => {
    const dataset = JSON.parse(JSON.stringify(loadGoldenDataset()));
    const target = dataset.cases.find((entry) => entry.caseId === 'memv3-ru-event-03');
    target.messages[0].text = 'x'.repeat(30000);
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            dataset,
            execute: true,
            apiKey: 123,
            fetchImpl: 123,
          }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('apiKey must be a string'), false);
        assert.equal(String(error.message).includes('fetchImpl must be a function'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });

  it('rejects invalid budget before malformed credentials', async () => {
    const missing = { ...SIX_BUDGET };
    delete missing.maxRequests;
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            budget: missing,
            execute: true,
            apiKey: 123,
            fetchImpl: 123,
          }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('apiKey must be a string'), false);
        assert.equal(String(error.message).includes('fetchImpl must be a function'), false);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });

  it('rejects malformed apiKey only after valid offline preflight', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ execute: true, apiKey: 123, fetchImpl }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('apiKey must be a string'), true);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects malformed fetchImpl only after valid offline preflight', async () => {
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({ execute: true, apiKey: API_KEY, fetchImpl: 123 }),
        ),
      (error) => {
        assert.equal(String(error.message).includes('fetchImpl must be a function'), true);
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });

  it('rejects missing execute credentials only after valid offline preflight', async () => {
    await assert.rejects(
      () => runProfileLiveBenchmarkV2(sixEngineOptions({ execute: true })),
      (error) => {
        assert.equal(
          String(error.message).includes('api key is required') ||
            String(error.message).includes('fetchImpl is required'),
          true,
        );
        return assertProfileEngineError(error, SIX_PREFIX, SIX_NAME);
      },
    );
  });
});

describe('review fix: options.budget maxBudgetUsd range', () => {
  it('accepts six-category-v2 canonical maxBudgetUsd 0.11', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ budget: { ...SIX_BUDGET, maxBudgetUsd: 0.11 }, fetchImpl }),
    );
    assert.equal(result.configuredBudget.maxBudgetUsd, 0.11);
    assert.equal(result.configuredBudget.absoluteCostUsd, '0.100728');
    assert.equal(result.configuredBudget.gate, 'PASS');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('accepts six-category-v2 exact ceiling 0.100728 without rewriting it', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ budget: { ...SIX_BUDGET, maxBudgetUsd: 0.100728 }, fetchImpl }),
    );
    assert.equal(result.configuredBudget.maxBudgetUsd, 0.100728);
    assert.equal(result.configuredBudget.absoluteCostUsd, '0.100728');
    assert.equal(result.configuredBudget.gate, 'PASS');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects six-category-v2 maxBudgetUsd below the configured ceiling before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            budget: { ...SIX_BUDGET, maxBudgetUsd: 0.10072799 },
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects six-category-v2 maxBudgetUsd above the canonical hard maximum before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          sixEngineOptions({
            budget: { ...SIX_BUDGET, maxBudgetUsd: 0.11000001 },
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('accepts hypothesis-four-v2 exact ceiling 0.067152', async () => {
    const fetchImpl = recordingFetch();
    const result = await runProfileLiveBenchmarkV2(
      hypothesisEngineOptions({
        budget: { ...HYPOTHESIS_BUDGET, maxBudgetUsd: 0.067152 },
        fetchImpl,
      }),
    );
    assert.equal(result.configuredBudget.maxBudgetUsd, 0.067152);
    assert.equal(result.configuredBudget.absoluteCostUsd, '0.067152');
    assert.equal(result.configuredBudget.gate, 'PASS');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects hypothesis-four-v2 maxBudgetUsd below 0.067152 before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          hypothesisEngineOptions({
            budget: { ...HYPOTHESIS_BUDGET, maxBudgetUsd: 0.067151 },
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => assertProfileEngineError(error, HYPOTHESIS_PREFIX, HYPOTHESIS_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects hypothesis-four-v2 maxBudgetUsd above 0.075 before HTTP', async () => {
    const fetchImpl = recordingFetch();
    await assert.rejects(
      () =>
        runProfileLiveBenchmarkV2(
          hypothesisEngineOptions({
            budget: { ...HYPOTHESIS_BUDGET, maxBudgetUsd: 0.07500001 },
            fetchImpl,
            execute: true,
            apiKey: API_KEY,
          }),
        ),
      (error) => assertProfileEngineError(error, HYPOTHESIS_PREFIX, HYPOTHESIS_NAME),
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('still rejects a mismatch of any of the other six budget fields before HTTP', async () => {
    const fetchImpl = recordingFetch();
    const mismatches = [
      { caseCount: 5 },
      { maxInputTokensPerCase: 16383 },
      { maxOutputTokensPerCase: 1199 },
      { inputUsdPerMillion: 0.74 },
      { outputUsdPerMillion: 3.74 },
      { maxRequests: 5 },
    ];
    for (const patch of mismatches) {
      await assert.rejects(
        () =>
          runProfileLiveBenchmarkV2(
            sixEngineOptions({
              budget: { ...SIX_BUDGET, ...patch },
              fetchImpl,
              execute: true,
              apiKey: API_KEY,
            }),
          ),
        (error) => assertProfileEngineError(error, SIX_PREFIX, SIX_NAME),
      );
    }
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('review fix: Object.prototype inheritance privacy', () => {
  it('does not execute an Object.prototype.kind getter on a malformed predicted item', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions({ dataset }));
    const malformedItem = { claim: 'malformed-predicted-claim' };
    const benchmarkResult = resultWithCaseItems(dry, 'memv3-ru-event-03', [malformedItem]);
    const resultSnapshot = structuredClone(benchmarkResult);
    const probe = { getterCalls: 0 };
    let packet;
    let thrown;
    withObjectPrototypeOwn(
      'kind',
      {
        get() {
          probe.getterCalls += 1;
          return AMBIENT_SECRET_SENTINEL;
        },
      },
      () => {
        try {
          packet = buildProfileSemanticReviewPacketV2({
            profileId: 'six-category-v2',
            dataset,
            benchmarkResult,
          });
        } catch (error) {
          thrown = error;
        }
      },
    );
    assert.equal(probe.getterCalls, 0);
    assertBrandedOrUndefined(thrown);
    if (packet !== undefined) {
      assertSentinelAbsent(packet);
      assert.equal(JSON.stringify(packet).includes(AMBIENT_SECRET_SENTINEL), false);
      for (const entry of packet.cases) {
        for (const item of entry.predicted) {
          const desc = Object.getOwnPropertyDescriptor(item, 'kind');
          assert.notEqual(desc?.value, AMBIENT_SECRET_SENTINEL);
        }
      }
    }
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(benchmarkResult, resultSnapshot);
    assert.deepEqual(malformedItem, { claim: 'malformed-predicted-claim' });
  });

  it('does not copy an inherited Object.prototype.kind data value into the packet', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions({ dataset }));
    const malformedItem = { claim: 'malformed-predicted-claim' };
    const benchmarkResult = resultWithCaseItems(dry, 'memv3-ru-event-03', [malformedItem]);
    const resultSnapshot = structuredClone(benchmarkResult);
    let packet;
    let thrown;
    withObjectPrototypeOwn(
      'kind',
      {
        enumerable: false,
        writable: true,
        value: ATTACKER_INHERITED_KIND,
      },
      () => {
        try {
          packet = buildProfileSemanticReviewPacketV2({
            profileId: 'six-category-v2',
            dataset,
            benchmarkResult,
          });
        } catch (error) {
          thrown = error;
        }
      },
    );
    assertBrandedOrUndefined(thrown);
    if (packet !== undefined) {
      assertSentinelAbsent(packet);
      for (const entry of packet.cases) {
        for (const item of entry.predicted) {
          const desc = Object.getOwnPropertyDescriptor(item, 'kind');
          assert.notEqual(desc?.value, ATTACKER_INHERITED_KIND);
        }
      }
    }
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(benchmarkResult, resultSnapshot);
  });

  it('does not read an inherited Object.prototype.sourceMessageId getter or value', async () => {
    const dataset = loadGoldenDataset();
    const datasetSnapshot = structuredClone(dataset);
    const dry = await runProfileLiveBenchmarkV2(sixEngineOptions({ dataset }));
    const malformedEvidence = { relation: 'supports', episodeKey: null };
    const benchmarkResult = resultWithCaseItems(dry, 'memv3-ru-event-03', [], [malformedEvidence]);
    const resultSnapshot = structuredClone(benchmarkResult);
    const probe = { getterCalls: 0 };
    let packet;
    let thrown;
    withObjectPrototypeOwn(
      'sourceMessageId',
      {
        get() {
          probe.getterCalls += 1;
          return AMBIENT_SECRET_SENTINEL;
        },
      },
      () => {
        try {
          packet = buildProfileSemanticReviewPacketV2({
            profileId: 'six-category-v2',
            dataset,
            benchmarkResult,
          });
        } catch (error) {
          thrown = error;
        }
      },
    );
    assert.equal(probe.getterCalls, 0);
    assertBrandedOrUndefined(thrown);
    if (packet !== undefined) {
      assertSentinelAbsent(packet);
      assert.equal(JSON.stringify(packet).includes(AMBIENT_SECRET_SENTINEL), false);
      for (const entry of packet.cases) {
        for (const row of entry.predictedEvidence) {
          const desc = Object.getOwnPropertyDescriptor(row, 'sourceMessageId');
          assert.notEqual(desc?.value, AMBIENT_SECRET_SENTINEL);
        }
      }
    }
    assert.deepEqual(dataset, datasetSnapshot);
    assert.deepEqual(benchmarkResult, resultSnapshot);

    let valuePacket;
    let valueThrown;
    withObjectPrototypeOwn(
      'sourceMessageId',
      {
        enumerable: false,
        writable: true,
        value: ATTACKER_INHERITED_SOURCE,
      },
      () => {
        try {
          valuePacket = buildProfileSemanticReviewPacketV2({
            profileId: 'six-category-v2',
            dataset,
            benchmarkResult,
          });
        } catch (error) {
          valueThrown = error;
        }
      },
    );
    assertBrandedOrUndefined(valueThrown);
    if (valuePacket !== undefined) {
      for (const entry of valuePacket.cases) {
        for (const row of entry.predictedEvidence) {
          const desc = Object.getOwnPropertyDescriptor(row, 'sourceMessageId');
          assert.notEqual(desc?.value, ATTACKER_INHERITED_SOURCE);
        }
      }
    }
  });

  it('emits a semantic packet that JSON-roundtrips as ordinary public JSON', async () => {
    const fetchImpl = recordingFetch(async (url, init) => {
      const caseId = caseIdFromRequest(init);
      const content = caseId === 'memv3-ru-recurrence-02' ? REC_02_CONTENT : EMPTY_CONTENT;
      return jsonResponse(officialOpenRouterHttpBody(content));
    });
    const dataset = loadGoldenDataset();
    const result = await runProfileLiveBenchmarkV2(
      sixEngineOptions({ dataset, execute: true, apiKey: API_KEY, fetchImpl }),
    );
    const packet = buildProfileSemanticReviewPacketV2({
      profileId: 'six-category-v2',
      dataset,
      benchmarkResult: result,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(packet)), packet);
  });
});
