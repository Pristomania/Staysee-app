/**
 * Memory V3 V2 shared profile-driven live-benchmark CLI.
 * Injected dataset, fetchImpl, and readEnvText only. No fs, env object, or global fetch.
 */

import { getLiveBenchmarkProfileV2 } from './live-benchmark-profiles-v2.mjs';
import { runProfileLiveBenchmarkV2 } from './live-benchmark-engine-v2.mjs';

const OWN_ERRORS = new WeakSet();
const GENERIC_PREFIX = '[memory-v3:live-benchmark-cli-v2]';
const GENERIC_NAME = 'MemoryV3ProfileLiveBenchmarkCliV2Error';
const OPTION_REQUIRED = Object.freeze(['argv', 'dataset', 'profileId']);
const OPTION_OPTIONAL = Object.freeze(['fetchImpl', 'readEnvText']);
const STATIC_ALLOWED_FLAGS = Object.freeze(['--model', '--max-budget-usd', '--env-file']);

function fail(message, canonical) {
  const prefix = canonical?.cliErrorPrefix ?? GENERIC_PREFIX;
  const error = new Error(`${prefix} ${message}`);
  error.name = canonical?.cliErrorName ?? GENERIC_NAME;
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

function inspectPlainObject(value, path, canonical) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    throw fail(`${path} must be a plain object`, canonical);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    guardedIsArray(value, canonical, `${path} must be a plain object`)
  ) {
    throw fail(`${path} must be a plain object`, canonical);
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail(`${path} must be a plain object`, canonical);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} has an invalid shape`, canonical);
  }
}

function dataDescriptor(value, key, path, canonical) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw fail(`${path} has an invalid shape`, canonical);
  }
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
    copy[key] = desc.value;
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
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail(`${path} must be a dense array`, canonical);
  }
  const descriptors = new Map();
  for (const key of keys) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw fail(`${path} has an invalid field`, canonical);
    }
    descriptors.set(key, desc);
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

function readOwnEnumerablePrimitiveString(value, key, path, canonical) {
  const desc = dataDescriptor(value, key, path, canonical);
  if (typeof desc.value !== 'string' || desc.value.length === 0 || desc.value.trim() !== desc.value) {
    throw fail(`${path} has an invalid field`, canonical);
  }
  return desc.value;
}

function resolveCanonicalProfileId(profileId) {
  try {
    return getLiveBenchmarkProfileV2(profileId);
  } catch {
    throw fail('profileId is not allowed');
  }
}

function buildBudget(canonical) {
  return {
    caseCount: canonical.caseCount,
    maxInputTokensPerCase: canonical.maxInputTokensPerCase,
    maxOutputTokensPerCase: canonical.maxOutputTokensPerCase,
    inputUsdPerMillion: canonical.inputUsdPerMillion,
    outputUsdPerMillion: canonical.outputUsdPerMillion,
    maxRequests: canonical.maxRequests,
    maxBudgetUsd: canonical.maxBudgetUsd,
  };
}

function parseOpenRouterApiKeyFromEnvText(text, canonical) {
  if (typeof text !== 'string') {
    throw fail('env text is invalid', canonical);
  }
  const lines = text.split(/\r?\n/);
  let found;
  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      throw fail('env file has a malformed line', canonical);
    }
    const name = match[1];
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (name === 'OPENROUTER_API_KEY') {
      if (found !== undefined) {
        throw fail('OPENROUTER_API_KEY is duplicated', canonical);
      }
      found = value;
    }
  }
  return found;
}

function parseArgv(argv, canonical) {
  const entries = inspectDenseArray(argv, 'argv', canonical);
  const parsed = {
    execute: false,
  };
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const arg = entries[index];
    if (typeof arg !== 'string') {
      throw fail('argv is invalid', canonical);
    }
    if (arg === '--api-key' || arg.startsWith('OPENROUTER_API_KEY')) {
      throw fail('api key must not be passed via argv', canonical);
    }
    if (arg === '--profile') {
      throw fail('unknown argument', canonical);
    }
    if (arg === canonical.executeFlag) {
      if (seen.has(arg)) throw fail('argument is duplicated', canonical);
      seen.add(arg);
      parsed.execute = true;
      continue;
    }
    if (!STATIC_ALLOWED_FLAGS.includes(arg)) {
      throw fail('unknown argument', canonical);
    }
    if (seen.has(arg)) {
      throw fail('argument is duplicated', canonical);
    }
    seen.add(arg);
    const value = entries[index + 1];
    if (arg === '--model') {
      parsed.model = value;
      index += 1;
      continue;
    }
    if (arg === '--max-budget-usd') {
      parsed.maxBudgetUsd = value;
      index += 1;
      continue;
    }
    if (arg === '--env-file') {
      parsed.envFile = value;
      index += 1;
      continue;
    }
  }
  if (parsed.model !== canonical.model) {
    throw fail('model is not allowed', canonical);
  }
  if (parsed.maxBudgetUsd !== canonical.maxBudgetUsdArg) {
    throw fail('max-budget-usd is not allowed', canonical);
  }
  if (parsed.execute && !isNonEmptyString(parsed.envFile)) {
    throw fail('env-file is required', canonical);
  }
  if (parsed.envFile !== undefined && !isNonEmptyString(parsed.envFile)) {
    throw fail('env file path is invalid', canonical);
  }
  return parsed;
}

export async function runProfileBenchmarkFromArgvV2(options) {
  if (options === null || typeof options !== 'object' || guardedIsArray(options, undefined, 'options must be a plain object')) {
    throw fail('options must be a plain object');
  }
  inspectPlainObject(options, 'options');
  const profileId = readOwnEnumerablePrimitiveString(options, 'profileId', 'options', undefined);
  const canonical = resolveCanonicalProfileId(profileId);
  const inspected = inspectRecordPartial(
    options,
    OPTION_REQUIRED,
    OPTION_OPTIONAL,
    'options',
    canonical,
  );
  const parsed = parseArgv(inspected.argv, canonical);
  const shared = {
    dataset: inspected.dataset,
    profileId: canonical.profileId,
    model: canonical.model,
    extractorVersion: canonical.extractorVersion,
    budget: buildBudget(canonical),
    maxPromptRequestBytesPerCase: canonical.maxPromptRequestBytesPerCase,
  };

  if (!parsed.execute) {
    try {
      return await runProfileLiveBenchmarkV2({
        ...shared,
        execute: false,
      });
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw fail('dry-run failed', canonical);
    }
  }

  if (typeof inspected.readEnvText !== 'function') {
    throw fail('readEnvText is required', canonical);
  }
  if (typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl is required', canonical);
  }

  let envText;
  try {
    envText = await inspected.readEnvText(parsed.envFile);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('env file cannot be read', canonical);
  }
  const apiKey = parseOpenRouterApiKeyFromEnvText(envText, canonical);
  if (!isNonEmptyString(apiKey)) {
    throw fail('api key is required', canonical);
  }

  try {
    return await runProfileLiveBenchmarkV2({
      ...shared,
      apiKey,
      fetchImpl: inspected.fetchImpl,
      execute: true,
    });
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('benchmark failed', canonical);
  }
}
