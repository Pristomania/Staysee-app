import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { canonicalStringify } from './contracts.mjs';
import {
  buildLifecycleHistoryReviewPacket,
  runLifecycleHistoryBackfill,
} from './lifecycle-history-backfill-engine.ts';
import { prepareLifecycleHistoryBackfill } from './lifecycle-history-backfill-contract.ts';
import {
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';
import { importReviewedLifecycleHistory } from './lifecycle-history-backfill-import.ts';
import type { MemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import type { MemoryV3LifecycleReconcileRequest } from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IMPORT_ID = '99999999-9999-4999-8999-999999999999';
const REVIEWED_AT = '2026-09-21T12:00:00.000Z';
const SOURCE_CUTOFF = '2026-09-20T00:00:00.000Z';
const PRICE = {
  route: [{
    model: LIFECYCLE_HISTORY_PRIMARY_MODEL,
    inputUsdPerMillion: '0.75', outputUsdPerMillion: '3.75',
    observedAt: '2026-09-21T11:00:00.000Z',
    sourceUrl: 'https://openrouter.ai/api/v1/models/google/gemini-3.7-flash/endpoints',
    supportedParameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'],
    zdr: true,
  }, {
    model: LIFECYCLE_HISTORY_FALLBACK_MODEL,
    inputUsdPerMillion: '1.5', outputUsdPerMillion: '7.5',
    observedAt: '2026-09-21T11:00:00.000Z',
    sourceUrl: 'https://openrouter.ai/api/v1/models/mistralai/mistral-medium-3-5/endpoints',
    supportedParameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'],
    zdr: true,
  }],
} as const;

function prepared() {
  return prepareLifecycleHistoryBackfill({
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    snapshot: {
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      conversations: [{
        conversationId: '22222222-2222-4222-8222-222222222222',
        createdAt: '2026-09-10T10:00:00.000Z',
        messages: [{
          id: '33333333-3333-4333-8333-333333333333',
          role: 'user',
          text: 'Предпочитает спокойные прогулки вечером',
          createdAt: '2026-09-10T10:01:00.000Z',
        }],
      }],
    },
  });
}

async function fixture() {
  const freshPreparedSource = prepared();
  const benchmarkResult = await runLifecycleHistoryBackfill({
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    prepared: freshPreparedSource,
    priceSnapshot: PRICE,
    maxBudgetUsd: '1',
    nowMs: Date.parse('2026-09-21T12:00:00.000Z'),
    execute: true,
    extractorAdapter: async (request: MemoryV3ExtractorRequest) => {
      const message = request.input.messages[0];
      return {
        content: JSON.stringify({
          layerDecisions: [
            { kind: 'event', decision: 'emit', itemRefs: ['i1'] },
            { kind: 'recurrence', decision: 'omit', itemRefs: [] },
            { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
          ],
          items: [{
            itemRef: 'i1', kind: 'event', claim: message.text, status: 'active',
            sensitivity: 'normal', eventTimeStart: null, eventTimeEnd: null,
            alternative: null,
          }],
          evidence: [{
            itemRef: 'i1', sourceMessageId: message.id, relation: 'supports',
            supportType: null, episodeKey: `episode:${message.id}`,
          }],
        }),
        usage: null,
        resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      };
    },
    reconcilerAdapter: async (request: MemoryV3LifecycleReconcileRequest) => ({
      rawContent: JSON.stringify({
        operations: request.input.candidates.map((candidate) => ({
          type: 'create', candidateRef: candidate.candidateRef, targetMemoryRef: null,
        })),
      }),
      usage: null,
      resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
    }),
  });
  const semanticReviewPacket = buildLifecycleHistoryReviewPacket(benchmarkResult);
  const artifact = JSON.parse(JSON.stringify({ benchmarkResult, semanticReviewPacket }));
  const reviewDecision = {
    schemaVersion: 'memory-v3-lifecycle-history-review-v1',
    payloadSha256: semanticReviewPacket.payloadSha256,
    verdict: 'PASS',
    reviewedAt: REVIEWED_AT,
    reviewer: 'Nastya',
    items: semanticReviewPacket.items.map((item) => ({
      memoryKey: item.memoryKey,
      semanticVerdict: 'PASS',
      reviewerNotes: null,
    })),
  };
  return { artifact, reviewDecision, freshPreparedSource };
}

type MutableReview = {
  verdict: string;
  reviewer: string;
  reviewedAt: string;
  items: Array<{ semanticVerdict: string; reviewerNotes: string | null }>;
};

type MutableFresh = {
  manifest: {
    sourceSnapshotDigest: string;
    sourceCutoff: string;
    profileId: string;
    chunkCount: number;
  };
};

type MutableProvenanceResult = {
  modelRoute: string[];
  priceSnapshot: { route: unknown[] } | Record<string, unknown>;
  chunks: Array<{ extractorResolvedModel: string }>;
  resolvedModelCounts: { primary: number; fallback: number };
  providerModelFallbackCount: number;
};

function clientFor(stateRevision: number) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async loadCurrentHead(userId: string) {
        assert.equal(userId, USER_ID);
        return { stateRevision: 0, itemCount: 0 };
      },
      async importInitialState(input: unknown) {
        calls.push(input);
        return { result: 'succeeded', resultingStateRevision: stateRevision };
      },
    },
  };
}

