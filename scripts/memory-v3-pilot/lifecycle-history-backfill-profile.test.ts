import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
import { MEMORY_V3_EXTRACTOR_VERSION } from '../../supabase/functions/_shared/memoryV3/contract.ts';
import {
  LIFECYCLE_HISTORY_BACKFILL_MAX_EXTRACTOR_BYTES,
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  calculateLifecycleHistoryBudget,
  getLifecycleHistoryBackfillProfile,
  validateLifecycleHistoryPriceSnapshot,
} from './lifecycle-history-backfill-profile.ts';

const NOW_MS = Date.parse('2026-09-21T12:00:00.000Z');
const FRESH_SNAPSHOT = Object.freeze({
  model: 'google/gemini-3.7-flash' as const,
  inputUsdPerMillion: '0.75',
  outputUsdPerMillion: '3.75',
  observedAt: '2026-09-21T11:00:00.000Z',
  sourceUrl: 'https://openrouter.ai/google/gemini-3.7-flash/pricing',
});

const PROFILE_KEYS = [
  'profileId',
  'schemaVersion',
  'pipelineVersion',
  'extractorVersion',
  'reconcilerVersion',
  'model',
  'maxMessagesPerChunk',
  'maxExtractorRequestBytes',
  'maxReconcilerRequestBytes',
  'reservedInputTokensPerCall',
  'maxOutputTokensPerCall',
  'maxStateItems',
  'maxStateEvidence',
  'maxCallsPerChunk',
  'maxActive',
  'executeFlag',
] as const;

function decimalNanodollars(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function captureError(operation: () => unknown): Error {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, 'MemoryV3LifecycleHistoryBackfillProfileError');
  assert.equal(
    thrown.message,
    '[memory-v3:lifecycle-history-backfill-profile] value is invalid',
  );
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  return thrown;
}

describe('history backfill profile', () => {
  it('returns the registry-owned deeply frozen profile', () => {
    const first = getLifecycleHistoryBackfillProfile(
      'memory-v3-lifecycle-history-backfill-v1',
    );
    const second = getLifecycleHistoryBackfillProfile(
      'memory-v3-lifecycle-history-backfill-v1',
    );

    assert.equal(
      LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      'memory-v3-lifecycle-history-backfill-v1',
    );
    assert.equal(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.deepEqual(Reflect.ownKeys(first), PROFILE_KEYS);
    assert.throws(() => {
      (first as { maxActive: number }).maxActive = 2;
    }, TypeError);
    assert.equal(first.maxActive, 1);
  });

  it('copies lifecycle limits except for the history-only extractor envelope and output cap', () => {
    const profile = getLifecycleHistoryBackfillProfile(
      LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    );

    assert.deepEqual(profile, {
      profileId: 'memory-v3-lifecycle-history-backfill-v1',
      schemaVersion: MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
      pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
      reconcilerVersion: MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
      model: MEMORY_V3_LIFECYCLE_MODEL,
      maxMessagesPerChunk: MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES,
      maxExtractorRequestBytes: LIFECYCLE_HISTORY_BACKFILL_MAX_EXTRACTOR_BYTES,
      maxReconcilerRequestBytes: MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
      reservedInputTokensPerCall: MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
      maxOutputTokensPerCall: 4_096,
      maxStateItems: MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
      maxStateEvidence: MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
      maxCallsPerChunk: MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN,
      maxActive: 1,
      executeFlag: '--execute-history-backfill-paid-requests',
    });
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES, 20_000);
    assert.equal(LIFECYCLE_HISTORY_BACKFILL_MAX_EXTRACTOR_BYTES, 40_000);
    assert.equal(MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL, 1_200);
  });

  it('rejects unknown strings, objects, boxed strings, symbols, arrays, and null', () => {
    const invalid: unknown[] = [
      'memory-v3-lifecycle-history-backfill-v2',
      { profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID },
      new String(LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID),
      Symbol('profile'),
      [LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID],
      null,
    ];
    for (const value of invalid) captureError(() => getLifecycleHistoryBackfillProfile(value));
  });

  it('does not execute a getter container', () => {
    let getterCalls = 0;
    const value = Object.create(null);
    Object.defineProperty(value, 'profileId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_PROFILE_GETTER_SENTINEL');
      },
    });

    const error = captureError(() => getLifecycleHistoryBackfillProfile(value));
    assert.equal(getterCalls, 0);
    assert.equal(error.message.includes('RAW_PROFILE_GETTER_SENTINEL'), false);
  });
});

