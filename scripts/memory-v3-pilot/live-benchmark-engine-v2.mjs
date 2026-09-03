/**
 * Memory V3 V2 shared profile-driven live-benchmark engine.
 * Injected fetchImpl only. No env, fs, global fetch, retry, CLI, or wrappers.
 */

import { goldItemsV2, validateCaseV2 } from './contracts-v2.mjs';
import { evaluateCaseV2, evaluateDatasetV2 } from './evaluator-v2.mjs';
import { buildExtractorRequestV2 } from './extractor-prompt-v2.mjs';
import { runOfflineBenchmarkV2 } from './benchmark-runner-v2.mjs';
import { assertBudgetGate } from './benchmark-budget.mjs';
import { createOpenRouterAdapter, projectSafeOpenRouterDiagnostic } from './openrouter-adapter.mjs';
import { createOpenRouterFetchTransport, projectSafeFetchDiagnostic } from './openrouter-fetch-transport.mjs';
import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const BUDGET_KEYS = Object.freeze([
  'caseCount',
  'maxInputTokensPerCase',
  'maxOutputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'maxRequests',
  'maxBudgetUsd',
]);
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

const OWN_ERRORS = new WeakSet();
const ENGINE_OPTION_REQUIRED = Object.freeze([
  'dataset',
  'profileId',
  'model',
  'extractorVersion',
  'budget',
  'maxPromptRequestBytesPerCase',
  'execute',
]);
const ENGINE_OPTION_OPTIONAL = Object.freeze(['apiKey', 'fetchImpl']);
const PACKET_OPTION_REQUIRED = Object.freeze(['profileId', 'dataset', 'benchmarkResult']);
const SEMANTIC_REVIEW = Object.freeze({
  status: 'required',
  reason: 'Structural evaluator does not judge claim meaning or forbidden remembered meaning',
});

function fail(message, canonical) {
  const prefix = canonical?.engineErrorPrefix ?? '[memory-v3:live-benchmark-engine-v2]';
  const error = new Error(`${prefix} ${message}`);
  error.name = canonical?.engineErrorName ?? 'MemoryV3ProfileLiveBenchmarkV2Error';
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

function guardedIsArray(value, canonical, message) {
  try {
    return Array.isArray(value);
  } catch {
    throw fail(message, canonical);
  }
}

function guardedOwnKeys(value, canonical, message) {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(message, canonical);
  }
}

function guardedGetPrototypeOf(value, canonical, message) {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw fail(message, canonical);
  }
}

function guardedGetOwnPropertyDescriptor(value, key, canonical, message) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(message, canonical);
  }
}

function inspectPlainObject(value, path, canonical) {
  if (value === null || typeof value !== 'object' || guardedIsArray(value, canonical, `${path} must be a plain object`)) {
    throw fail(`${path} must be a plain object`, canonical);
  }
  const proto = guardedGetPrototypeOf(value, canonical, `${path} must be a plain object`);
  if (proto !== Object.prototype && proto !== null) {
    throw fail(`${path} must be a plain object`, canonical);
  }
  return guardedOwnKeys(value, canonical, `${path} has an invalid shape`);
}

function dataDescriptor(value, key, path, canonical) {
  const desc = guardedGetOwnPropertyDescriptor(
    value,
    key,
    canonical,
    `${path} has an invalid shape`,
  );
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    throw fail(`${path} has an invalid field`, canonical);
  }
  return desc;
}

function inspectRecordPartial(value, required, optional, path, canonical) {
  const keys = inspectPlainObject(value, path, canonical);
  const allowedSet = new Set([...required, ...optional]);
  const copy = Object.create(null);
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(`${path} has an unknown field`, canonical);
    }
    const desc = dataDescriptor(value, key, path, canonical);
    if (desc.value === undefined) {
      throw fail(`${path} is missing a required field`, canonical);
    }
    defineOwnData(copy, key, desc.value);
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(`${path} is missing a required field`, canonical);
    }
  }
  return copy;
}

