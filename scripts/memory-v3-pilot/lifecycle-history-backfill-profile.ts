import { isProxy } from 'node:util/types';

import { MEMORY_V3_EXTRACTOR_VERSION } from '../../supabase/functions/_shared/memoryV3/contract.ts';
import {
  MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN,
  MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
  MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES,
  MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
  MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
  MEMORY_V3_LIFECYCLE_MODEL,
  MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
  MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
  MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
  MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';

export const LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID =
  'memory-v3-lifecycle-history-backfill-v1' as const;

export interface LifecycleHistoryBackfillProfile {
  profileId: typeof LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID;
  schemaVersion: 'memory-v3-lifecycle-state-v1';
  pipelineVersion: 'memory-v3-lifecycle-shadow-v1';
  extractorVersion: 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2';
  reconcilerVersion: 'memory-v3-lifecycle-reconciler-v1';
  model: 'google/gemini-3.7-flash';
  maxMessagesPerChunk: 60;
  maxExtractorRequestBytes: 20_000;
  maxReconcilerRequestBytes: 80_000;
  reservedInputTokensPerCall: 32_768;
  maxOutputTokensPerCall: 1_200;
  maxStateItems: 100;
  maxStateEvidence: 500;
  maxCallsPerChunk: 2;
  maxActive: 1;
  executeFlag: '--execute-history-backfill-paid-requests';
}

export interface LifecycleHistoryPriceSnapshot {
  model: 'google/gemini-3.7-flash';
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  observedAt: string;
  sourceUrl: string;
}

const PRICE_FIELDS = [
  'model',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'observedAt',
  'sourceUrl',
] as const;
const BUDGET_FIELDS = ['chunkCount', 'priceSnapshot', 'maxBudgetUsd'] as const;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/;
const MAX_PRICE_AGE_MS = 86_400_000;
const NANODOLLARS_PER_USD = 1_000_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;
const OWN_ERRORS = new WeakSet<object>();
const ERROR_TOKENS = new WeakMap<object, object>();

function makeError(token: object): Error {
  const error = new Error('[memory-v3:lifecycle-history-backfill-profile] value is invalid');
  error.name = 'MemoryV3LifecycleHistoryBackfillProfileError';
  OWN_ERRORS.add(error);
  ERROR_TOKENS.set(error, token);
  return error;
}

function fail(token: object): never {
  throw makeError(token);
}

function boundary<T>(operation: (token: object) => T): T {
  const token = Object.freeze({});
  try {
    return operation(token);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      OWN_ERRORS.has(error) &&
      ERROR_TOKENS.get(error) === token
    ) {
      throw error;
    }
    throw makeError(token);
  }
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

const PROFILE = deepFreeze<LifecycleHistoryBackfillProfile>({
  profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  schemaVersion: MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
  pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
  extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
  reconcilerVersion: MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
  model: MEMORY_V3_LIFECYCLE_MODEL,
  maxMessagesPerChunk: MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES,
  maxExtractorRequestBytes: MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES,
  maxReconcilerRequestBytes: MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
  reservedInputTokensPerCall: MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
  maxOutputTokensPerCall: MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
  maxStateItems: MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
  maxStateEvidence: MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
  maxCallsPerChunk: MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN,
  maxActive: 1,
  executeFlag: '--execute-history-backfill-paid-requests',
});

function projectRecord(
  token: object,
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    if (typeof value !== 'object' || value === null) fail(token);
    if (isProxy(value)) fail(token);
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      OWN_ERRORS.has(error) &&
      ERROR_TOKENS.get(error) === token
    ) {
      throw error;
    }
    fail(token);
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) fail(token);
  if (keys.length !== fields.length) fail(token);

  const allowed = new Set(fields);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(token);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token);
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      fail(token);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(output, field)) fail(token);
  }
  return output;
}

function parseDecimalNanodollars(token: object, value: unknown): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(token);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * NANODOLLARS_PER_USD +
    BigInt(fraction.padEnd(9, '0'));
}

function parseCanonicalTimestamp(token: object, value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(token);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) fail(token);
  return timestamp;
}