describe('fresh price snapshot', () => {
  it('accepts exact JSON data with matching model and HTTPS source URL', () => {
    const input = { ...FRESH_SNAPSHOT };
    const result = validateLifecycleHistoryPriceSnapshot(input, NOW_MS);

    assert.deepEqual(result, FRESH_SNAPSHOT);
    assert.notEqual(result, input);
    assert.deepEqual(Reflect.ownKeys(result), [
      'model',
      'inputUsdPerMillion',
      'outputUsdPerMillion',
      'observedAt',
      'sourceUrl',
    ]);
  });

  it('rejects a snapshot older than 24 hours or dated in the future', () => {
    const exactlyFresh = {
      ...FRESH_SNAPSHOT,
      observedAt: '2026-09-20T12:00:00.000Z',
    };
    assert.deepEqual(
      validateLifecycleHistoryPriceSnapshot(exactlyFresh, NOW_MS),
      exactlyFresh,
    );

    for (const observedAt of [
      '2026-09-20T11:59:59.999Z',
      '2026-09-21T12:00:00.001Z',
    ]) {
      captureError(() =>
        validateLifecycleHistoryPriceSnapshot({ ...FRESH_SNAPSHOT, observedAt }, NOW_MS)
      );
    }
  });

  it('rejects number prices, negative prices, exponent notation, and extra fields', () => {
    const invalid: unknown[] = [
      { ...FRESH_SNAPSHOT, inputUsdPerMillion: 0.75 },
      { ...FRESH_SNAPSHOT, inputUsdPerMillion: '-0.75' },
      { ...FRESH_SNAPSHOT, outputUsdPerMillion: '3.75e0' },
      { ...FRESH_SNAPSHOT, extra: true },
      { ...FRESH_SNAPSHOT, model: 'another/model' },
      { ...FRESH_SNAPSHOT, sourceUrl: 'http://openrouter.ai/pricing' },
    ];
    for (const value of invalid) {
      captureError(() => validateLifecycleHistoryPriceSnapshot(value, NOW_MS));
    }
  });

  it('rejects getters, cycles, symbols, and proxies without leaking trap text', () => {
    let getterCalls = 0;
    const getterValue = { ...FRESH_SNAPSHOT } as Record<string, unknown>;
    Object.defineProperty(getterValue, 'inputUsdPerMillion', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_PRICE_GETTER_SENTINEL');
      },
    });
    captureError(() => validateLifecycleHistoryPriceSnapshot(getterValue, NOW_MS));
    assert.equal(getterCalls, 0);

    const cyclic = { ...FRESH_SNAPSHOT } as Record<string, unknown>;
    cyclic.inputUsdPerMillion = cyclic;
    captureError(() => validateLifecycleHistoryPriceSnapshot(cyclic, NOW_MS));

    const symbolValue = { ...FRESH_SNAPSHOT, [Symbol('secret')]: 'hidden' };
    captureError(() => validateLifecycleHistoryPriceSnapshot(symbolValue, NOW_MS));

    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error('RAW_PRICE_PROXY_SENTINEL');
      },
    });
    const error = captureError(() => validateLifecycleHistoryPriceSnapshot(proxy, NOW_MS));
    assert.equal(error.message.includes('RAW_PRICE_PROXY_SENTINEL'), false);

    let transparentTrapCalls = 0;
    const transparentTarget = { ...FRESH_SNAPSHOT };
    const transparentProxy = new Proxy(transparentTarget, {
      getPrototypeOf(target) {
        transparentTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        transparentTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        transparentTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    captureError(() => validateLifecycleHistoryPriceSnapshot(transparentProxy, NOW_MS));
    assert.equal(transparentTrapCalls, 0);

    const revoked = Proxy.revocable({ ...FRESH_SNAPSHOT }, {});
    revoked.revoke();
    captureError(() => validateLifecycleHistoryPriceSnapshot(revoked.proxy, NOW_MS));
  });
});

describe('exact budget arithmetic', () => {
  it('uses two requests per chunk and integer nanodollars', () => {
    assert.deepEqual(
      calculateLifecycleHistoryBudget({
        chunkCount: 2,
        priceSnapshot: FRESH_SNAPSHOT,
        maxBudgetUsd: '0.16',
      }),
      {
        maxRequests: 4,
        ceilingNanodollars: decimalNanodollars('0.159744'),
        ceilingUsd: '0.159744',
        hardMaxNanodollars: decimalNanodollars('0.16'),
        gate: 'PASS',
      },
    );

    assert.equal(
      calculateLifecycleHistoryBudget({
        chunkCount: 1,
        priceSnapshot: {
          ...FRESH_SNAPSHOT,
          inputUsdPerMillion: '0.000000001',
          outputUsdPerMillion: '0',
        },
        maxBudgetUsd: '0.000000001',
      }).ceilingNanodollars,
      decimalNanodollars('0.000000001'),
    );
  });

  it('rejects zero, negative, fractional, or unsafe chunk counts', () => {
    for (const chunkCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      captureError(() =>
        calculateLifecycleHistoryBudget({
          chunkCount,
          priceSnapshot: FRESH_SNAPSHOT,
          maxBudgetUsd: '1',
        })
      );
    }

    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    assert.equal(
      calculateLifecycleHistoryBudget({
        chunkCount: largest,
        priceSnapshot: {
          ...FRESH_SNAPSHOT,
          inputUsdPerMillion: '0',
          outputUsdPerMillion: '0',
        },
        maxBudgetUsd: '0',
      }).maxRequests,
      largest * 2,
    );
    captureError(() =>
      calculateLifecycleHistoryBudget({
        chunkCount: largest + 1,
        priceSnapshot: {
          ...FRESH_SNAPSHOT,
          inputUsdPerMillion: '0',
          outputUsdPerMillion: '0',
        },
        maxBudgetUsd: '0',
      })
    );
  });

  it('rejects a hard maximum below the ceiling', () => {
    captureError(() =>
      calculateLifecycleHistoryBudget({
        chunkCount: 1,
        priceSnapshot: FRESH_SNAPSHOT,
        maxBudgetUsd: '0.079871999',
      })
    );
    captureError(() =>
      calculateLifecycleHistoryBudget({
        chunkCount: 1,
        priceSnapshot: FRESH_SNAPSHOT,
        maxBudgetUsd: '7.9872e-2',
      })
    );
  });

  it('does not reconstruct actual billing', () => {
    const result = calculateLifecycleHistoryBudget({
      chunkCount: 1,
      priceSnapshot: FRESH_SNAPSHOT,
      maxBudgetUsd: '0.079872',
    });

    assert.deepEqual(Reflect.ownKeys(result), [
      'maxRequests',
      'ceilingNanodollars',
      'ceilingUsd',
      'hardMaxNanodollars',
      'gate',
    ]);
    assert.equal(Object.hasOwn(result, 'actualUsage'), false);
    assert.equal(Object.hasOwn(result, 'actualCostUsd'), false);
  });
});
