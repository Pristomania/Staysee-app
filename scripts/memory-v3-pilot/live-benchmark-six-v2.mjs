/**
 * Memory V3 V2 six-case live-benchmark harness.
 * Offline fake-fetch first. No env, fs writes, global fetch fallback, retry, or CLI.
 */

import { goldItemsV2, validateCaseV2 } from './contracts-v2.mjs';
import { evaluateCaseV2, evaluateDatasetV2 } from './evaluator-v2.mjs';
import { buildExtractorRequestV2 } from './extractor-prompt-v2.mjs';
import { runOfflineBenchmarkV2 } from './benchmark-runner-v2.mjs';
import { assertBudgetGate } from './benchmark-budget.mjs';
import { createOpenRouterAdapter, projectSafeOpenRouterDiagnostic } from './openrouter-adapter.mjs';
import { createOpenRouterFetchTransport, projectSafeFetchDiagnostic } from './openrouter-fetch-transport.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ALLOWED_MODEL = 'openai/gpt-5.6-luna';
const ALLOWED_REASONING = 'none';
const ALLOWED_MAX_OUTPUT_TOKENS = 1200;
const ALLOWED_TIMEOUT_MS = 60000;
const ALLOWED_MAX_RESPONSE_BYTES = 1_000_000;
const ALLOWED_MAX_HTTP_CALLS = 6;
const ALLOWED_MAX_BUDGET_USD = 0.032;
const REQUIRED_DATASET_ID = 'memory-v3-ru-golden-v2';
const REQUIRED_DATASET_VERSION = '2.0.0';
const ALLOWED_BUDGET_FIXED = Object.freeze({
  caseCount: 6,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.22,
  outputUsdPerMillion: 1.32,
  maxRequests: 6,
});
const EXTRACTOR_V2_DIAGNOSTIC_CODES = Object.freeze(
  new Set([
    'extractor_v2_adapter_failed',
    'extractor_v2_parse_invalid',
    'extractor_v2_shape_invalid',
    'extractor_v2_contract_invalid',
    'extractor_v2_contract_insufficient_recurrence_episodes',
    'extractor_v2_contract_missing_required_relation',
    'extractor_v2_contract_hypothesis_alternative',
    'extractor_v2_unknown_failure',
  ]),
);

export const SIX_CASE_BENCHMARK_V2_CASE_IDS = Object.freeze([
  'memv3-ru-event-03',
  'memv3-ru-correction-04',
  'memv3-ru-recurrence-02',
  'memv3-ru-hypothesis-01',
  'memv3-ru-counterexample-01',
  'memv3-ru-safety-03',
]);

export const SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION = 'memory-v3-openrouter-luna-six-v2';

const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze([
  'dataset',
  'model',
  'extractorVersion',
  'budget',
  'maxPromptRequestBytesPerCase',
  'execute',
]);
const OPTION_OPTIONAL = Object.freeze(['apiKey', 'fetchImpl']);
const SEMANTIC_REVIEW = Object.freeze({
  status: 'required',
  reason: 'Structural evaluator does not judge claim meaning or forbidden remembered meaning',
});

function fail(message) {
  const error = new Error(`[memory-v3:live-benchmark-six-v2] ${message}`);
  error.name = 'MemoryV3SixCaseBenchmarkV2Error';
  OWN_ERRORS.add(error);
  return error;
}

