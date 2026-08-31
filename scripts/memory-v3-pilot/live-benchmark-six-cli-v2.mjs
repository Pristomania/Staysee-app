/**
 * Memory V3 V2 six-case live-benchmark CLI boundary.
 * Injected dataset, fetchImpl, and readEnvText. No filesystem, environment object, or global fetch.
 */

import {
  SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION,
  runSixCaseLiveBenchmarkV2,
} from './live-benchmark-six-v2.mjs';

const ALLOWED_MODEL = 'openai/gpt-5.6-luna';
const ALLOWED_MAX_BUDGET_USD = '0.032';
const ALLOWED_MAX_PROMPT_BYTES = 20000;
const ALLOWED_BUDGET = Object.freeze({
  caseCount: 6,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.22,
  outputUsdPerMillion: 1.32,
  maxRequests: 6,
  maxBudgetUsd: 0.032,
});

const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze(['argv', 'dataset']);
const OPTION_OPTIONAL = Object.freeze(['fetchImpl', 'readEnvText']);
const ALLOWED_FLAGS = Object.freeze([
  '--model',
  '--max-budget-usd',
  '--env-file',
  '--execute-six-paid-requests',
]);

function fail(message) {
  const error = new Error(`[memory-v3:live-benchmark-six-cli-v2] ${message}`);
  error.name = 'MemoryV3SixCaseBenchmarkCliV2Error';
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

function parseOpenRouterApiKeyFromEnvText(text) {
  if (typeof text !== 'string') {
    throw fail('env text is invalid');
  }
  const lines = text.split(/\r?\n/);
  let found;
  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      throw fail('env file has a malformed line');
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
        throw fail('OPENROUTER_API_KEY is duplicated');
      }
      found = value;
    }
  }
  return found;
}

function parseArgv(argv) {
  const entries = inspectDenseArray(argv, 'argv');
  const parsed = {
    execute: false,
  };
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const arg = entries[index];
    if (typeof arg !== 'string') {
      throw fail('argv is invalid');
    }
    if (arg === '--api-key' || arg.startsWith('OPENROUTER_API_KEY')) {
      throw fail('api key must not be passed via argv');
    }
    if (arg === '--execute-six-paid-requests') {
      if (seen.has(arg)) throw fail('argument is duplicated');
      seen.add(arg);
      parsed.execute = true;
      continue;
    }
    if (!ALLOWED_FLAGS.includes(arg)) {
      throw fail('unknown argument');
    }
    if (seen.has(arg)) {
      throw fail('argument is duplicated');
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
  if (parsed.model !== ALLOWED_MODEL) {
    throw fail('model is not allowed');
  }
  if (parsed.maxBudgetUsd !== ALLOWED_MAX_BUDGET_USD) {
    throw fail('max-budget-usd is not allowed');
  }
  if (parsed.execute && !isNonEmptyString(parsed.envFile)) {
    throw fail('env-file is required');
  }
  if (parsed.envFile !== undefined && !isNonEmptyString(parsed.envFile)) {
    throw fail('env file path is invalid');
  }
  return parsed;
}

export async function runSixCaseBenchmarkFromArgvV2(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw fail('options must be a plain object');
  }
  const inspected = inspectRecordPartial(options, OPTION_REQUIRED, OPTION_OPTIONAL, 'options');
  const parsed = parseArgv(inspected.argv);
  const shared = {
    dataset: inspected.dataset,
    model: ALLOWED_MODEL,
    extractorVersion: SIX_CASE_BENCHMARK_V2_EXTRACTOR_VERSION,
    budget: { ...ALLOWED_BUDGET },
    maxPromptRequestBytesPerCase: ALLOWED_MAX_PROMPT_BYTES,
  };

  if (!parsed.execute) {
    try {
      return await runSixCaseLiveBenchmarkV2({
        ...shared,
        execute: false,
      });
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw fail('dry-run failed');
    }
  }

  if (typeof inspected.readEnvText !== 'function') {
    throw fail('readEnvText is required');
  }
  if (typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl is required');
  }

  let envText;
  try {
    envText = await inspected.readEnvText(parsed.envFile);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('env file cannot be read');
  }
  const apiKey = parseOpenRouterApiKeyFromEnvText(envText);
  if (!isNonEmptyString(apiKey)) {
    throw fail('api key is required');
  }

  try {
    return await runSixCaseLiveBenchmarkV2({
      ...shared,
      apiKey,
      fetchImpl: inspected.fetchImpl,
      execute: true,
    });
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('benchmark failed');
  }
}
