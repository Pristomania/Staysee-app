/**
 * Memory V3 Task 3C — one-case paid connectivity smoke.
 * Fake-fetch unit tests first. Live HTTP only via injected fetchImpl after gates.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateCase } from './contracts.mjs';
import { evaluateCase } from './evaluator.mjs';
import { buildExtractorRequest } from './extractor-prompt.mjs';
import { runOfflineBenchmark } from './benchmark-runner.mjs';
import { assertBudgetGate } from './benchmark-budget.mjs';
import { createOpenRouterAdapter, projectSafeOpenRouterDiagnostic } from './openrouter-adapter.mjs';
import { createOpenRouterFetchTransport, projectSafeFetchDiagnostic } from './openrouter-fetch-transport.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ALLOWED_CASE_ID = 'memv3-ru-counterexample-04';
const ALLOWED_MODEL = 'openai/gpt-5.6-luna';
const ALLOWED_EXTRACTOR_VERSION = 'memory-v3-openrouter-luna-smoke-v1';
const ALLOWED_REASONING = 'none';
const ALLOWED_MAX_OUTPUT_TOKENS = 1200;
const ALLOWED_TIMEOUT_MS = 60000;
const ALLOWED_MAX_RESPONSE_BYTES = 1_000_000;
const ALLOWED_MAX_PROMPT_BYTES = 20000;
const ALLOWED_MAX_BUDGET_USD = 0.0055;
const ALLOWED_BUDGET_FIXED = Object.freeze({
  caseCount: 1,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: 0.22,
  outputUsdPerMillion: 1.32,
  maxRequests: 1,
});

const OWN_ERRORS = new WeakSet();
const OPTION_REQUIRED = Object.freeze([
  'dataset',
  'caseId',
  'apiKey',
  'model',
  'extractorVersion',
  'reasoningEffort',
  'maxOutputTokens',
  'timeoutMs',
  'maxResponseBytes',
  'maxPromptRequestBytesPerCase',
  'budget',
]);
const OPTION_OPTIONAL = Object.freeze(['fetchImpl', 'executeOnePaidRequest']);

function fail(message) {
  const error = new Error(`[memory-v3:live-smoke] ${message}`);
  error.name = 'MemoryV3LiveSmokeError';
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
  if (!isNonEmptyString(copy.datasetId) || !isNonEmptyString(copy.version)) {
    throw fail('dataset identity is invalid');
  }
  copy.cases = inspectDenseArray(copy.cases, 'dataset.cases');
  return copy;
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
  if (inspected.executeOnePaidRequest === undefined) {
    inspected.executeOnePaidRequest = false;
  }
  if (typeof inspected.executeOnePaidRequest !== 'boolean') {
    throw fail('executeOnePaidRequest must be a boolean');
  }
  if (typeof inspected.apiKey !== 'string') {
    throw fail('apiKey must be a string');
  }
  if (inspected.fetchImpl !== undefined && typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  if (inspected.executeOnePaidRequest && typeof inspected.fetchImpl !== 'function') {
    throw fail('fetchImpl is required');
  }
  if (
    !Number.isInteger(inspected.maxOutputTokens) ||
    inspected.maxOutputTokens !== ALLOWED_MAX_OUTPUT_TOKENS
  ) {
    throw fail('maxOutputTokens is not allowed');
  }
  if (!Number.isInteger(inspected.timeoutMs) || inspected.timeoutMs !== ALLOWED_TIMEOUT_MS) {
    throw fail('timeoutMs is not allowed');
  }
  if (
    !Number.isInteger(inspected.maxResponseBytes) ||
    inspected.maxResponseBytes !== ALLOWED_MAX_RESPONSE_BYTES
  ) {
    throw fail('maxResponseBytes is not allowed');
  }
  if (
    !Number.isInteger(inspected.maxPromptRequestBytesPerCase) ||
    inspected.maxPromptRequestBytesPerCase <= 0 ||
    inspected.maxPromptRequestBytesPerCase > ALLOWED_MAX_PROMPT_BYTES
  ) {
    throw fail('maxPromptRequestBytesPerCase is not allowed');
  }
  return inspected;
}

function inspectBudget(budget) {
  const copied = cloneJsonData(budget, 'budget');
  for (const [field, expected] of Object.entries(ALLOWED_BUDGET_FIXED)) {
    if (copied[field] !== expected) {
      throw fail('budget does not match the allowed smoke contract');
    }
  }
  if (typeof copied.maxBudgetUsd !== 'number' || !Number.isFinite(copied.maxBudgetUsd)) {
    throw fail('budget.maxBudgetUsd is invalid');
  }
  if (copied.maxBudgetUsd > ALLOWED_MAX_BUDGET_USD) {
    throw fail('budget.maxBudgetUsd exceeds the allowed ceiling');
  }
  if (copied.maxBudgetUsd < 0) {
    throw fail('budget.maxBudgetUsd is invalid');
  }
  return copied;
}

function selectAllowedCase(dataset, caseId) {
  if (caseId !== ALLOWED_CASE_ID) {
    throw fail('caseId is not allowed');
  }
  const inspected = inspectDataset(dataset);
  const matches = [];
  for (const entry of inspected.cases) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(entry, 'caseId');
    } catch {
      throw fail('case has an invalid shape');
    }
    if (desc && Object.prototype.hasOwnProperty.call(desc, 'value') && desc.value === caseId) {
      matches.push(entry);
    }
  }
  if (matches.length !== 1) {
    throw fail('caseId is invalid');
  }
  let validated;
  try {
    validated = validateCase(matches[0]);
  } catch {
    throw fail('case is invalid');
  }
  return {
    datasetId: inspected.datasetId,
    version: inspected.version,
    raw: matches[0],
    validated,
  };
}

function measurePromptBytes(caseData, maxPromptRequestBytesPerCase) {
  let request;
  try {
    request = buildExtractorRequest(caseData);
  } catch {
    throw fail('extractor request is invalid');
  }
  const bytes = requestByteLength(request);
  if (bytes > maxPromptRequestBytesPerCase) {
    throw fail('prompt request exceeds maxPromptRequestBytesPerCase');
  }
  return {
    total: bytes,
    max: bytes,
    byCase: [{ caseId: caseData.caseId, bytes }],
  };
}

function publicSuccess(fields) {
  return {
    ok: true,
    caseId: fields.caseId,
    model: fields.model,
    extractorVersion: fields.extractorVersion,
    providerHttpCalls: fields.providerHttpCalls,
    configuredBudget: fields.configuredBudget,
    promptRequestBytes: fields.promptRequestBytes,
    successCount: fields.successCount,
    failureCount: fields.failureCount,
    keyPresent: fields.keyPresent,
    evaluation: fields.evaluation ?? null,
    items: fields.items ?? [],
    evidence: fields.evidence ?? [],
  };
}

function publicFailure(fields) {
  return {
    ok: false,
    caseId: ALLOWED_CASE_ID,
    model: ALLOWED_MODEL,
    extractorVersion: ALLOWED_EXTRACTOR_VERSION,
    stage: fields.stage,
    diagnosticCode: fields.diagnosticCode ?? 'unknown_adapter_failure',
    providerHttpCalls: fields.providerHttpCalls,
    configuredBudget: fields.configuredBudget,
    promptRequestBytes: fields.promptRequestBytes,
    successCount: fields.successCount ?? 0,
    failureCount: fields.failureCount ?? 1,
    keyPresent: fields.keyPresent,
    evaluation: null,
    items: [],
    evidence: [],
  };
}

function createDiagnosticRecorder() {
  let code = null;
  return {
    remember(next) {
      if (code === null && typeof next === 'string') {
        code = next;
      }
    },
    value() {
      return code;
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
    try {
      return await modelAdapter(request);
    } catch (error) {
      recorder.remember(projectSafeOpenRouterDiagnostic(error));
      throw error;
    }
  };
}

export function parseOpenRouterApiKeyFromEnvText(text) {
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

export function createOnceOpenRouterFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw fail('fetchImpl must be a function');
  }
  let calls = 0;
  const wrapped = async function onceOpenRouterFetch(url, init) {
    if (url !== OPENROUTER_URL) {
      throw fail('url is not allowed');
    }
    if (init === null || typeof init !== 'object' || init.method !== 'POST') {
      throw fail('method must be POST');
    }
    if (calls >= 1) {
      throw fail('second fetch is not allowed');
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

export async function runOneCaseLiveSmoke(options) {
  const inspected = inspectOptions(options);
  if (inspected.model !== ALLOWED_MODEL) {
    throw fail('model is not allowed');
  }
  if (inspected.extractorVersion !== ALLOWED_EXTRACTOR_VERSION) {
    throw fail('extractorVersion is not allowed');
  }
  if (inspected.reasoningEffort !== ALLOWED_REASONING) {
    throw fail('reasoningEffort is not allowed');
  }

  const selected = selectAllowedCase(inspected.dataset, inspected.caseId);
  const budget = inspectBudget(inspected.budget);
  const promptRequestBytes = measurePromptBytes(
    selected.validated,
    inspected.maxPromptRequestBytesPerCase,
  );

  let configuredBudget;
  try {
    configuredBudget = assertBudgetGate(budget);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('budget is invalid');
  }

  const keyPresent = isNonEmptyString(inspected.apiKey);
  const dry = {
    caseId: selected.validated.caseId,
    model: inspected.model,
    extractorVersion: inspected.extractorVersion,
    providerHttpCalls: 0,
    configuredBudget,
    promptRequestBytes,
    successCount: 0,
    failureCount: 0,
    keyPresent,
  };

  if (!inspected.executeOnePaidRequest) {
    return publicSuccess(dry);
  }
  if (!keyPresent) {
    throw fail('api key is required');
  }

  const countedFetch = createOnceOpenRouterFetch(inspected.fetchImpl);
  const recorder = createDiagnosticRecorder();
  const transport = wrapTrustedTransport(
    createOpenRouterFetchTransport({
      fetchImpl: countedFetch,
      timeoutMs: inspected.timeoutMs,
      maxResponseBytes: inspected.maxResponseBytes,
    }),
    recorder,
  );
  const modelAdapter = wrapTrustedAdapter(
    createOpenRouterAdapter({
      transport,
      apiKey: inspected.apiKey,
      model: inspected.model,
      maxOutputTokens: inspected.maxOutputTokens,
      reasoningEffort: inspected.reasoningEffort,
    }),
    recorder,
  );

  const oneCaseDataset = {
    datasetId: selected.datasetId,
    version: selected.version,
    cases: [selected.raw],
  };

  let report;
  try {
    report = await runOfflineBenchmark({
      dataset: oneCaseDataset,
      modelAdapter,
      budget,
      extractorVersion: inspected.extractorVersion,
      maxPromptRequestBytesPerCase: inspected.maxPromptRequestBytesPerCase,
    });
  } catch (error) {
    if (isOwnError(error)) throw error;
    return publicFailure({
      stage: 'unknown',
      diagnosticCode: recorder.value() ?? 'unknown_adapter_failure',
      providerHttpCalls: countedFetch.callCount,
      configuredBudget,
      promptRequestBytes,
      keyPresent,
    });
  }

  if (report.failureCount > 0 || report.runs.length !== 1) {
    const stage = report.failures[0] ? report.failures[0].stage : 'unknown';
    return publicFailure({
      stage,
      diagnosticCode: recorder.value() ?? 'unknown_adapter_failure',
      providerHttpCalls: countedFetch.callCount,
      configuredBudget,
      promptRequestBytes,
      keyPresent,
      successCount: report.successCount,
      failureCount: report.failureCount,
    });
  }

  const extraction = report.runs[0].extraction;
  let evaluation;
  try {
    evaluation = evaluateCase(selected.raw, extraction);
  } catch {
    return publicFailure({
      stage: 'unknown',
      diagnosticCode: recorder.value() ?? 'unknown_adapter_failure',
      providerHttpCalls: countedFetch.callCount,
      configuredBudget,
      promptRequestBytes,
      keyPresent,
      successCount: 0,
      failureCount: 1,
    });
  }

  return publicSuccess({
    caseId: selected.validated.caseId,
    model: inspected.model,
    extractorVersion: inspected.extractorVersion,
    providerHttpCalls: countedFetch.callCount,
    configuredBudget,
    promptRequestBytes,
    successCount: 1,
    failureCount: 0,
    keyPresent,
    evaluation,
    items: extraction.items,
    evidence: extraction.evidence,
  });
}

function parseArgv(argv) {
  if (!Array.isArray(argv)) {
    throw fail('argv is invalid');
  }
  const parsed = {
    executeOnePaidRequest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') {
      throw fail('argv is invalid');
    }
    if (arg === '--execute-one-paid-request') {
      parsed.executeOnePaidRequest = true;
      continue;
    }
    const value = argv[index + 1];
    if (arg === '--case-id') {
      parsed.caseId = value;
      index += 1;
      continue;
    }
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
    throw fail('unknown argument');
  }
  if (parsed.caseId !== ALLOWED_CASE_ID) {
    throw fail('caseId is not allowed');
  }
  if (parsed.model !== ALLOWED_MODEL) {
    throw fail('model is not allowed');
  }
  if (parsed.maxBudgetUsd !== '0.0055') {
    throw fail('max-budget-usd is not allowed');
  }
  return parsed;
}

function readApiKey(parsed, io) {
  const env = io.env && typeof io.env === 'object' ? io.env : {};
  const fromProcess = env.OPENROUTER_API_KEY;
  if (typeof fromProcess === 'string' && fromProcess.trim().length > 0) {
    return fromProcess;
  }
  if (parsed.envFile !== undefined) {
    if (typeof parsed.envFile !== 'string' || parsed.envFile.trim().length === 0) {
      throw fail('env file path is invalid');
    }
    if (typeof io.readFileSync !== 'function') {
      throw fail('env file reader is required');
    }
    let text;
    try {
      text = io.readFileSync(parsed.envFile, 'utf8');
    } catch {
      throw fail('env file cannot be read');
    }
    const parsedKey = parseOpenRouterApiKeyFromEnvText(text);
    return typeof parsedKey === 'string' ? parsedKey : '';
  }
  return '';
}

export async function runLiveSmokeFromArgv(argv, io = {}) {
  const parsed = parseArgv(argv);
  const apiKey = readApiKey(parsed, io);
  const dataset = io.dataset;
  if (dataset === undefined) {
    throw fail('dataset is required');
  }
  const shared = {
    dataset,
    caseId: parsed.caseId,
    apiKey,
    model: parsed.model,
    extractorVersion: ALLOWED_EXTRACTOR_VERSION,
    reasoningEffort: ALLOWED_REASONING,
    maxOutputTokens: ALLOWED_MAX_OUTPUT_TOKENS,
    timeoutMs: ALLOWED_TIMEOUT_MS,
    maxResponseBytes: ALLOWED_MAX_RESPONSE_BYTES,
    maxPromptRequestBytesPerCase: ALLOWED_MAX_PROMPT_BYTES,
    budget: {
      ...ALLOWED_BUDGET_FIXED,
      maxBudgetUsd: ALLOWED_MAX_BUDGET_USD,
    },
  };
  const dry = await runOneCaseLiveSmoke({
    ...shared,
    executeOnePaidRequest: false,
  });
  if (!parsed.executeOnePaidRequest) {
    return dry;
  }
  if (typeof io.fetchImpl !== 'function') {
    throw fail('fetchImpl is required');
  }
  return runOneCaseLiveSmoke({
    ...shared,
    fetchImpl: io.fetchImpl,
    executeOnePaidRequest: true,
  });
}

function loadGoldenDataset() {
  return JSON.parse(readFileSync(new URL('./memory-v3-ru-golden.v1.json', import.meta.url)));
}

function isCliEntry() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

function safeCliOutput(result) {
  if (result && result.ok === false) {
    return {
      ok: false,
      stage: result.stage,
      diagnosticCode: result.diagnosticCode,
      providerHttpCalls: result.providerHttpCalls,
      configuredBudget: result.configuredBudget,
    };
  }
  return {
    caseId: result.caseId,
    model: result.model,
    extractorVersion: result.extractorVersion,
    providerHttpCalls: result.providerHttpCalls,
    configuredBudget: result.configuredBudget,
    promptRequestBytes: result.promptRequestBytes,
    successCount: result.successCount,
    failureCount: result.failureCount,
    evaluation: result.evaluation,
    items: result.items,
    evidence: result.evidence,
    keyPresent: result.keyPresent,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const parsed = parseArgv(argv);
    const io = {
      env: process.env,
      readFileSync,
      dataset: loadGoldenDataset(),
    };
    if (parsed.executeOnePaidRequest) {
      const dry = await runLiveSmokeFromArgv(
        argv.filter((arg) => arg !== '--execute-one-paid-request'),
        io,
      );
      if (dry.providerHttpCalls !== 0 || dry.configuredBudget.gate !== 'PASS' || !dry.keyPresent) {
        throw fail('dry-run gate failed');
      }
      io.fetchImpl = globalThis.fetch.bind(globalThis);
    }
    const result = await runLiveSmokeFromArgv(argv, io);
    process.stdout.write(`${JSON.stringify(safeCliOutput(result), null, 2)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    const message = isOwnError(error) ? error.message : '[memory-v3:live-smoke] smoke failed';
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        stage: 'config',
        providerHttpCalls: 0,
        configuredBudget: null,
        error: message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (isCliEntry()) {
  await main();
}