function inspectDenseArray(value, path, canonical) {
  if (!guardedIsArray(value, canonical, `${path} must be a dense array`)) {
    throw fail(`${path} must be a dense array`, canonical);
  }
  const keys = guardedOwnKeys(value, canonical, `${path} must be a dense array`);
  const descriptors = new Map();
  for (const key of keys) {
    descriptors.set(
      key,
      guardedGetOwnPropertyDescriptor(value, key, canonical, `${path} has an invalid field`),
    );
  }
  const lengthDesc = descriptors.get('length');
  if (
    !lengthDesc ||
    typeof lengthDesc.get === 'function' ||
    typeof lengthDesc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(lengthDesc, 'value') ||
    typeof lengthDesc.value !== 'number' ||
    !Number.isInteger(lengthDesc.value) ||
    lengthDesc.value < 0
  ) {
    throw fail(`${path} must be a dense array`, canonical);
  }
  const length = lengthDesc.value;
  let observedLength;
  try {
    observedLength = Reflect.get(value, 'length');
  } catch {
    throw fail(`${path} must be a dense array`, canonical);
  }
  if (observedLength !== length) {
    throw fail(`${path} must be a dense array`, canonical);
  }
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) allowed.add(String(i));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail(`${path} has an invalid field`, canonical);
    }
    const desc = descriptors.get(key);
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      throw fail(`${path} has an invalid field`, canonical);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      throw fail(`${path} has an invalid field`, canonical);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = descriptors.get(String(i));
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail(`${path} must be a dense array`, canonical);
    }
    entries.push(desc.value);
  }
  return entries;
}

function defineOwnData(target, key, value) {
  Object.defineProperty(target, key, {
    enumerable: true,
    writable: true,
    configurable: true,
    value,
  });
}

function cloneJsonData(value, path, canonical, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail(`${path} is invalid`, canonical);
    return value;
  }
  if (typeof value !== 'object') {
    throw fail(`${path} is invalid`, canonical);
  }
  if (active.has(value)) {
    throw fail(`${path} has an invalid shape`, canonical);
  }
  active.add(value);
  try {
    if (guardedIsArray(value, canonical, `${path} has an invalid shape`)) {
      const entries = inspectDenseArray(value, path, canonical);
      const copy = [];
      for (let index = 0; index < entries.length; index += 1) {
        defineOwnData(
          copy,
          String(index),
          cloneJsonData(entries[index], path, canonical, active),
        );
      }
      copy.length = entries.length;
      return copy;
    }
    const keys = inspectPlainObject(value, path, canonical);
    const copy = Object.create(null);
    for (const key of keys) {
      if (typeof key === 'symbol') throw fail(`${path} has an invalid field`, canonical);
      const desc = dataDescriptor(value, key, path, canonical);
      defineOwnData(copy, key, cloneJsonData(desc.value, path, canonical, active));
    }
    return copy;
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail(`${path} has an invalid shape`, canonical);
  } finally {
    active.delete(value);
  }
}

function inspectDataset(dataset, canonical) {
  const keys = inspectPlainObject(dataset, 'dataset', canonical);
  const copy = Object.create(null);
  for (const key of keys) {
    if (typeof key === 'symbol') throw fail('dataset has an invalid field', canonical);
    const desc = dataDescriptor(dataset, key, 'dataset', canonical);
    if (key === 'datasetId' || key === 'version' || key === 'cases') {
      defineOwnData(copy, key, desc.value);
    }
  }
  if (copy.datasetId !== canonical.datasetId || copy.version !== canonical.datasetVersion) {
    throw fail('dataset identity is invalid', canonical);
  }
  const cases = inspectDenseArray(copy.cases, 'dataset.cases', canonical);
  const seen = new Set();
  const normalized = [];
  for (const entry of cases) {
    let validated;
    try {
      validated = validateCaseV2(entry);
    } catch {
      throw fail('case is invalid', canonical);
    }
    const caseId = readDataCaseId(entry);
    if (typeof caseId !== 'string' || caseId.length === 0 || caseId !== validated.caseId) {
      throw fail('caseId is invalid', canonical);
    }
    if (seen.has(caseId)) {
      throw fail('caseId is invalid', canonical);
    }
    seen.add(caseId);
    normalized.push({ raw: entry, validated, caseId });
  }
  defineOwnData(copy, 'cases', cases);
  defineOwnData(copy, 'normalized', normalized);
  return copy;
}