function isOwnError(error) {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    OWN_ERRORS.has(error)
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectPlainObject(value, path) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail(`${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(`${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail(`${path} must be a plain object`);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} has an invalid shape`);
  }
}

function dataDescriptor(value, key, path) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(`${path} has an invalid shape`);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    throw fail(`${path} has an invalid field`);
  }
  return desc;
}

function inspectRecordPartial(value, required, optional, path) {
  const keys = inspectPlainObject(value, path);
  const allowedSet = new Set([...required, ...optional]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(`${path} has an unknown field`);
    }
    const desc = dataDescriptor(value, key, path);
    if (desc.value === undefined) {
      throw fail(`${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path) {
  if (!Array.isArray(value)) {
    throw fail(`${path} must be a dense array`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} must be a dense array`);
  }
  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) allowed.add(String(i));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail(`${path} has an invalid field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail(`${path} has an invalid field`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      throw fail(`${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      throw fail(`${path} has an invalid field`);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail(`${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function cloneJsonData(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail(`${path} is invalid`);
    return value;
  }
  if (Array.isArray(value)) {
    return inspectDenseArray(value, path).map((entry, index) =>
      cloneJsonData(entry, `${path}[${index}]`),
    );
  }
  const keys = inspectPlainObject(value, path);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol') throw fail(`${path} has an invalid field`);
    const desc = dataDescriptor(value, key, path);
    copy[key] = cloneJsonData(desc.value, `${path}.${key}`);
  }
  return copy;
}

function inspectDataset(dataset) {
  const keys = inspectPlainObject(dataset, 'dataset');
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol') throw fail('dataset has an invalid field');
    const desc = dataDescriptor(dataset, key, 'dataset');
    if (key === 'datasetId' || key === 'version' || key === 'cases') {
      copy[key] = desc.value;
    }
  }
  if (copy.datasetId !== REQUIRED_DATASET_ID || copy.version !== REQUIRED_DATASET_VERSION) {
    throw fail('dataset identity is invalid');
  }
  copy.cases = inspectDenseArray(copy.cases, 'dataset.cases');
  return copy;
}

function readDataCaseId(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(entry, 'caseId');
  } catch {
    throw fail('case has an invalid shape');
  }
  if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(desc, 'value') || desc.enumerable !== true) {
    return null;
  }
  return desc.value;
}

function requestByteLength(request) {
  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw fail('extractor request cannot be serialized');
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function inspectOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('options must be a plain object');
  }
  const inspected = inspectRecordPartial(options, OPTION_REQUIRED, OPTION_OPTIONAL, 'options');
  if (typeof inspected.execute !== 'boolean') {
    throw fail('execute must be a boolean');
  }
  if (inspected.apiKey !== undefined && typeof inspected.apiKey !== 'string') {
    throw fail('apiKey must be a string');
  }
  if (inspected.fetchImpl !== undefined && typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  if (inspected.model !== ALLOWED_MODEL) {
    throw fail('model is not allowed');
  }
  if (inspected.extractorVersion !== SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION) {
    throw fail('extractorVersion is not allowed');
  }
  if (
    !Number.isInteger(inspected.maxPromptRequestBytesPerCase) ||
    inspected.maxPromptRequestBytesPerCase <= 0 ||
    inspected.maxPromptRequestBytesPerCase > Number.MAX_SAFE_INTEGER
  ) {
    throw fail('maxPromptRequestBytesPerCase must be a positive safe integer');
  }
  if (inspected.execute && !isNonEmptyString(inspected.apiKey)) {
    throw fail('api key is required');
  }
  if (inspected.execute && typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl is required');
  }
  return inspected;
}

function inspectBudget(budget) {
  const copied = cloneJsonData(budget, 'budget');
  for (const [field, expected] of Object.entries(ALLOWED_BUDGET_FIXED)) {
    if (copied[field] !== expected) {
      throw fail('budget does not match the allowed six-case contract');
    }
  }
  if (typeof copied.maxBudgetUsd !== 'number' || !Number.isFinite(copied.maxBudgetUsd)) {
    throw fail('budget.maxBudgetUsd is invalid');
  }
  if (copied.maxBudgetUsd > ALLOWED_MAX_BUDGET_USD || copied.maxBudgetUsd < 0) {
    throw fail('budget.maxBudgetUsd exceeds the allowed ceiling');
  }
  return copied;
}

function selectSixCases(dataset) {
  const inspected = inspectDataset(dataset);
  const selected = [];
  for (const caseId of SIX_CASE_BENCHMARK_V2_CASE_IDS) {
    const matches = [];
    for (const entry of inspected.cases) {
      if (readDataCaseId(entry) === caseId) matches.push(entry);
    }
    if (matches.length !== 1) {
      throw fail('caseId is invalid');
    }
    let validated;
    try {
      validated = validateCaseV2(matches[0]);
    } catch {
      throw fail('case is invalid');
    }
    selected.push({
      caseId,
      raw: matches[0],
      validated,
    });
  }
  return {
    datasetId: inspected.datasetId,
    version: inspected.version,
    selected,
  };
}

function measurePromptBytes(selected, maxPromptRequestBytesPerCase) {
  const byCase = [];
  let total = 0;
  let max = 0;
  for (const entry of selected) {
    let request;
    try {
      request = buildExtractorRequestV2(entry.validated);
    } catch {
      throw fail('extractor request is invalid');
    }
    const bytes = requestByteLength(request);
    if (bytes > maxPromptRequestBytesPerCase) {
      throw fail('prompt request exceeds maxPromptRequestBytesPerCase');
    }
    total += bytes;
    if (bytes > max) max = bytes;
    byCase.push({ caseId: entry.caseId, bytes });
  }
  return { total, max, byCase };
}

function projectSafeItems(items) {
  return items.map((item) => ({
    kind: item.kind,
    status: item.status,
    claim: item.claim,
    alternative: item.alternative ?? null,
  }));
}

function projectSafeEvidence(evidence) {
  return evidence.map((entry) => ({
    sourceMessageId: entry.sourceMessageId,
    relation: entry.relation,
    supportType: entry.supportType ?? null,
    episodeKey: entry.episodeKey,
  }));
}

function projectGold(caseData) {
  const required = [];
  const acceptable = [];
  for (const item of goldItemsV2(caseData)) {
    const projected = {
      goldItemId: item.goldItemId,
      tier: item.tier,
      kind: item.kind,
      status: item.entry.status ?? null,
      claim: item.entry.claim,
      alternative: item.entry.alternative ?? null,
      supportMessageIds: [...(item.entry.supportMessageIds ?? [])],
      correctedMessageIds: [...(item.entry.correctedMessageIds ?? [])],
      contradictedMessageIds: [...(item.entry.contradictedMessageIds ?? [])],
      rejectedMessageIds: [...(item.entry.rejectedMessageIds ?? [])],
    };
    if (item.kind === 'recurrence') {
      projected.supportTypes = [...item.entry.supportTypes];
      projected.episodeKeys = [...item.entry.episodeKeys];
    }
    if (item.tier === 'required') required.push(projected);
    else acceptable.push(projected);
  }
  return { required, acceptable };
}

function projectHarnessFailureDiagnostic(failed, recorder) {
  const stage = failed.stage;
  if (stage === 'contract' || stage === 'shape' || stage === 'parse') {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(failed, 'diagnosticCode');
    } catch {
      desc = null;
    }
    if (
      desc &&
      typeof desc.get !== 'function' &&
      typeof desc.set !== 'function' &&
      Object.prototype.hasOwnProperty.call(desc, 'value') &&
      EXTRACTOR_V2_DIAGNOSTIC_CODES.has(desc.value) &&
      desc.value !== 'extractor_v2_adapter_failed'
    ) {
      return desc.value;
    }
    if (stage === 'parse') return 'extractor_v2_parse_invalid';
    if (stage === 'shape') return 'extractor_v2_shape_invalid';
    return 'extractor_v2_contract_invalid';
  }
  return recorder.value(failed.caseId);
}

function createDiagnosticRecorder() {
  const codes = new Map();
  let current = null;
  return {
    start(caseId) {
      current = caseId;
      if (!codes.has(caseId)) codes.set(caseId, null);
    },
    remember(next) {
      if (current && codes.get(current) == null && typeof next === 'string') {
        codes.set(current, next);
      }
    },
    value(caseId) {
      return codes.get(caseId) ?? 'unknown_adapter_failure';
    },
  };
}

function wrapTrustedTransport(transport, recorder) {
  return async function recordedTransport(request) {
    try {
      return await transport(request);
    } catch (error) {
      recorder.remember(projectSafeFetchDiagnostic(error));
      throw error;
    }
  };
}

function wrapTrustedAdapter(modelAdapter, recorder) {
  return async function recordedAdapter(request) {
    const caseId =
      request &&
      typeof request === 'object' &&
      request.input &&
      typeof request.input === 'object'
        ? request.input.caseId
        : null;
    if (typeof caseId === 'string') recorder.start(caseId);
    try {
      return await modelAdapter(request);
    } catch (error) {
      recorder.remember(projectSafeOpenRouterDiagnostic(error));
      throw error;
    }
  };
}

function publicBase(fields) {
  return {
    model: fields.model,
    extractorVersion: fields.extractorVersion,
    caseIds: [...SIX_CASE_BENCHMARK_V2_CASE_IDS],
    attemptedCount: fields.attemptedCount,
    successCount: fields.successCount,
    failureCount: fields.failureCount,
    providerHttpCalls: fields.providerHttpCalls,
    maxActive: 1,
    configuredBudget: fields.configuredBudget,
    cases: fields.cases,
    aggregate: fields.aggregate,
    actualUsage: null,
    actualCostUsd: null,
    semanticReview: { ...SEMANTIC_REVIEW },
  };
}

export function createAtMostSixOpenRouterFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  let calls = 0;
  const wrapped = async function boundedOpenRouterFetch(url, init) {
    if (url !== OPENROUTER_URL) {
      throw fail('url is not allowed');
    }
    if (init === null || typeof init !== 'object' || init.method !== 'POST') {
      throw fail('method must be POST');
    }
    if (calls >= ALLOWED_MAX_HTTP_CALLS) {
      throw fail('seventh fetch is not allowed');
    }
    calls += 1;
    return fetchImpl(url, init);
  };
  Object.defineProperty(wrapped, 'callCount', {
    enumerable: true,
    get() {
      return calls;
    },
  });
  return wrapped;
}

