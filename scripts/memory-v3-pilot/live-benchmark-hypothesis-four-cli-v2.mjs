/**
 * Memory V3 V2 hypothesis-four live-benchmark CLI compatibility wrapper.
 * Injects profileId hypothesis-four-v2. No fs, env object, or global fetch.
 */

import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';
import { runProfileBenchmarkFromArgvV2 } from './live-benchmark-cli-v2.mjs';

const CANONICAL = getLiveBenchmarkProfileV2('hypothesis-four-v2');
const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze(['argv', 'dataset']);
const OPTION_OPTIONAL = Object.freeze(['fetchImpl', 'readEnvText']);

function fail(message) {
  const error = new Error(`${CANONICAL.cliErrorPrefix} ${message}`);
  error.name = CANONICAL.cliErrorName;
  OWN_ERRORS.add(error);
  return error;
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
  const copy = Object.create(null);
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

export async function runHypothesisFourBenchmarkFromArgvV2(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('options must be a plain object');
  }
  const inspected = inspectRecordPartial(options, OPTION_REQUIRED, OPTION_OPTIONAL, 'options');
  const delegated = {
    argv: inspected.argv,
    dataset: inspected.dataset,
    profileId: CANONICAL.profileId,
  };
  if (Object.prototype.hasOwnProperty.call(inspected, 'fetchImpl')) {
    delegated.fetchImpl = inspected.fetchImpl;
  }
  if (Object.prototype.hasOwnProperty.call(inspected, 'readEnvText')) {
    delegated.readEnvText = inspected.readEnvText;
  }
  return runProfileBenchmarkFromArgvV2(delegated);
}