function readDataCaseId(entry) {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  let isArray;
  try {
    isArray = Array.isArray(entry);
  } catch {
    return null;
  }
  if (isArray) {
    return null;
  }
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(entry, 'caseId');
  } catch {
    return null;
  }
  if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(desc, 'value') || desc.enumerable !== true) {
    return null;
  }
  return desc.value;
}

function requestByteLength(request, canonical) {
  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw fail('extractor request cannot be serialized', canonical);
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function resolveCanonicalProfileId(profileId, canonical) {
  if (typeof profileId !== 'string' || profileId.length === 0 || profileId.trim() !== profileId) {
    throw fail('profileId has an invalid field', canonical);
  }
  try {
    return getLiveBenchmarkProfileV2(profileId);
  } catch {
    throw fail('profileId is not allowed', canonical);
  }
}

function readOwnEnumerablePrimitiveString(value, key, path, canonical) {
  const desc = dataDescriptor(value, key, path, canonical);
  if (typeof desc.value !== 'string' || desc.value.length === 0 || desc.value.trim() !== desc.value) {
    throw fail(`${path} has an invalid field`, canonical);
  }
  return desc.value;
}

function inspectEngineOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    guardedIsArray(options, undefined, 'options must be a plain object')
  ) {
    throw fail('options must be a plain object');
  }
  inspectPlainObject(options, 'options');
  const profileId = readOwnEnumerablePrimitiveString(options, 'profileId', 'options');
  const canonical = resolveCanonicalProfileId(profileId);
  const inspected = inspectRecordPartial(
    options,
    ENGINE_OPTION_REQUIRED,
    ENGINE_OPTION_OPTIONAL,
    'options',
    canonical,
  );
  if (typeof inspected.execute !== 'boolean') {
    throw fail('execute must be a boolean', canonical);
  }
  if (inspected.model !== canonical.model) {
    throw fail('model is not allowed', canonical);
  }
  if (inspected.extractorVersion !== canonical.extractorVersion) {
    throw fail('extractorVersion is not allowed', canonical);
  }
  if (inspected.maxPromptRequestBytesPerCase !== canonical.maxPromptRequestBytesPerCase) {
    throw fail('maxPromptRequestBytesPerCase is not allowed', canonical);
  }
  inspected.canonical = canonical;
  return inspected;
}

function ownEnumerableStringKeys(copied) {
  return Reflect.ownKeys(copied)
    .filter((key) => typeof key === 'string')
    .sort();
}

function inspectBudget(budget, canonical) {
  const copied = cloneJsonData(budget, 'budget', canonical);
  const names = ownEnumerableStringKeys(copied);
  const expected = [...BUDGET_KEYS].sort();
  if (names.length !== expected.length) {
    throw fail('budget does not match the allowed profile contract', canonical);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (names[index] !== expected[index]) {
      throw fail('budget does not match the allowed profile contract', canonical);
    }
  }
  for (const field of BUDGET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(copied, field) || copied[field] !== canonical[field]) {
      throw fail('budget does not match the allowed profile contract', canonical);
    }
  }
  return copied;
}

function selectProfileCases(dataset, canonical) {
  const inspected = inspectDataset(dataset, canonical);
  const byId = new Map();
  for (const entry of inspected.normalized) {
    byId.set(entry.caseId, entry);
  }
  const selected = [];
  for (const caseId of canonical.caseIds) {
    const match = byId.get(caseId);
    if (!match) {
      throw fail('caseId is invalid', canonical);
    }
    selected.push({
      caseId,
      raw: match.raw,
      validated: match.validated,
    });
  }
  return {
    datasetId: inspected.datasetId,
    version: inspected.version,
    selected,
  };
}