export async function runSixCaseLiveBenchmarkV2(options) {
  const inspected = inspectOptions(options);
  const selectedSet = selectSixCases(inspected.dataset);
  const budget = inspectBudget(inspected.budget);
  measurePromptBytes(selectedSet.selected, inspected.maxPromptRequestBytesPerCase);

  let configuredBudget;
  try {
    configuredBudget = assertBudgetGate(budget);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('budget is invalid');
  }
  if (configuredBudget.absoluteMaxRequests !== ALLOWED_MAX_HTTP_CALLS) {
    throw fail('budget.absoluteMaxRequests is invalid');
  }

  if (!inspected.execute) {
    return publicBase({
      model: inspected.model,
      extractorVersion: inspected.extractorVersion,
      attemptedCount: 0,
      successCount: 0,
      failureCount: 0,
      providerHttpCalls: 0,
      configuredBudget,
      cases: SIX_CASE_BENCHMARK_V2_CASE_IDS.map((caseId) => ({ caseId })),
      aggregate: null,
    });
  }

  const countedFetch = createAtMostSixOpenRouterFetch(inspected.fetchImpl);
  const recorder = createDiagnosticRecorder();
  const transport = wrapTrustedTransport(
    createOpenRouterFetchTransport({
      fetchImpl: countedFetch,
      timeoutMs: ALLOWED_TIMEOUT_MS,
      maxResponseBytes: ALLOWED_MAX_RESPONSE_BYTES,
    }),
    recorder,
  );
  const modelAdapter = wrapTrustedAdapter(
    createOpenRouterAdapter({
      transport,
      apiKey: inspected.apiKey,
      model: inspected.model,
      maxOutputTokens: ALLOWED_MAX_OUTPUT_TOKENS,
      reasoningEffort: ALLOWED_REASONING,
      responseContract: 'v2',
    }),
    recorder,
  );

  const subset = {
    datasetId: selectedSet.datasetId,
    version: selectedSet.version,
    cases: selectedSet.selected.map((entry) => entry.raw),
  };

  let report;
  try {
    report = await runOfflineBenchmarkV2({
      dataset: subset,
      modelAdapter,
      budget,
      extractorVersion: inspected.extractorVersion,
      maxPromptRequestBytesPerCase: inspected.maxPromptRequestBytesPerCase,
    });
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('benchmark failed');
  }

  const runById = new Map(report.runs.map((entry) => [entry.caseId, entry]));
  const failureById = new Map(report.failures.map((entry) => [entry.caseId, entry]));
  const cases = [];
  const extractions = [];

  for (const entry of selectedSet.selected) {
    const failed = failureById.get(entry.caseId);
    if (failed) {
      cases.push({
        caseId: entry.caseId,
        stage: failed.stage,
        diagnosticCode: projectHarnessFailureDiagnostic(failed, recorder),
      });
      continue;
    }
    const run = runById.get(entry.caseId);
    if (!run) {
      cases.push({
        caseId: entry.caseId,
        stage: 'unknown',
        diagnosticCode: 'unknown_adapter_failure',
      });
      continue;
    }
    let evaluation;
    try {
      evaluation = evaluateCaseV2(entry.raw, run.extraction);
    } catch {
      cases.push({
        caseId: entry.caseId,
        stage: 'unknown',
        diagnosticCode: recorder.value(entry.caseId),
      });
      continue;
    }
    extractions.push(run.extraction);
    cases.push({
      caseId: entry.caseId,
      itemCount: run.extraction.items.length,
      evidenceCount: run.extraction.evidence.length,
      items: projectSafeItems(run.extraction.items),
      evidence: projectSafeEvidence(run.extraction.evidence),
      evaluation,
    });
  }

  let aggregate = null;
  try {
    const datasetReport = evaluateDatasetV2(subset, extractions, {
      extractorVersion: inspected.extractorVersion,
    });
    aggregate = datasetReport.aggregate;
  } catch {
    aggregate = null;
  }

  return publicBase({
    model: inspected.model,
    extractorVersion: inspected.extractorVersion,
    attemptedCount: report.attemptedCount,
    successCount: report.successCount,
    failureCount: report.failureCount,
    providerHttpCalls: countedFetch.callCount,
    configuredBudget,
    cases,
    aggregate,
  });
}

