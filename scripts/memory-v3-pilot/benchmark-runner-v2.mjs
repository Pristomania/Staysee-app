/**
 * Memory V3 Task 6 — V2 offline sequential benchmark runner.
 * Preflight and byte cap before any adapter call. No evaluator, fs, env, CLI, or network.
 */

import { validateCaseV2 } from './contracts-v2.mjs';
import { extractCaseV2, projectSafeExtractorDiagnosticV2 } from './extractor-core-v2.mjs';
import { buildExtractorRequestV2 } from './extractor-prompt-v2.mjs';
import { assertBudgetGate } from './benchmark-budget.mjs';

const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze([
  'dataset',
  'modelAdapter',
  'budget',
  'extractorVersion',
  'maxPromptRequestBytesPerCase',
]);
const DATASET_REQUIRED = Object.freeze(['datasetId', 'version', 'cases']);
const DATASET_OPTIONAL = Object.freeze(['language', 'privacy']);
const REQUIRED_DATASET_ID = 'memory-v3-ru-golden-v2';
const REQUIRED_DATASET_VERSION = '2.0.0';
const STAGE_BY_DIAGNOSTIC = Object.freeze({
  extractor_v2_adapter_failed: 'adapter',
  extractor_v2_parse_invalid: 'parse',
  extractor_v2_shape_invalid: 'shape',
  extractor_v2_contract_invalid: 'contract',
  extractor_v2_contract_insufficient_recurrence_episodes: 'contract',
  extractor_v2_contract_missing_required_relation: 'contract',
  extractor_v2_contract_hypothesis_alternative: 'contract',
});

function fail(message) {
  const error = new Error(`[memory-v3:v2-benchmark-config] ${message}`);
  error.name = 'MemoryV3V2BenchmarkError';
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
  const projected = inspectRecordPartial(
    dataset,
    DATASET_REQUIRED,
    DATASET_OPTIONAL,
    'dataset',
  );
  if (projected.datasetId !== REQUIRED_DATASET_ID || projected.version !== REQUIRED_DATASET_VERSION) {
    throw fail('dataset identity is invalid');
  }
  const cases = inspectDenseArray(projected.cases, 'dataset.cases');
  if (cases.length === 0) {
    throw fail('dataset.cases must not be empty');
  }
  return {
    datasetId: projected.datasetId,
    version: projected.version,
    cases,
  };
}

function requestByteLength(request) {
  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw fail('extractor request cannot be serialized');
  }
  if (typeof serialized !== 'string') {
    throw fail('extractor request cannot be serialized');
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function inspectBudgetCaseCount(budget) {
  const copied = cloneJsonData(budget, 'budget');
  if (!Number.isInteger(copied.caseCount)) {
    throw fail('budget.caseCount must be an integer');
  }
  return copied.caseCount;
}

function classifyFailure(error) {
  let projected = null;
  try {
    projected = projectSafeExtractorDiagnosticV2(error);
  } catch {
    projected = null;
  }
  if (projected == null) {
    return {
      stage: 'unknown',
      diagnosticCode: 'extractor_v2_unknown_failure',
    };
  }
  return {
    stage: STAGE_BY_DIAGNOSTIC[projected] ?? 'unknown',
    diagnosticCode: projected,
  };
}

export function projectOfflineBenchmarkFailureDiagnosticV2(error) {
  try {
    return projectSafeExtractorDiagnosticV2(error) ?? 'extractor_v2_unknown_failure';
  } catch {
    return 'extractor_v2_unknown_failure';
  }
}

export async function runOfflineBenchmarkV2(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('options must be a plain object');
  }
  const inspected = inspectRecordPartial(options, OPTION_REQUIRED, [], 'options');
  if (typeof inspected.modelAdapter !== 'function') {
    throw fail('modelAdapter must be a function');
  }
  if (!isNonEmptyString(inspected.extractorVersion)) {
    throw fail('extractorVersion is required');
  }
  if (
    !Number.isInteger(inspected.maxPromptRequestBytesPerCase) ||
    inspected.maxPromptRequestBytesPerCase <= 0 ||
    inspected.maxPromptRequestBytesPerCase > Number.MAX_SAFE_INTEGER
  ) {
    throw fail('maxPromptRequestBytesPerCase must be a positive safe integer');
  }

  const dataset = inspectDataset(inspected.dataset);
  const validatedCases = [];
  const seenCaseIds = new Set();
  for (const caseData of dataset.cases) {
    let validated;
    try {
      validated = validateCaseV2(caseData);
    } catch {
      throw fail('case is invalid');
    }
    if (seenCaseIds.has(validated.caseId)) {
      throw fail('caseId values must be unique');
    }
    seenCaseIds.add(validated.caseId);
    validatedCases.push({ raw: caseData, validated });
  }

  const budgetCaseCount = inspectBudgetCaseCount(inspected.budget);
  if (budgetCaseCount !== dataset.cases.length) {
    throw fail('budget.caseCount must equal dataset case count');
  }

  for (const entry of validatedCases) {
    let request;
    try {
      request = buildExtractorRequestV2(entry.validated);
    } catch {
      throw fail('extractor request is invalid');
    }
    const bytes = requestByteLength(request);
    if (bytes > inspected.maxPromptRequestBytesPerCase) {
      throw fail('prompt request exceeds maxPromptRequestBytesPerCase');
    }
  }

  try {
    assertBudgetGate(inspected.budget);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('budget is invalid');
  }

  const runs = [];
  const failures = [];
  for (const entry of validatedCases) {
    try {
      const extraction = await extractCaseV2(entry.raw, inspected.modelAdapter, {
        extractorVersion: inspected.extractorVersion,
      });
      runs.push({
        caseId: entry.validated.caseId,
        extraction,
      });
    } catch (error) {
      if (isOwnError(error)) throw error;
      const classified = classifyFailure(error);
      failures.push({
        caseId: entry.validated.caseId,
        stage: classified.stage,
        diagnosticCode: classified.diagnosticCode,
      });
    }
  }

  return {
    extractorVersion: inspected.extractorVersion,
    caseCount: dataset.cases.length,
    attemptedCount: runs.length + failures.length,
    successCount: runs.length,
    failureCount: failures.length,
    runs,
    failures,
  };
}
