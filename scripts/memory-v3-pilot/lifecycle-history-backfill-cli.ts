/** Strict injected-I/O CLI boundary for the Memory V3 historical backfill. */

import { extname, isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';

import {
  buildLifecycleHistoryReviewPacket,
  runLifecycleHistoryBackfill,
  type LifecycleHistoryBackfillResult,
} from './lifecycle-history-backfill-engine.ts';
import {
  getLifecycleHistoryBackfillProfile,
  validateLifecycleHistoryPriceSnapshot,
  type LifecycleHistoryPriceSnapshot,
} from './lifecycle-history-backfill-profile.ts';
import {
  inspectLifecycleHistorySource,
  type LifecycleHistorySourceReader,
} from './lifecycle-history-backfill-source.ts';
import { createMemoryV3OpenRouterAdapter } from
  '../../supabase/functions/_shared/memoryV3/transport.ts';
import { createMemoryV3LifecycleOpenRouterAdapter } from
  '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts';

type JsonRecord = Record<string, unknown>;
type SourceReaderFactory = (
  url: string,
  serviceKey: string,
) => LifecycleHistorySourceReader;

const PREFIX = '[memory-v3:lifecycle-history-backfill-cli]';
const ERROR_NAME = 'MemoryV3LifecycleHistoryBackfillCliError';
const OPTIONS_FIELDS = ['argv', 'sourceReader', 'readEnvText', 'fetchImpl', 'nowMs'] as const;
const SOURCE_READER_FIELDS = ['listConversationsPage', 'listMessagesPage'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OWN_ERRORS = new WeakSet<object>();

function fail(): never {
  const error = new Error(`${PREFIX} command failed`);
  error.name = ERROR_NAME;
  OWN_ERRORS.add(error);
  throw error;
}

function isOwnError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && OWN_ERRORS.has(error);
}

async function boundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isOwnError(error)) throw error;
    return fail();
  }
}

function safePrototype(value: object): object | null {
  try {
    if (isProxy(value)) return fail();
    return Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
}

function safeKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return fail();
  }
}

function dataValue(
  value: object,
  key: PropertyKey,
  enumerable: boolean,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return fail();
  }
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== enumerable) {
    return fail();
  }
  return descriptor.value;
}

function inspectOptions(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || safePrototype(value) !== Object.prototype) {
    return fail();
  }
  const keys = safeKeys(value);
  if (
    keys.length !== OPTIONS_FIELDS.length ||
    keys.some((key) => typeof key !== 'string' ||
      !OPTIONS_FIELDS.includes(key as typeof OPTIONS_FIELDS[number]))
  ) {
    return fail();
  }
  const projected: JsonRecord = Object.create(null);
  for (const field of OPTIONS_FIELDS) {
    projected[field] = dataValue(value, field, true);
  }
  return projected;
}

function inspectArgv(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return fail();
  let array = false;
  try {
    if (isProxy(value)) return fail();
    array = Array.isArray(value);
  } catch {
    return fail();
  }
  if (!array || safePrototype(value) !== Array.prototype) return fail();
  const lengthValue = dataValue(value, 'length', false);
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) return fail();
  const length = lengthValue as number;
  const keys = safeKeys(value);
  if (keys.length !== length + 1) return fail();
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = dataValue(value, String(index), true);
    if (typeof entry !== 'string') return fail();
    output.push(entry);
  }
  if (keys.some((key) => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length;
  })) return fail();
  return output;
}

function isAbsoluteJsonPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    isAbsolute(value) && extname(value).toLowerCase() === '.json';
}

function parseArgv(value: unknown): {
  mode: 'inspect' | 'execute';
  profileId: string;
  sourceCutoff: string;
  expectedSourceSha256: string | null;
  priceSnapshotFile: string;
  maxBudgetUsd: string;
  safeOutputFile: string | null;
} {
  const argv = inspectArgv(value);
  const inspect = argv[0] === '--inspect-source';
  const execute = argv[0] === '--execute-history-backfill-paid-requests';
  if ((!inspect && !execute) || argv.length !== (inspect ? 9 : 13)) return fail();
  const expectedFlags = inspect
    ? [[1, '--profile'], [3, '--source-cutoff'], [5, '--price-snapshot-file'], [7, '--max-budget-usd']] as const
    : [[1, '--profile'], [3, '--source-cutoff'], [5, '--expected-source-sha256'],
        [7, '--price-snapshot-file'], [9, '--max-budget-usd'], [11, '--safe-output-file']] as const;
  for (const [index, expected] of expectedFlags) {
    if (argv[index] !== expected) return fail();
  }
  let profile;
  try {
    profile = getLifecycleHistoryBackfillProfile(argv[2]);
  } catch {
    return fail();
  }
  const sourceCutoff = argv[4];
  if (typeof sourceCutoff !== 'string' || sourceCutoff.trim() !== sourceCutoff) return fail();
  if (inspect) {
    if (!isAbsoluteJsonPath(argv[6]) || typeof argv[8] !== 'string') return fail();
    return {
      mode: 'inspect',
      profileId: profile.profileId,
      sourceCutoff,
      expectedSourceSha256: null,
      priceSnapshotFile: argv[6],
      maxBudgetUsd: argv[8],
      safeOutputFile: null,
    };
  }
  if (!SHA256.test(argv[6]) || !isAbsoluteJsonPath(argv[8]) ||
    typeof argv[10] !== 'string' || !isAbsoluteJsonPath(argv[12])) return fail();
  return {
    mode: 'execute',
    profileId: profile.profileId,
    sourceCutoff,
    expectedSourceSha256: argv[6],
    priceSnapshotFile: argv[8],
    maxBudgetUsd: argv[10],
    safeOutputFile: argv[12],
  };
}