function measurePromptBytes(selected, canonical) {
  const byCase = [];
  let total = 0;
  let max = 0;
  for (const entry of selected) {
    let request;
    try {
      request = buildExtractorRequestV2(entry.validated);
    } catch {
      throw fail('extractor request is invalid', canonical);
    }
    const bytes = requestByteLength(request, canonical);
    if (bytes > canonical.maxPromptRequestBytesPerCase) {
      throw fail('prompt request exceeds maxPromptRequestBytesPerCase', canonical);
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

function publicBase(fields, canonical) {
  return {
    model: fields.model,
    extractorVersion: fields.extractorVersion,
    caseIds: [...canonical.caseIds],
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

export function createProfileBoundedOpenRouterFetch(fetchImpl, profileId) {
  if (typeof fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  const canonical = resolveCanonicalProfileId(profileId);
  let callCount = 0;
  const wrapped = async function boundedOpenRouterFetch(url, init) {
    if (callCount >= canonical.maxRequests) {
      throw fail(canonical.httpCapError, canonical);
    }
    if (url !== OPENROUTER_URL) {
      throw fail('url is not allowed', canonical);
    }
    if (
      init === null ||
      typeof init !== 'object' ||
      guardedIsArray(init, canonical, 'method must be POST')
    ) {
      throw fail('method must be POST', canonical);
    }
    const methodDesc = guardedGetOwnPropertyDescriptor(
      init,
      'method',
      canonical,
      'method must be POST',
    );
    if (
      !methodDesc ||
      typeof methodDesc.get === 'function' ||
      typeof methodDesc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(methodDesc, 'value') ||
      methodDesc.enumerable !== true ||
      methodDesc.value !== 'POST'
    ) {
      throw fail('method must be POST', canonical);
    }
    callCount += 1;
    return fetchImpl(url, init);
  };
  Object.defineProperty(wrapped, 'callCount', {
    enumerable: true,
    get() {
      return callCount;
    },
  });
  return wrapped;
}

export async function runProfileLiveBenchmarkV2(options) {
  const inspected = inspectEngineOptions(options);
  const canonical = inspected.canonical;
  const selectedSet = selectProfileCases(inspected.dataset, canonical);
  const budget = inspectBudget(inspected.budget, canonical);
  measurePromptBytes(selectedSet.selected, canonical);

  let configuredBudget;
  try {
    configuredBudget = assertBudgetGate(budget);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('budget is invalid', canonical);
  }
  if (configuredBudget.absoluteMaxRequests !== canonical.maxRequests) {
    throw fail('budget.absoluteMaxRequests is invalid', canonical);
  }

  if (!inspected.execute) {
    return publicBase(
      {
        model: inspected.model,
        extractorVersion: inspected.extractorVersion,
        attemptedCount: 0,
        successCount: 0,
        failureCount: 0,
        providerHttpCalls: 0,
        configuredBudget,
        cases: [...canonical.caseIds].map((caseId) => ({ caseId })),
        aggregate: null,
      },
      canonical,
    );
  }

  if (typeof inspected.apiKey !== 'string') {
    throw fail(inspected.apiKey === undefined ? 'api key is required' : 'apiKey must be a string', canonical);
  }
  if (!isNonEmptyString(inspected.apiKey)) {
    throw fail('api key is required', canonical);
  }
  if (typeof inspected.fetchImpl !== 'function') {
    throw fail(
      inspected.fetchImpl === undefined ? 'fetchImpl is required' : 'fetchImpl must be a function',
      canonical,
    );
  }

  const countedFetch = createProfileBoundedOpenRouterFetch(inspected.fetchImpl, inspected.profileId);
  const recorder = createDiagnosticRecorder();
  const transport = wrapTrustedTransport(
    createOpenRouterFetchTransport({
      fetchImpl: countedFetch,
      timeoutMs: canonical.timeoutMs,
      maxResponseBytes: canonical.maxResponseBytes,
    }),
    recorder,
  );
  const modelAdapter = wrapTrustedAdapter(
    createOpenRouterAdapter({
      transport,
      apiKey: inspected.apiKey,
      model: canonical.model,
      maxOutputTokens: canonical.maxOutputTokensPerCase,
      reasoningEffort: canonical.reasoningEffort,
      responseContract: canonical.responseContract,
      allowFallbacks: canonical.allowFallbacks,
      maxTokensParameter: canonical.maxTokensParameter,
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
      extractorVersion: canonical.extractorVersion,
      maxPromptRequestBytesPerCase: canonical.maxPromptRequestBytesPerCase,
    });
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('benchmark failed', canonical);
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
      extractorVersion: canonical.extractorVersion,
    });
    aggregate = datasetReport.aggregate;
  } catch {
    aggregate = null;
  }

  return publicBase(
    {
      model: canonical.model,
      extractorVersion: canonical.extractorVersion,
      attemptedCount: report.attemptedCount,
      successCount: report.successCount,
      failureCount: report.failureCount,
      providerHttpCalls: countedFetch.callCount,
      configuredBudget,
      cases,
      aggregate,
    },
    canonical,
  );
}

function inspectAlignedIdList(value, path, canonical) {
  const ids = inspectDenseArray(value, path, canonical);
  if (ids.length !== canonical.caseIds.length) {
    throw fail(`${path} is misaligned`, canonical);
  }
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== canonical.caseIds[index]) {
      throw fail(`${path} is misaligned`, canonical);
    }
  }
  return ids;
}

function inspectAlignedResultCases(value, path, canonical) {
  const cases = inspectDenseArray(value, path, canonical);
  if (cases.length !== canonical.caseIds.length) {
    throw fail(`${path} is misaligned`, canonical);
  }
  const seen = new Set();
  for (let index = 0; index < cases.length; index += 1) {
    const caseId = readDataCaseId(cases[index]);
    if (caseId !== canonical.caseIds[index]) {
      throw fail(`${path} is misaligned`, canonical);
    }
    if (seen.has(caseId)) {
      throw fail(`${path} has a duplicated caseId`, canonical);
    }
    seen.add(caseId);
  }
  return cases;
}

function inspectBenchmarkResult(value, canonical) {
  const copied = cloneJsonData(value, 'benchmarkResult', canonical);
  const allowed = new Set([
    'model',
    'extractorVersion',
    'caseIds',
    'attemptedCount',
    'successCount',
    'failureCount',
    'providerHttpCalls',
    'maxActive',
    'configuredBudget',
    'cases',
    'aggregate',
    'actualUsage',
    'actualCostUsd',
    'semanticReview',
  ]);
  for (const key of Reflect.ownKeys(copied)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw fail('benchmarkResult has an unknown field', canonical);
    }
  }
  if (
    !Object.prototype.hasOwnProperty.call(copied, 'model') ||
    copied.model !== canonical.model
  ) {
    throw fail('benchmarkResult.model is not allowed', canonical);
  }
  if (
    !Object.prototype.hasOwnProperty.call(copied, 'extractorVersion') ||
    copied.extractorVersion !== canonical.extractorVersion
  ) {
    throw fail('benchmarkResult.extractorVersion is not allowed', canonical);
  }
  inspectAlignedIdList(copied.caseIds, 'benchmarkResult.caseIds', canonical);
  copied.cases = inspectAlignedResultCases(copied.cases, 'benchmarkResult.cases', canonical);
  return copied;
}

function projectSyntheticMessages(caseData) {
  return caseData.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
  }));
}