function inspectAlignedIdList(value, path) {
  const ids = inspectDenseArray(value, path);
  if (ids.length !== SIX_CASE_BENCHMARK_V2_CASE_IDS.length) {
    throw fail(`${path} must contain exactly six case ids`);
  }
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== SIX_CASE_BENCHMARK_V2_CASE_IDS[index]) {
      throw fail(`${path} is misaligned`);
    }
  }
  return ids;
}

function inspectAlignedResultCases(value, path) {
  const cases = inspectDenseArray(value, path);
  if (cases.length !== SIX_CASE_BENCHMARK_V2_CASE_IDS.length) {
    throw fail(`${path} must contain exactly six cases`);
  }
  const seen = new Set();
  for (let index = 0; index < cases.length; index += 1) {
    const caseId = readDataCaseId(cases[index]);
    if (caseId !== SIX_CASE_BENCHMARK_V2_CASE_IDS[index]) {
      throw fail(`${path} is misaligned`);
    }
    if (seen.has(caseId)) {
      throw fail(`${path} has a duplicated caseId`);
    }
    seen.add(caseId);
  }
  return cases;
}

function inspectBenchmarkResult(value) {
  const copied = cloneJsonData(value, 'benchmarkResult');
  if (copied.model !== ALLOWED_MODEL) {
    throw fail('benchmarkResult.model is not allowed');
  }
  if (copied.extractorVersion !== SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION) {
    throw fail('benchmarkResult.extractorVersion is not allowed');
  }
  inspectAlignedIdList(copied.caseIds, 'benchmarkResult.caseIds');
  copied.cases = inspectAlignedResultCases(copied.cases, 'benchmarkResult.cases');
  return copied;
}