async function invoke(overrides: Record<string, unknown> = {}) {
  const data = await fixture();
  const stateRevision = data.artifact.benchmarkResult.finalState.stateRevision;
  const fake = clientFor(stateRevision);
  const input = {
    ...data,
    userId: USER_ID,
    importId: IMPORT_ID,
    client: fake.client,
    ...overrides,
  };
  return { data, fake, input, result: await importReviewedLifecycleHistory(input) };
}

describe('reviewed lifecycle history import', () => {
  it('imports one digest-bound reviewed state with exact RPC fields', async () => {
    const { data, fake, result } = await invoke();
    assert.equal(fake.calls.length, 1);
    const rpc = fake.calls[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(rpc).sort(), [
      'artifactDigest', 'expectedStateRevision', 'extractorVersion', 'importId',
      'pipelineVersion', 'profileId', 'reconcilerVersion', 'sourceCutoff',
      'sourceSnapshotDigest', 'state', 'userId',
    ].sort());
    assert.equal(rpc.expectedStateRevision, 0);
    assert.equal(rpc.userId, USER_ID);
    assert.equal(rpc.importId, IMPORT_ID);
    assert.equal(rpc.artifactDigest, data.reviewDecision.payloadSha256);
    assert.equal(rpc.sourceSnapshotDigest, data.freshPreparedSource.manifest.sourceSnapshotDigest);
    assert.deepEqual(result, {
      status: 'succeeded',
      artifactDigest: data.reviewDecision.payloadSha256,
      sourceSnapshotDigest: data.freshPreparedSource.manifest.sourceSnapshotDigest,
      resultingStateRevision: data.artifact.benchmarkResult.finalState.stateRevision,
      itemCount: 1,
      evidenceCount: 1,
    });
  });

  it('recomputes the canonical payload digest and rejects artifact tampering before mutation', async () => {
    const data = await fixture();
    data.artifact.benchmarkResult.manifest.messageCount += 1;
    const fake = clientFor(data.artifact.benchmarkResult.finalState.stateRevision);
    await assert.rejects(() => importReviewedLifecycleHistory({
      ...data, userId: USER_ID, importId: IMPORT_ID, client: fake.client,
    }), /\[memory-v3:lifecycle-history-backfill-import\]/u);
    assert.equal(fake.calls.length, 0);
  });

  it('rejects a digest-consistent but structurally incomplete successful artifact', async () => {
    const data = await fixture();
    delete data.artifact.benchmarkResult.model;
    data.artifact.benchmarkResult.chunks = [null];
    const payloadSha256 = createHash('sha256').update(canonicalStringify({
      benchmarkResult: data.artifact.benchmarkResult,
      items: data.artifact.semanticReviewPacket.items,
    }), 'utf8').digest('hex');
    data.artifact.semanticReviewPacket.payloadSha256 = payloadSha256;
    data.reviewDecision.payloadSha256 = payloadSha256;
    const fake = clientFor(data.artifact.benchmarkResult.finalState.stateRevision);
    await assert.rejects(() => importReviewedLifecycleHistory({
      ...data, userId: USER_ID, importId: IMPORT_ID, client: fake.client,
    }));
    assert.equal(fake.calls.length, 0);
  });

  it('recomputes and rejects invalid route, per-chunk provenance, and aggregate counts before RPC', async () => {
    const mutations = [
      (result: MutableProvenanceResult) => { result.modelRoute.reverse(); },
      (result: MutableProvenanceResult) => {
        (result.priceSnapshot as { route: unknown[] }).route.reverse();
      },
      (result: MutableProvenanceResult) => {
        (result.priceSnapshot as { route: unknown[] }).route.pop();
      },
      (result: MutableProvenanceResult) => {
        result.priceSnapshot = {
          model: LIFECYCLE_HISTORY_PRIMARY_MODEL,
          inputUsdPerMillion: '0.75',
          outputUsdPerMillion: '3.75',
          observedAt: '2026-09-21T11:00:00.000Z',
          sourceUrl: 'https://openrouter.ai/google/gemini-3.7-flash',
        };
      },
      (result: MutableProvenanceResult) => {
        result.chunks[0].extractorResolvedModel = 'unknown-model';
      },
      (result: MutableProvenanceResult) => { result.resolvedModelCounts.primary += 1; },
      (result: MutableProvenanceResult) => { result.providerModelFallbackCount += 1; },
    ];
    for (const mutate of mutations) {
      const data = await fixture();
      mutate(data.artifact.benchmarkResult as MutableProvenanceResult);
      const payloadSha256 = createHash('sha256').update(canonicalStringify({
        benchmarkResult: data.artifact.benchmarkResult,
        items: data.artifact.semanticReviewPacket.items,
      }), 'utf8').digest('hex');
      data.artifact.semanticReviewPacket.payloadSha256 = payloadSha256;
      data.reviewDecision.payloadSha256 = payloadSha256;
      let headCalls = 0;
      let rpcCalls = 0;
      await assert.rejects(() => importReviewedLifecycleHistory({
        ...data,
        userId: USER_ID,
        importId: IMPORT_ID,
        client: {
          async loadCurrentHead() { headCalls += 1; return { stateRevision: 0, itemCount: 0 }; },
          async importInitialState() { rpcCalls += 1; return {}; },
        },
      }));
      assert.equal(headCalls, 0);
      assert.equal(rpcCalls, 0);
    }
  });

  it('requires a PASS by Nastya at a valid timestamp and exact ordered item coverage', async () => {
    for (const mutate of [
      (review: MutableReview) => { review.verdict = 'FAIL'; },
      (review: MutableReview) => { review.reviewer = 'Someone'; },
      (review: MutableReview) => { review.reviewedAt = 'not-a-date'; },
      (review: MutableReview) => { review.reviewedAt = '2026-02-31T12:00:00.000Z'; },
      (review: MutableReview) => { review.items = []; },
      (review: MutableReview) => { review.items.push(structuredClone(review.items[0])); },
      (review: MutableReview) => { review.items[0].semanticVerdict = 'FAIL'; },
      (review: MutableReview) => { review.items[0].reviewerNotes = 'x'.repeat(1001); },
    ]) {
      const data = await fixture();
      mutate(data.reviewDecision as MutableReview);
      const fake = clientFor(data.artifact.benchmarkResult.finalState.stateRevision);
      await assert.rejects(() => importReviewedLifecycleHistory({
        ...data, userId: USER_ID, importId: IMPORT_ID, client: fake.client,
      }));
      assert.equal(fake.calls.length, 0);
    }
  });

  it('rejects a stale source digest, cutoff, profile, or chunk count before loading the head', async () => {
    for (const mutate of [
      (fresh: MutableFresh) => { fresh.manifest.sourceSnapshotDigest = '0'.repeat(64); },
      (fresh: MutableFresh) => { fresh.manifest.sourceCutoff = '2026-09-19T00:00:00.000Z'; },
      (fresh: MutableFresh) => { fresh.manifest.profileId = 'wrong'; },
      (fresh: MutableFresh) => { fresh.manifest.chunkCount += 1; },
    ]) {
      const data = await fixture();
      const fresh = structuredClone(data.freshPreparedSource);
      mutate(fresh as MutableFresh);
      let headCalls = 0;
      await assert.rejects(() => importReviewedLifecycleHistory({
        artifact: data.artifact,
        reviewDecision: data.reviewDecision,
        freshPreparedSource: fresh,
        userId: USER_ID,
        importId: IMPORT_ID,
        client: {
          async loadCurrentHead() { headCalls += 1; return { stateRevision: 0, itemCount: 0 }; },
          async importInitialState() { throw new Error('must not mutate'); },
        },
      }));
      assert.equal(headCalls, 0);
    }
  });

  it('binds the fresh manifest to the actual fresh chunk messages', async () => {
    const data = await fixture();
    const fresh = structuredClone(data.freshPreparedSource);
    fresh.chunks[0].messages[0].text = 'stale or fabricated dialogue';
    let headCalls = 0;
    await assert.rejects(() => importReviewedLifecycleHistory({
      artifact: data.artifact,
      reviewDecision: data.reviewDecision,
      freshPreparedSource: fresh,
      userId: USER_ID,
      importId: IMPORT_ID,
      client: {
        async loadCurrentHead() { headCalls += 1; return { stateRevision: 0, itemCount: 0 }; },
        async importInitialState() { throw new Error('must not mutate'); },
      },
    }));
    assert.equal(headCalls, 0);
  });

  it('requires an empty revision-zero head and validates the single RPC response', async () => {
    const data = await fixture();
    for (const head of [
      { stateRevision: 1, itemCount: 0 },
      { stateRevision: 0, itemCount: 1 },
      { stateRevision: 0 },
    ]) {
      let importCalls = 0;
      await assert.rejects(() => importReviewedLifecycleHistory({
        ...data, userId: USER_ID, importId: IMPORT_ID,
        client: {
          async loadCurrentHead() { return head; },
          async importInitialState() { importCalls += 1; return {}; },
        },
      }));
      assert.equal(importCalls, 0);
    }

    let calls = 0;
    await assert.rejects(() => importReviewedLifecycleHistory({
      ...data, userId: USER_ID, importId: IMPORT_ID,
      client: {
        async loadCurrentHead() { return { stateRevision: 0, itemCount: 0 }; },
        async importInitialState() { calls += 1; return { result: 'wrong', resultingStateRevision: 1 }; },
      },
    }));
    assert.equal(calls, 1);
  });

  it('does not mutate artifact, decision, or fresh prepared source', async () => {
    const data = await fixture();
    const before = canonicalStringify(data);
    const fake = clientFor(data.artifact.benchmarkResult.finalState.stateRevision);
    await importReviewedLifecycleHistory({
      ...data, userId: USER_ID, importId: IMPORT_ID, client: fake.client,
    });
    assert.equal(canonicalStringify(data), before);
  });

  it('does not trust a spoofed branded client error or leak its sentinel', async () => {
    const data = await fixture();
    const spoof = new Error('[memory-v3:lifecycle-history-backfill-import] import failed');
    spoof.name = 'MemoryV3LifecycleHistoryBackfillImportError';
    Object.defineProperty(spoof, 'cause', { value: 'RAW_CLIENT_SENTINEL', enumerable: true });
    let thrown: unknown;
    try {
      await importReviewedLifecycleHistory({
        ...data, userId: USER_ID, importId: IMPORT_ID,
        client: {
          async loadCurrentHead() { throw spoof; },
          async importInitialState() { throw new Error('must not run'); },
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.notEqual(thrown, spoof);
    assert.equal(Object.hasOwn(thrown as object, 'cause'), false);
    assert.equal(JSON.stringify(thrown).includes('RAW_CLIENT_SENTINEL'), false);
  });

  it('keeps provider, fetch, env, fs, and raw-dialogue dependencies out of the library', () => {
    const source = readFileSync(new URL('./lifecycle-history-backfill-import.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(openrouter|transport)|fetch\s*\(|process\.env|node:fs|@supabase\/supabase-js/iu);
    assert.equal(
      createHash('sha256').update('source-lock-v1').digest('hex').length,
      64,
    );
  });
});
