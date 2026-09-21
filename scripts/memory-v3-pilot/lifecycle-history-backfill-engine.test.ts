import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLifecycleHistoryReviewPacket,
  runLifecycleHistoryBackfill,
} from './lifecycle-history-backfill-engine.ts';
import {
  prepareLifecycleHistoryBackfill,
  type PreparedLifecycleHistoryBackfill,
} from './lifecycle-history-backfill-contract.ts';
import {
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
} from './lifecycle-history-backfill-profile.ts';
import type { MemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import type { MemoryV3LifecycleReconcileRequest } from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW_MS = Date.parse('2026-09-22T12:00:00.000Z');
const PRICE = {
  model: 'google/gemini-3.7-flash',
  inputUsdPerMillion: '0.75',
  outputUsdPerMillion: '3.75',
  observedAt: '2026-09-22T11:00:00.000Z',
  sourceUrl: 'https://openrouter.ai/google/gemini-3.7-flash',
} as const;
const OMIT = {
  layerDecisions: ['event', 'recurrence', 'hypothesis'].map((kind) => ({
    kind,
    decision: 'omit',
    itemRefs: [],
  })),
  items: [],
  evidence: [],
};

function prepared(count = 2): PreparedLifecycleHistoryBackfill {
  return prepareLifecycleHistoryBackfill({
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    snapshot: {
      userId: USER_ID,
      sourceCutoff: '2026-09-20T00:00:00.000Z',
      conversations: Array.from({ length: count }, (_, index) => ({
        conversationId: `${index + 2}2222222-2222-4222-8222-222222222222`,
        createdAt: `2026-09-${10 + index}T10:00:00.000Z`,
        messages: [{
          id: `${index + 3}3333333-3333-4333-8333-333333333333`,
          role: 'user',
          text: `remember-${index}`,
          createdAt: `2026-09-${10 + index}T10:01:00.000Z`,
        }],
      })),
    },
  });
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    prepared: prepared(),
    priceSnapshot: PRICE,
    maxBudgetUsd: '1',
    nowMs: NOW_MS,
    execute: false,
    ...overrides,
  };
}