function projectSyntheticMessages(caseData) {
  return caseData.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
  }));
}

export function buildSixCaseSemanticReviewPacketV2(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('options must be a plain object');
  }
  const inspected = inspectRecordPartial(
    options,
    ['dataset', 'benchmarkResult'],
    [],
    'options',
  );
  const dataset = inspectDataset(inspected.dataset);
  const result = inspectBenchmarkResult(inspected.benchmarkResult);
  const resultCases = result.cases;
  const resultById = new Map();
  for (const entry of resultCases) {
    const caseId = readDataCaseId(entry);
    if (resultById.has(caseId)) {
      throw fail('benchmarkResult.cases has a duplicated caseId');
    }
    resultById.set(caseId, entry);
  }

  const packetCases = [];
  for (const caseId of SIX_CASE_BENCHMARK_V2_CASE_IDS) {
    const matches = dataset.cases.filter((entry) => readDataCaseId(entry) === caseId);
    if (matches.length !== 1) {
      throw fail('caseId is invalid');
    }
    let validated;
    try {
      validated = validateCaseV2(matches[0]);
    } catch {
      throw fail('case is invalid');
    }
    const resultCase = resultById.get(caseId);
    if (!resultCase) {
      throw fail('benchmarkResult is missing a required case');
    }
    const predicted = Array.isArray(resultCase.items)
      ? resultCase.items.map((item) => ({
          kind: item.kind,
          status: item.status ?? null,
          claim: item.claim,
          alternative: item.alternative ?? null,
        }))
      : [];
    const predictedEvidence = Array.isArray(resultCase.evidence)
      ? resultCase.evidence.map((entry) => ({
          sourceMessageId: entry.sourceMessageId,
          relation: entry.relation,
          supportType: entry.supportType ?? null,
          episodeKey: entry.episodeKey,
        }))
      : [];
    packetCases.push({
      caseId,
      category: validated.category,
      title: validated.title,
      gold: projectGold(validated),
      predicted,
      predictedEvidence,
      messages: projectSyntheticMessages(validated),
      evaluation: resultCase.evaluation ?? null,
      semanticVerdict: null,
      forbiddenMeaningVerdict: null,
      reviewerNotes: null,
    });
  }

  return {
    model: result.model ?? null,
    extractorVersion: result.extractorVersion ?? null,
    cases: packetCases,
  };
}
