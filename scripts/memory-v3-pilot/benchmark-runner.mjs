/**
 * Memory V3 Task 3B — offline sequential benchmark runner.
 * Preflight and byte cap before any adapter call. No evaluator, fs, env, CLI, or network.
 */

import { validateCase } from './contracts.mjs';
import { extractCase } from './extractor-core.mjs';
import { buildExtractorRequest } from './extractor-prompt.mjs';
import { assertBudgetGate } from './benchmark-budget.mjs';

const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze([
  'dataset',
  'modelAdapter',
  'budget',
  'extractorVersion',
  'maxPromptRequestBytesPerCase',
]);
const FAILURE_STAGES = Object.freeze({
  '[memory-v3:adapter]': 'adapter',
  '[memory-v3:parse]': 'parse',
  '[memory-v3:shape]': 'shape',
  '[memory-v3:contract]': 'contract',
});

function fail(stage, message) {
  const error = new Error(`[memory-v3:benchmark-${stage}] ${message}`);
  error.name = 'MemoryV3BenchmarkError';
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

function inspectPlainObject(value, path, stage) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail(stage, `${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(stage, `${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail(stage, `${path} must be a plain object`);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(stage, `${path} has an invalid shape`);
  }
}

function dataDescriptor(value, key, path, stage) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(stage, `${path} has an invalid shape`);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    throw fail(stage, `${path} has an invalid field`);
  }
  return desc;
}

function inspectRecordPartial(value, required, optional, path, stage) {
  const keys = inspectPlainObject(value, path, stage);
  const allowedSet = new Set([...required, ...optional]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(stage, `${path} has an unknown field`);
    }
    const desc = dataDescriptor(value, key, path, stage);
    if (desc.value === undefined) {
      throw fail(stage, `${path} is missing a required field`);
    }
    copy[key] = desc.value;
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(stage, `${path} is missing a required field`);
    }
  }
  return copy;
}

