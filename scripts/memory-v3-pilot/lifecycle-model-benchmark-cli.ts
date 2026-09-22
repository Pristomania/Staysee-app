/** Strict injected-I/O CLI boundary for the synthetic lifecycle model benchmark. */

import {
  buildLifecycleModelReviewPacket,
  runLifecycleModelBenchmark,
  type LifecycleModelBenchmarkResult,
  type LifecycleModelReviewPacket,
} from './lifecycle-model-benchmark.ts';
import {
  getLifecycleModelBenchmarkProfile,
  type LifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';
import { createMemoryV3LifecycleOpenRouterAdapter } from
  '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts';

type JsonRecord = Record<string, unknown>;

const PREFIX = '[memory-v3:lifecycle-model-benchmark-cli]';
const OPTION_FIELDS = ['argv', 'dataset', 'fetchImpl', 'readEnvText'] as const;
const DRY_FLAGS = ['--profile', '--model', '--max-budget-usd'] as const;
const OWN_ERRORS = new WeakSet<object>();

function fail(message: string): never {
  const error = new Error(`${PREFIX} ${message}`);
  error.name = 'MemoryV3LifecycleModelBenchmarkCliError';
  OWN_ERRORS.add(error);
  throw error;
}

function isOwnError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && OWN_ERRORS.has(error);
}

function safePrototype(value: object, message: string): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return fail(message);
  }
}

function safeKeys(value: object, message: string): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return fail(message);
  }
}

function safeDescriptor(value: object, key: PropertyKey, message: string): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return fail(message);
    return descriptor;
  } catch {
    return fail(message);
  }
}

function dataValue(value: object, key: PropertyKey, enumerable: boolean, message: string): unknown {
  const descriptor = safeDescriptor(value, key, message);
  if (!('value' in descriptor) || descriptor.enumerable !== enumerable) return fail(message);
  return descriptor.value;
}

function inspectOptions(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null) return fail('options are invalid');
  const prototype = safePrototype(value, 'options are invalid');
  if (prototype !== Object.prototype && prototype !== null) return fail('options are invalid');
  const keys = safeKeys(value, 'options are invalid');
  if (keys.length !== OPTION_FIELDS.length || keys.some((key) =>
    typeof key !== 'string' || !OPTION_FIELDS.includes(key as typeof OPTION_FIELDS[number]))) {
    return fail('options are invalid');
  }
  const projected: JsonRecord = {};
  for (const field of OPTION_FIELDS) {
    projected[field] = dataValue(value, field, true, 'options are invalid');
  }
  return projected;
}

function inspectArgv(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return fail('argv is invalid');
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return fail('argv is invalid');
  }
  if (!isArray || safePrototype(value, 'argv is invalid') !== Array.prototype) {
    return fail('argv is invalid');
  }
  const lengthValue = dataValue(value, 'length', false, 'argv is invalid');
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) {
    return fail('argv is invalid');
  }
  const length = lengthValue as number;
  const keys = safeKeys(value, 'argv is invalid');
  if (keys.length !== length + 1 || keys.some((key) => {
    if (key === 'length') return false;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || index >= length;
  })) return fail('argv is invalid');
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = dataValue(value, String(index), true, 'argv is invalid');
    if (typeof item !== 'string') return fail('argv is invalid');
    result.push(item);
  }
  return result;
}

function exactBudget(profile: LifecycleModelBenchmarkProfile): Record<string, unknown> {
  return {
    caseCount: profile.caseCount,
    maxInputTokensPerCase: profile.maxInputTokensPerCase,
    maxOutputTokensPerCase: profile.maxOutputTokensPerCase,
    inputUsdPerMillion: profile.inputUsdPerMillion,
    outputUsdPerMillion: profile.outputUsdPerMillion,
    maxRequests: profile.maxRequests,
    maxBudgetUsd: profile.maxBudgetUsd,
  };
}

