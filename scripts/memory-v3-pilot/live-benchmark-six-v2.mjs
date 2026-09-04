/**
 * Memory V3 V2 six-case live-benchmark compatibility wrapper.
 * Injects profileId six-category-v2. No fs, env, global fetch, retry, or CLI.
 *
 * Dataset selection, budget math, HTTP bounding, runOfflineBenchmarkV2,
 * evaluateCaseV2, evaluateDatasetV2, validateCaseV2, and buildExtractorRequestV2
 * live in live-benchmark-engine-v2.mjs. This file must not reimplement them.
 */

import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';
import {
  buildProfileSemanticReviewPacketV2,
  createProfileBoundedOpenRouterFetch,
  runProfileLiveBenchmarkV2,
} from './live-benchmark-engine-v2.mjs';

const CANONICAL = getLiveBenchmarkProfileV2('six-category-v2');
const OPTION_REQUIRED = Object.freeze([
  'dataset',
  'model',
  'extractorVersion',
  'budget',
  'maxPromptRequestBytesPerCase',
  'execute',
]);
const OPTION_OPTIONAL = Object.freeze(['apiKey', 'fetchImpl']);
const PACKET_REQUIRED = Object.freeze(['dataset', 'benchmarkResult']);

export const SIX_CASE_BENCHMARK_V2_CASE_IDS = CANONICAL.caseIds;

export const SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION =
  'memory-v3-openrouter-gemini-3.7-flash-six-v2-hypothesis-admission-r1';

function fail(message) {
  const error = new Error(`[memory-v3:live-benchmark-six-v2] ${message}`);
  error.name = 'MemoryV3SixCaseBenchmarkV2Error';
  return error;
}

function guardedIsArray(value, message) {
  try {
    return Array.isArray(value);
  } catch {
    throw fail(message);
  }
}

function guardedOwnKeys(value, message) {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(message);
  }
}

function guardedGetPrototypeOf(value, message) {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw fail(message);
  }
}

function guardedGetOwnPropertyDescriptor(value, key, message) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(message);
  }
}

function defineOwnData(target, key, value) {
  Object.defineProperty(target, key, {
    enumerable: true,
    writable: true,
    configurable: true,
    value,
  });
}

function inspectPlainObject(value, path) {
  if (value === null || typeof value !== 'object' || guardedIsArray(value, `${path} must be a plain object`)) {
    throw fail(`${path} must be a plain object`);
  }
  const proto = guardedGetPrototypeOf(value, `${path} must be a plain object`);
  if (proto !== Object.prototype && proto !== null) {
    throw fail(`${path} must be a plain object`);
  }
  return guardedOwnKeys(value, `${path} has an invalid shape`);
}

function dataDescriptor(value, key, path) {
  const desc = guardedGetOwnPropertyDescriptor(value, key, `${path} has an invalid shape`);
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
  const copy = Object.create(null);
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      throw fail(`${path} has an unknown field`);
    }
    const desc = dataDescriptor(value, key, path);
    if (desc.value === undefined) {
      throw fail(`${path} is missing a required field`);
    }
    defineOwnData(copy, key, desc.value);
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

export function createAtMostSixOpenRouterFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  return createProfileBoundedOpenRouterFetch(fetchImpl, 'six-category-v2');
}

export async function runSixCaseLiveBenchmarkV2(options) {
  const inspected = inspectRecordPartial(options, OPTION_REQUIRED, OPTION_OPTIONAL, 'options');
  return runProfileLiveBenchmarkV2({
    ...inspected,
    profileId: 'six-category-v2',
  });
}

export function buildSixCaseSemanticReviewPacketV2(options) {
  const inspected = inspectRecordPartial(options, PACKET_REQUIRED, [], 'options');
  return buildProfileSemanticReviewPacketV2({
    profileId: 'six-category-v2',
    dataset: inspected.dataset,
    benchmarkResult: inspected.benchmarkResult,
  });
}
