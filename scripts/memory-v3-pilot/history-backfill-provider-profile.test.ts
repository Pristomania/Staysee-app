import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  HISTORY_BACKFILL_MODEL_ROUTE,
  calculateHistoryBackfillBudget,
  validateHistoryBackfillPriceSnapshot,
} from './history-backfill-provider-profile.ts';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const PARAMETERS = ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'] as const;
const SNAPSHOT = {
  route: [
    { model: 'google/gemini-3.7-flash', inputUsdPerMillion: '0.75', outputUsdPerMillion: '3.75', observedAt: '2026-09-28T11:00:00.000Z', sourceUrl: 'https://openrouter.ai/api/v1/models/google/gemini-3.7-flash/endpoints', supportedParameters: [...PARAMETERS], zdr: true },
    { model: 'mistralai/mistral-medium-3-5', inputUsdPerMillion: '1.5', outputUsdPerMillion: '7.5', observedAt: '2026-09-28T11:00:00.000Z', sourceUrl: 'https://openrouter.ai/api/v1/models/mistralai/mistral-medium-3-5/endpoints', supportedParameters: [...PARAMETERS], zdr: true },
  ],
};

describe('scope-neutral history backfill provider profile', () => {
  it('owns only route, price validation, and budget arithmetic', () => {
    assert.deepEqual(HISTORY_BACKFILL_MODEL_ROUTE, ['google/gemini-3.7-flash', 'mistralai/mistral-medium-3-5']);
    const validated = validateHistoryBackfillPriceSnapshot(SNAPSHOT, NOW);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(calculateHistoryBackfillBudget({ chunkCount: 1, priceSnapshot: validated, maxBudgetUsd: '0.159744' }).gate, 'PASS');
  });

  it('contains no scope profile id or extractor identity', () => {
    const source = readFileSync(new URL('./history-backfill-provider-profile.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /memory-v3-(lifecycle|dialogue)-history-backfill-v1/);
    assert.doesNotMatch(source, /extractor-v1|shadow-v2/);
    assert.doesNotMatch(source, /lifecycle-history-backfill-profile/);
    assert.doesNotMatch(source, /dialogue-history-backfill-profile/);
  });

  it('rejects stale snapshots, accessors, and proxies without executing traps', () => {
    assert.throws(() => validateHistoryBackfillPriceSnapshot({
      route: [SNAPSHOT.route[0], { ...SNAPSHOT.route[1], observedAt: '2026-09-27T11:59:59.999Z' }],
    }, NOW));
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'route', {
      enumerable: true,
      get() { getterCalls += 1; return SNAPSHOT.route; },
    });
    assert.throws(() => validateHistoryBackfillPriceSnapshot(accessor, NOW));
    assert.equal(getterCalls, 0);
    let trapCalls = 0;
    const proxy = new Proxy(SNAPSHOT, {
      ownKeys(target) { trapCalls += 1; return Reflect.ownKeys(target); },
    });
    assert.throws(() => validateHistoryBackfillPriceSnapshot(proxy, NOW));
    assert.equal(trapCalls, 0);
  });
});