function projectRecord(value, path, stage, spec) {
  const keys = inspectPlainObject(value, path, stage);
  const pick = new Set([...(spec.required || []), ...(spec.pick || [])]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol') {
      throw fail(stage, `${path} has an invalid field`);
    }
    const desc = dataDescriptor(value, key, path, stage);
    if (!pick.has(key)) continue;
    copy[key] = desc.value;
  }
  for (const field of spec.required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(stage, `${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path, stage) {
  if (!Array.isArray(value)) {
    throw fail(stage, `${path} must be a dense array`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail(stage, `${path} must be a dense array`);
  }
  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) allowed.add(String(i));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail(stage, `${path} has an invalid field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail(stage, `${path} has an invalid field`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      throw fail(stage, `${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      throw fail(stage, `${path} has an invalid field`);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      throw fail(stage, `${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function cloneJsonData(value, path, stage) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail(stage, `${path} is invalid`);
    return value;
  }
  if (Array.isArray(value)) {
    return inspectDenseArray(value, path, stage).map((entry, index) =>
      cloneJsonData(entry, `${path}[${index}]`, stage),
    );
  }
  const keys = inspectPlainObject(value, path, stage);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol') throw fail(stage, `${path} has an invalid field`);
    const desc = dataDescriptor(value, key, path, stage);
    copy[key] = cloneJsonData(desc.value, `${path}.${key}`, stage);
  }
  return copy;
}

function inspectDataset(dataset) {
  const projected = projectRecord(dataset, 'dataset', 'config', {
    required: ['datasetId', 'version', 'cases'],
  });
  if (!isNonEmptyString(projected.datasetId) || !isNonEmptyString(projected.version)) {
    throw fail('config', 'dataset identity is invalid');
  }
  const cases = inspectDenseArray(projected.cases, 'dataset.cases', 'config');
  if (cases.length === 0) {
    throw fail('config', 'dataset.cases must not be empty');
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
    throw fail('config', 'extractor request cannot be serialized');
  }
  if (typeof serialized !== 'string') {
    throw fail('config', 'extractor request cannot be serialized');
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function classifyFailureStage(error) {
  const message =
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    typeof error.message === 'string'
      ? error.message
      : '';
  for (const [prefix, stage] of Object.entries(FAILURE_STAGES)) {
    if (message.startsWith(prefix)) return stage;
  }
  return 'unknown';
}

function inspectBudgetCaseCount(budget) {
  const copied = cloneJsonData(budget, 'budget', 'config');
  if (!Number.isInteger(copied.caseCount)) {
    throw fail('config', 'budget.caseCount must be an integer');
  }
  return copied.caseCount;
}

export async function runOfflineBenchmark(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('config', 'options must be a plain object');
  }
  const inspected = inspectRecordPartial(
    options,
    OPTION_REQUIRED,
    [],
    'options',
    'config',
  );
  if (typeof inspected.modelAdapter !== 'function') {
    throw fail('config', 'modelAdapter must be a function');
  }
  if (!isNonEmptyString(inspected.extractorVersion)) {
    throw fail('config', 'extractorVersion is required');
  }
  if (
    !Number.isInteger(inspected.maxPromptRequestBytesPerCase) ||
    inspected.maxPromptRequestBytesPerCase <= 0 ||
    inspected.maxPromptRequestBytesPerCase > Number.MAX_SAFE_INTEGER
  ) {
    throw fail('config', 'maxPromptRequestBytesPerCase must be a positive safe integer');
  }

  const dataset = inspectDataset(inspected.dataset);
  const validatedCases = [];
  const seenCaseIds = new Set();
  for (const caseData of dataset.cases) {
    let validated;
    try {
      validated = validateCase(caseData);
    } catch {
      throw fail('config', 'case is invalid');
    }
    if (seenCaseIds.has(validated.caseId)) {
      throw fail('config', 'caseId values must be unique');
    }
    seenCaseIds.add(validated.caseId);
    validatedCases.push({ raw: caseData, validated });
  }

  const budgetCaseCount = inspectBudgetCaseCount(inspected.budget);
  if (budgetCaseCount !== dataset.cases.length) {
    throw fail('config', 'budget.caseCount must equal dataset case count');
  }

  const byCase = [];
  let totalBytes = 0;
  let maxBytes = 0;
  for (const entry of validatedCases) {
    let request;
    try {
      request = buildExtractorRequest(entry.validated);
    } catch {
      throw fail('config', 'extractor request is invalid');
    }
    const bytes = requestByteLength(request);
    if (bytes > inspected.maxPromptRequestBytesPerCase) {
      throw fail('config', 'prompt request exceeds maxPromptRequestBytesPerCase');
    }
    totalBytes += bytes;
    if (bytes > maxBytes) maxBytes = bytes;
    byCase.push({ caseId: entry.validated.caseId, bytes });
  }

  let budgetReport;
  try {
    budgetReport = assertBudgetGate(inspected.budget);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('config', 'budget is invalid');
  }

  const runs = [];
  const failures = [];
  for (const entry of validatedCases) {
    try {
      const extraction = await extractCase(entry.raw, inspected.modelAdapter, {
        extractorVersion: inspected.extractorVersion,
      });
      runs.push({
        caseId: entry.validated.caseId,
        extraction,
      });
    } catch (error) {
      if (isOwnError(error)) throw error;
      failures.push({
        caseId: entry.validated.caseId,
        stage: classifyFailureStage(error),
      });
    }
  }

  return {
    extractorVersion: inspected.extractorVersion,
    caseCount: dataset.cases.length,
    attemptedCount: runs.length + failures.length,
    successCount: runs.length,
    failureCount: failures.length,
    budget: budgetReport,
    promptRequestBytes: {
      total: totalBytes,
      max: maxBytes,
      byCase,
    },
    runs,
    failures,
  };
}