async function readText(reader: unknown, selector: string): Promise<string> {
  if (typeof reader !== 'function' || isProxy(reader)) return fail();
  let value: unknown;
  try {
    value = await (reader as (path: string) => Promise<string>)(selector);
  } catch {
    return fail();
  }
  if (typeof value !== 'string') return fail();
  return value;
}

function nonEmpty(value: string): string {
  if (value.length === 0 || value.trim() !== value) return fail();
  return value;
}

function httpsUrl(value: string): string {
  nonEmpty(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    return fail();
  }
  return value;
}

function parsePriceSnapshot(text: string, nowMs: number): LifecycleHistoryPriceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  try {
    return validateLifecycleHistoryPriceSnapshot(parsed, nowMs);
  } catch {
    return fail();
  }
}

function resolveSourceReader(
  candidate: unknown,
  url: string,
  serviceKey: string,
): LifecycleHistorySourceReader {
  if (typeof candidate === 'function') {
    if (isProxy(candidate)) return fail();
    try {
      return (candidate as SourceReaderFactory)(url, serviceKey);
    } catch {
      return fail();
    }
  }
  return candidate as LifecycleHistorySourceReader;
}

function preflightSourceReader(candidate: unknown): void {
  if (typeof candidate === 'function') {
    if (isProxy(candidate)) return fail();
    return;
  }
  if (typeof candidate !== 'object' || candidate === null || isProxy(candidate)) return fail();
  let array: boolean;
  try {
    array = Array.isArray(candidate);
  } catch {
    return fail();
  }
  const prototype = safePrototype(candidate);
  if (array || (prototype !== Object.prototype && prototype !== null)) return fail();
  const keys = safeKeys(candidate);
  if (keys.length !== SOURCE_READER_FIELDS.length || keys.some((key) =>
    typeof key !== 'string' ||
    !SOURCE_READER_FIELDS.includes(key as typeof SOURCE_READER_FIELDS[number]))) return fail();
  for (const field of SOURCE_READER_FIELDS) {
    const method = dataValue(candidate, field, true);
    if (typeof method !== 'function' || isProxy(method)) return fail();
  }
}

export async function runLifecycleHistoryBackfillFromArgv(input: {
  argv: unknown;
  sourceReader: unknown;
  readEnvText: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
  nowMs: number;
}): Promise<{
  benchmarkResult: LifecycleHistoryBackfillResult;
  semanticReviewPacket: ReturnType<typeof buildLifecycleHistoryReviewPacket> | null;
}> {
  return boundary(async () => {
    const root = inspectOptions(input);
    const parsed = parseArgv(root.argv);
    if (!Number.isSafeInteger(root.nowMs)) return fail();
    preflightSourceReader(root.sourceReader);
    if (typeof root.readEnvText !== 'function' || isProxy(root.readEnvText)) return fail();
    if (typeof root.fetchImpl !== 'function' || isProxy(root.fetchImpl)) return fail();

    const priceText = await readText(root.readEnvText, parsed.priceSnapshotFile);
    const priceSnapshot = parsePriceSnapshot(priceText, root.nowMs as number);
    const supabaseUrl = httpsUrl(await readText(root.readEnvText, 'SUPABASE_URL'));
    const serviceKey = nonEmpty(await readText(root.readEnvText, 'SUPABASE_SERVICE_ROLE_KEY'));
    const userId = await readText(root.readEnvText, 'STAYSEE_MEMORY_V3_BACKFILL_USER_ID');
    if (!UUID.test(userId)) return fail();
    const reader = resolveSourceReader(root.sourceReader, supabaseUrl, serviceKey);

    const prepared = await inspectLifecycleHistorySource({
      profileId: parsed.profileId,
      userId,
      sourceCutoff: parsed.sourceCutoff,
      reader,
    });
    const preflight = await runLifecycleHistoryBackfill({
      profileId: parsed.profileId,
      prepared,
      priceSnapshot,
      maxBudgetUsd: parsed.maxBudgetUsd,
      nowMs: root.nowMs as number,
      execute: false,
    });
    if (parsed.mode === 'inspect') {
      return { benchmarkResult: preflight, semanticReviewPacket: null };
    }
    if (prepared.manifest.sourceSnapshotDigest !== parsed.expectedSourceSha256) return fail();
    const apiKey = nonEmpty(await readText(root.readEnvText, 'OPENROUTER_API_KEY'));

    let extractorAdapter;
    let reconcilerAdapter;
    try {
      extractorAdapter = createMemoryV3OpenRouterAdapter({
        apiKey,
        fetchImpl: root.fetchImpl as typeof fetch,
      });
      reconcilerAdapter = createMemoryV3LifecycleOpenRouterAdapter({
        apiKey,
        fetchImpl: root.fetchImpl as typeof fetch,
      });
    } catch {
      return fail();
    }
    const benchmarkResult = await runLifecycleHistoryBackfill({
      profileId: parsed.profileId,
      prepared,
      priceSnapshot,
      maxBudgetUsd: parsed.maxBudgetUsd,
      nowMs: root.nowMs as number,
      execute: true,
      extractorAdapter,
      reconcilerAdapter,
    });
    if (benchmarkResult.failureCount !== 0 || benchmarkResult.finalState === null) return fail();
    const semanticReviewPacket = buildLifecycleHistoryReviewPacket(benchmarkResult);
    return { benchmarkResult, semanticReviewPacket };
  });
}