function eventRaw(request: MemoryV3ExtractorRequest): string {
  const message = request.input.messages[0];
  return JSON.stringify({
    layerDecisions: [
      { kind: 'event', decision: 'emit', itemRefs: ['i1'] },
      { kind: 'recurrence', decision: 'omit', itemRefs: [] },
      { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
    ],
    items: [{
      itemRef: 'i1',
      kind: 'event',
      claim: message.text,
      status: 'active',
      sensitivity: 'normal',
      eventTimeStart: null,
      eventTimeEnd: null,
      alternative: null,
    }],
    evidence: [{
      itemRef: 'i1',
      sourceMessageId: message.id,
      relation: 'supports',
      supportType: null,
      episodeKey: `episode:${message.id}`,
    }],
  });
}

describe('Memory V3 lifecycle history backfill engine', () => {
  it('validates a dry run and preserves its exact price and budget without adapters', async () => {
    const result = await runLifecycleHistoryBackfill(options({
      extractorAdapter: 'INVALID_ADAPTER',
      reconcilerAdapter: 'INVALID_ADAPTER',
    }) as never);
    assert.equal(result.execute, false);
    assert.equal(result.providerCallCount, 0);
    assert.equal(result.attemptedChunkCount, 0);
    assert.equal(result.finalState, null);
    assert.deepEqual(result.priceSnapshot, PRICE);
    assert.deepEqual(result.budget, {
      maxRequests: 4,
      reservedInputTokensPerCall: 32_768,
      maxOutputTokensPerCall: 1_200,
      ceilingUsd: '0.116304',
      hardMaxUsd: '1',
      gate: 'PASS',
    });
  });

  it('executes extractor then reconciler sequentially and carries state across chunks', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const extractorAdapter = async (request: MemoryV3ExtractorRequest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`extract:${request.input.caseId}`);
      await Promise.resolve();
      active -= 1;
      return { content: eventRaw(request), usage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 } };
    };
    const reconcilerAdapter = async (request: MemoryV3LifecycleReconcileRequest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`reconcile:${request.input.session.conversationId}`);
      assert.equal(request.input.currentItems.length, order.length === 2 ? 0 : 1);
      await Promise.resolve();
      active -= 1;
      return {
        rawContent: JSON.stringify({
          operations: request.input.candidates.map((candidate) => ({
            type: 'create',
            candidateRef: candidate.candidateRef,
            targetMemoryRef: null,
          })),
        }),
        usage: { promptTokens: 20, completionTokens: 3, costUsd: 0.002 },
      };
    };
    const result = await runLifecycleHistoryBackfill(options({
      execute: true,
      extractorAdapter,
      reconcilerAdapter,
    }));
    assert.deepEqual(order.map((entry) => entry.split(':')[0]), [
      'extract', 'reconcile', 'extract', 'reconcile',
    ]);
    assert.equal(maxActive, 1);
    assert.equal(result.providerCallCount, 4);
    assert.equal(result.failureCount, 0);
    assert.equal(result.finalState?.stateRevision, 2);
    assert.deepEqual(result.finalState?.items.map((item) => item.claim), ['remember-0', 'remember-1']);
    assert.deepEqual(result.actualUsage, { promptTokens: 60, completionTokens: 10 });
    assert.equal(result.actualCostUsd, 0.006);
  });

  it('stops at a middle failure and never exposes a partial state', async () => {
    let extractorCalls = 0;
    let reconcilerCalls = 0;
    const result = await runLifecycleHistoryBackfill(options({
      prepared: prepared(3),
      execute: true,
      extractorAdapter: async () => {
        extractorCalls += 1;
        return {
          content: extractorCalls === 2 ? 'RAW_ERROR_SENTINEL{' : JSON.stringify(OMIT),
          usage: null,
        };
      },
      reconcilerAdapter: async () => {
        reconcilerCalls += 1;
        return { rawContent: JSON.stringify({ operations: [] }), usage: null };
      },
    }));
    assert.equal(extractorCalls, 2);
    assert.equal(reconcilerCalls, 1);
    assert.equal(result.providerCallCount, 3);
    assert.equal(result.attemptedChunkCount, 2);
    assert.equal(result.successChunkCount, 1);
    assert.equal(result.failureCount, 1);
    assert.equal(result.failures[0].stage, 'extractor_parse');
    assert.equal(result.finalState, null);
    assert.doesNotMatch(JSON.stringify(result), /RAW_ERROR_SENTINEL/u);
    assert.throws(() => buildLifecycleHistoryReviewPacket(result));
  });

  it('requires both adapters only after source and budget preflight', async () => {
    await assert.rejects(() => runLifecycleHistoryBackfill(options({
      execute: true,
      prepared: { ...prepared(), chunks: [] },
    }) as never), /\[memory-v3:lifecycle-history-backfill-engine\]/u);
    await assert.rejects(() => runLifecycleHistoryBackfill(options({ execute: true }) as never));
  });

  it('creates a digest-bound review packet containing metadata but no dialogue or prompts', async () => {
    const result = await runLifecycleHistoryBackfill(options({
      execute: true,
      extractorAdapter: async (request: MemoryV3ExtractorRequest) => ({
        content: eventRaw(request),
        usage: null,
      }),
      reconcilerAdapter: async (request: MemoryV3LifecycleReconcileRequest) => ({
        rawContent: JSON.stringify({
          operations: request.input.candidates.map((candidate) => ({
            type: 'create', candidateRef: candidate.candidateRef, targetMemoryRef: null,
          })),
        }),
        usage: null,
      }),
    }));
    const packet = buildLifecycleHistoryReviewPacket(result);
    assert.match(packet.payloadSha256, /^[0-9a-f]{64}$/u);
    assert.equal(packet.items.length, 2);
    assert.equal(packet.items[0].semanticVerdict, null);
    assert.equal(packet.items[0].reviewerNotes, null);
    const publicJson = JSON.stringify({ result, packet });
    assert.doesNotMatch(publicJson, /remember-0.*system|You extract|API_KEY_SENTINEL/u);
  });

  it('fails safely for getters, symbols, proxies, cycles, and revoked values', async () => {
    let getterRan = false;
    const withGetter = Object.defineProperty(options(), 'profileId', {
      enumerable: true,
      get() {
        getterRan = true;
        return LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID;
      },
    });
    await assert.rejects(() => runLifecycleHistoryBackfill(withGetter as never));
    assert.equal(getterRan, false);
    await assert.rejects(() => runLifecycleHistoryBackfill({
      ...options(),
      [Symbol('sentinel')]: true,
    } as never));
    const cyclic = options();
    Object.defineProperty(cyclic, 'self', { value: cyclic, enumerable: true });
    await assert.rejects(() => runLifecycleHistoryBackfill(cyclic as never));
    await assert.rejects(() => runLifecycleHistoryBackfill(new Proxy(options(), {}) as never));
    const revoked = Proxy.revocable(options(), {});
    revoked.revoke();
    await assert.rejects(() => runLifecycleHistoryBackfill(revoked.proxy as never));
  });

  it('wraps malformed nested prepared data in the fixed engine diagnostic', async () => {
    await assert.rejects(
      () => runLifecycleHistoryBackfill(options({
        prepared: {
          userId: USER_ID,
          manifest: {
            schemaVersion: 'memory-v3-lifecycle-history-manifest-v1',
            profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
            chunkCount: 1,
            maxProviderCalls: 2,
            sourceSnapshotDigest: '0'.repeat(64),
            chunks: null,
          },
          chunks: [{}],
        },
      }) as never),
      /^MemoryV3LifecycleHistoryBackfillEngineError: \[memory-v3:lifecycle-history-backfill-engine\] operation failed$/u,
    );
  });
});