function assertHttpsUrl(token: object, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value) fail(token);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(token);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0
  ) {
    fail(token);
  }
}

function projectPriceSnapshot(
  token: object,
  value: unknown,
): { snapshot: LifecycleHistoryPriceSnapshot; observedAtMs: number } {
  const record = projectRecord(token, value, PRICE_FIELDS);
  if (record.model !== MEMORY_V3_LIFECYCLE_MODEL) fail(token);
  parseDecimalNanodollars(token, record.inputUsdPerMillion);
  parseDecimalNanodollars(token, record.outputUsdPerMillion);
  const observedAtMs = parseCanonicalTimestamp(token, record.observedAt);
  assertHttpsUrl(token, record.sourceUrl);
  return {
    snapshot: {
      model: MEMORY_V3_LIFECYCLE_MODEL,
      inputUsdPerMillion: record.inputUsdPerMillion as string,
      outputUsdPerMillion: record.outputUsdPerMillion as string,
      observedAt: record.observedAt as string,
      sourceUrl: record.sourceUrl,
    },
    observedAtMs,
  };
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function formatUsdFromNanodollars(value: bigint): string {
  const whole = value / NANODOLLARS_PER_USD;
  const fraction = (value % NANODOLLARS_PER_USD)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function getLifecycleHistoryBackfillProfile(
  profileId: unknown,
): LifecycleHistoryBackfillProfile {
  return boundary((token) => {
    if (
      typeof profileId !== 'string' ||
      profileId !== LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID
    ) {
      fail(token);
    }
    return PROFILE;
  });
}

export function validateLifecycleHistoryPriceSnapshot(
  value: unknown,
  nowMs: number,
): LifecycleHistoryPriceSnapshot {
  return boundary((token) => {
    if (!Number.isSafeInteger(nowMs)) fail(token);
    const { snapshot, observedAtMs } = projectPriceSnapshot(token, value);
    const ageMs = nowMs - observedAtMs;
    if (ageMs < 0 || ageMs > MAX_PRICE_AGE_MS) fail(token);
    return snapshot;
  });
}

export function calculateLifecycleHistoryBudget(input: {
  chunkCount: number;
  priceSnapshot: LifecycleHistoryPriceSnapshot;
  maxBudgetUsd: string;
}): {
  maxRequests: number;
  ceilingNanodollars: bigint;
  ceilingUsd: string;
  hardMaxNanodollars: bigint;
  gate: 'PASS';
} {
  return boundary((token) => {
    const record = projectRecord(token, input, BUDGET_FIELDS);
    if (
      typeof record.chunkCount !== 'number' ||
      !Number.isSafeInteger(record.chunkCount) ||
      record.chunkCount <= 0 ||
      record.chunkCount > Math.floor(Number.MAX_SAFE_INTEGER / PROFILE.maxCallsPerChunk)
    ) {
      fail(token);
    }
    const { snapshot } = projectPriceSnapshot(token, record.priceSnapshot);
    const hardMaxNanodollars = parseDecimalNanodollars(token, record.maxBudgetUsd);
    const maxRequests = record.chunkCount * PROFILE.maxCallsPerChunk;
    const requestCount = BigInt(maxRequests);
    const inputTokens = requestCount * BigInt(PROFILE.reservedInputTokensPerCall);
    const outputTokens = requestCount * BigInt(PROFILE.maxOutputTokensPerCall);
    const inputPrice = parseDecimalNanodollars(token, snapshot.inputUsdPerMillion);
    const outputPrice = parseDecimalNanodollars(token, snapshot.outputUsdPerMillion);
    const ceilingNanodollars = divideRoundUp(
      inputTokens * inputPrice + outputTokens * outputPrice,
      TOKENS_PER_MILLION,
    );
    if (hardMaxNanodollars < ceilingNanodollars) fail(token);

    return {
      maxRequests,
      ceilingNanodollars,
      ceilingUsd: formatUsdFromNanodollars(ceilingNanodollars),
      hardMaxNanodollars,
      gate: 'PASS',
    };
  });
}
