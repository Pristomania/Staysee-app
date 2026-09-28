import { isProxy } from 'node:util/types';

export const HISTORY_BACKFILL_PRIMARY_MODEL = 'google/gemini-3.7-flash' as const;
export const HISTORY_BACKFILL_FALLBACK_MODEL = 'mistralai/mistral-medium-3-5' as const;
export const HISTORY_BACKFILL_MODEL_ROUTE = Object.freeze([
  HISTORY_BACKFILL_PRIMARY_MODEL,
  HISTORY_BACKFILL_FALLBACK_MODEL,
] as const);

export type HistoryBackfillResolvedModel = typeof HISTORY_BACKFILL_MODEL_ROUTE[number];
export interface HistoryBackfillEndpointSnapshot {
  model: HistoryBackfillResolvedModel;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  observedAt: string;
  sourceUrl: string;
  supportedParameters: readonly ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'];
  zdr: true;
}
export interface HistoryBackfillPriceSnapshot {
  route: readonly [HistoryBackfillEndpointSnapshot, HistoryBackfillEndpointSnapshot];
}
export interface HistoryBackfillBudget {
  maxRequests: number;
  ceilingNanodollars: bigint;
  ceilingUsd: string;
  hardMaxNanodollars: bigint;
  gate: 'PASS';
}

const PARAMETERS = ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'] as const;
const ENDPOINT_FIELDS = ['model', 'inputUsdPerMillion', 'outputUsdPerMillion', 'observedAt', 'sourceUrl', 'supportedParameters', 'zdr'] as const;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/;
const NANODOLLARS = 1_000_000_000n;
const OWN_ERRORS = new WeakSet<object>();

function fail(): never {
  const error = new Error('[memory-v3:history-backfill-provider-profile] value is invalid');
  error.name = 'MemoryV3HistoryBackfillProviderProfileError';
  OWN_ERRORS.add(error);
  throw error;
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length) fail();
    const allowed = new Set(fields);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.has(key)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) fail();
      output[key] = descriptor.value;
    }
    for (const field of fields) if (!Object.hasOwn(output, field)) fail();
    return output;
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) throw error;
    fail();
  }
}

function dense(value: unknown, length: number): unknown[] {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const keys = Reflect.ownKeys(value);
    if (!descriptor || !('value' in descriptor) || descriptor.value !== length || keys.length !== length + 1) fail();
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !item.enumerable || !('value' in item) || item.value === undefined) fail();
      output.push(item.value);
    }
    return output;
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) throw error;
    fail();
  }
}

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail();
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * NANODOLLARS + BigInt(fraction.padEnd(9, '0'));
}

function endpoint(value: unknown, model: HistoryBackfillResolvedModel): { value: HistoryBackfillEndpointSnapshot; time: number } {
  const input = record(value, ENDPOINT_FIELDS);
  if (input.model !== model || input.zdr !== true) fail();
  decimal(input.inputUsdPerMillion);
  decimal(input.outputUsdPerMillion);
  if (typeof input.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.observedAt)) fail();
  const time = Date.parse(input.observedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== input.observedAt) fail();
  const expectedUrl = `https://openrouter.ai/api/v1/models/${model}/endpoints`;
  if (input.sourceUrl !== expectedUrl) fail();
  const parameters = dense(input.supportedParameters, PARAMETERS.length);
  if (parameters.some((entry, index) => entry !== PARAMETERS[index])) fail();
  return {
    value: Object.freeze({
      model,
      inputUsdPerMillion: input.inputUsdPerMillion as string,
      outputUsdPerMillion: input.outputUsdPerMillion as string,
      observedAt: input.observedAt,
      sourceUrl: expectedUrl,
      supportedParameters: Object.freeze([...PARAMETERS]),
      zdr: true,
    }),
    time,
  };
}

function projectSnapshot(value: unknown): {
  snapshot: HistoryBackfillPriceSnapshot;
  observedAt: readonly [number, number];
} {
  const root = record(value, ['route']);
  const route = dense(root.route, 2);
  const primary = endpoint(route[0], HISTORY_BACKFILL_PRIMARY_MODEL);
  const fallback = endpoint(route[1], HISTORY_BACKFILL_FALLBACK_MODEL);
  return {
    snapshot: Object.freeze({ route: Object.freeze([primary.value, fallback.value]) }),
    observedAt: [primary.time, fallback.time],
  };
}

export function validateHistoryBackfillPriceSnapshot(value: unknown, nowMs: number): HistoryBackfillPriceSnapshot {
  if (!Number.isSafeInteger(nowMs)) fail();
  const projected = projectSnapshot(value);
  for (const observed of projected.observedAt) {
    const age = nowMs - observed;
    if (age < 0 || age > 86_400_000) fail();
  }
  return projected.snapshot;
}

function formatUsd(value: bigint): string {
  const whole = value / NANODOLLARS;
  const fraction = (value % NANODOLLARS).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function calculateHistoryBackfillBudget(input: unknown): HistoryBackfillBudget {
  const value = record(input, ['chunkCount', 'priceSnapshot', 'maxBudgetUsd']);
  if (typeof value.chunkCount !== 'number' || !Number.isSafeInteger(value.chunkCount) || value.chunkCount <= 0 || value.chunkCount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) fail();
  const snapshot = projectSnapshot(value.priceSnapshot).snapshot;
  const hardMaxNanodollars = decimal(value.maxBudgetUsd);
  const maxRequests = value.chunkCount * 2;
  const inputPrice = snapshot.route.reduce((max, item) => decimal(item.inputUsdPerMillion) > max ? decimal(item.inputUsdPerMillion) : max, 0n);
  const outputPrice = snapshot.route.reduce((max, item) => decimal(item.outputUsdPerMillion) > max ? decimal(item.outputUsdPerMillion) : max, 0n);
  const numerator = BigInt(maxRequests) * (32_768n * inputPrice + 4_096n * outputPrice);
  const ceilingNanodollars = (numerator + 999_999n) / 1_000_000n;
  if (hardMaxNanodollars < ceilingNanodollars) fail();
  return { maxRequests, ceilingNanodollars, ceilingUsd: formatUsd(ceilingNanodollars), hardMaxNanodollars, gate: 'PASS' };
}