function parseArgv(argvValue: unknown): {
  profile: LifecycleModelBenchmarkProfile;
  execute: boolean;
  envFile?: string;
} {
  const argv = inspectArgv(argvValue);
  const dryLength = DRY_FLAGS.length * 2;
  const executeLength = dryLength + 3;
  if (argv.length !== dryLength && argv.length !== executeLength) return fail('arguments are invalid');

  for (let index = 0; index < DRY_FLAGS.length; index += 1) {
    if (argv[index * 2] !== DRY_FLAGS[index]) return fail('arguments are invalid');
  }
  let profile: LifecycleModelBenchmarkProfile;
  try {
    profile = getLifecycleModelBenchmarkProfile(argv[1]);
  } catch {
    return fail('arguments are invalid');
  }
  if (argv[3] !== profile.model || argv[5] !== String(profile.maxBudgetUsd)) {
    return fail('arguments are invalid');
  }
  if (argv.length === dryLength) return { profile, execute: false };
  const envFile = argv[7];
  if (argv[6] !== '--env-file' || typeof envFile !== 'string' ||
    envFile.trim().length === 0 || envFile.trim() !== envFile ||
    argv[8] !== profile.executeFlag) {
    return fail('arguments are invalid');
  }
  return { profile, execute: true, envFile };
}

function parseApiKey(text: unknown): string {
  if (typeof text !== 'string') return fail('env file is invalid');
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return fail('env file is invalid');
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (match[1] === 'OPENROUTER_API_KEY') {
      if (found !== undefined) return fail('env file is invalid');
      found = value;
    }
  }
  if (found === undefined || found.trim().length === 0 || found.trim() !== found) {
    return fail('env file is invalid');
  }
  return found;
}

async function dryRun(
  profile: LifecycleModelBenchmarkProfile,
  dataset: unknown,
): Promise<LifecycleModelBenchmarkResult> {
  try {
    return await runLifecycleModelBenchmark({
      profileId: profile.profileId,
      dataset,
      model: profile.model,
      budget: exactBudget(profile),
      execute: false,
    });
  } catch {
    return fail('offline preflight failed');
  }
}

export async function runLifecycleModelBenchmarkFromArgv(options: {
  argv: unknown;
  dataset: unknown;
  fetchImpl: typeof fetch;
  readEnvText: (path: string) => Promise<string>;
}): Promise<{
  benchmarkResult: LifecycleModelBenchmarkResult;
  semanticReviewPacket: LifecycleModelReviewPacket | null;
}> {
  const root = inspectOptions(options);
  const parsed = parseArgv(root.argv);
  const offlineResult = await dryRun(parsed.profile, root.dataset);
  if (!parsed.execute) {
    return { benchmarkResult: offlineResult, semanticReviewPacket: null };
  }

  if (typeof root.readEnvText !== 'function' || typeof root.fetchImpl !== 'function') {
    return fail('execute dependencies are invalid');
  }
  let envText: unknown;
  try {
    envText = await (root.readEnvText as (path: string) => Promise<string>)(parsed.envFile!);
  } catch {
    return fail('env file cannot be read');
  }
  const apiKey = parseApiKey(envText);
  let adapter;
  try {
    adapter = createMemoryV3LifecycleOpenRouterAdapter({
      apiKey,
      fetchImpl: root.fetchImpl as typeof fetch,
    });
  } catch {
    return fail('execute dependencies are invalid');
  }

  let benchmarkResult: LifecycleModelBenchmarkResult;
  try {
    benchmarkResult = await runLifecycleModelBenchmark({
      profileId: parsed.profile.profileId,
      dataset: root.dataset,
      model: parsed.profile.model,
      budget: exactBudget(parsed.profile),
      execute: true,
      adapter,
    });
  } catch (error) {
    if (isOwnError(error)) throw error;
    return fail('benchmark execution failed');
  }
  let semanticReviewPacket: LifecycleModelReviewPacket;
  try {
    semanticReviewPacket = buildLifecycleModelReviewPacket({
      profileId: parsed.profile.profileId,
      dataset: root.dataset,
      benchmarkResult,
    });
  } catch {
    return fail('review packet failed');
  }
  return { benchmarkResult, semanticReviewPacket };
}