export function buildProfileSemanticReviewPacketV2(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    guardedIsArray(options, undefined, 'options must be a plain object')
  ) {
    throw fail('options must be a plain object');
  }
  inspectPlainObject(options, 'options');
  const profileId = readOwnEnumerablePrimitiveString(options, 'profileId', 'options');
  const canonical = resolveCanonicalProfileId(profileId);
  const inspected = inspectRecordPartial(
    options,
    PACKET_OPTION_REQUIRED,
    [],
    'options',
    canonical,
  );
  const dataset = inspectDataset(inspected.dataset, canonical);
  const result = inspectBenchmarkResult(inspected.benchmarkResult, canonical);
  const resultById = new Map();
  for (const entry of result.cases) {
    const caseId = readDataCaseId(entry);
    if (resultById.has(caseId)) {
      throw fail('benchmarkResult.cases has a duplicated caseId', canonical);
    }
    resultById.set(caseId, entry);
  }

  const packetCases = [];
  for (const caseId of canonical.caseIds) {
    const matches = dataset.cases.filter((entry) => readDataCaseId(entry) === caseId);
    if (matches.length !== 1) {
      throw fail('caseId is invalid', canonical);
    }
    let validated;
    try {
      validated = validateCaseV2(matches[0]);
    } catch {
      throw fail('case is invalid', canonical);
    }
    const resultCase = resultById.get(caseId);
    if (!resultCase) {
      throw fail('benchmarkResult is missing a required case', canonical);
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
