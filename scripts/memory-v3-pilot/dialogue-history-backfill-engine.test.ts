import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildDialogueHistoryReviewPacket,
  runDialogueHistoryBackfill,
} from './dialogue-history-backfill-engine.ts';
import {
  prepareDialogueHistoryBackfill,
  type PreparedDialogueHistoryBackfill,
} from './dialogue-history-backfill-contract.ts';
import {
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';
import { canonicalStringify } from './contracts.mjs';
import { validateMemoryV3Dialogue } from '../../supabase/functions/_shared/memoryV3/contract.ts';
import {
  buildMemoryV3ExtractorRequest,
  type MemoryV3ExtractorRequest,
} from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import type { MemoryV3DialogueMessage } from '../../supabase/functions/_shared/memoryV3/messages.ts';
import type { MemoryV3DialogueReconcileRequest } from '../../supabase/functions/_shared/memoryV3/dialoguePrompt.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW_MS = Date.parse('2026-09-22T12:00:00.000Z');
const PRICE = {
  route: [{
    model: LIFECYCLE_HISTORY_PRIMARY_MODEL,
    inputUsdPerMillion: '0.75', outputUsdPerMillion: '3.75',
    observedAt: '2026-09-22T11:00:00.000Z',
    sourceUrl: 'https://openrouter.ai/api/v1/models/google/gemini-3.7-flash/endpoints',
    supportedParameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'],
    zdr: true,
  }, {
    model: LIFECYCLE_HISTORY_FALLBACK_MODEL,
    inputUsdPerMillion: '1.5', outputUsdPerMillion: '7.5',
    observedAt: '2026-09-22T11:00:00.000Z',
    sourceUrl: 'https://openrouter.ai/api/v1/models/mistralai/mistral-medium-3-5/endpoints',
    supportedParameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs'],
    zdr: true,
  }],
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

function syntheticUuid(index: number): string {
  const tail = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

function prepared(count = 2): PreparedDialogueHistoryBackfill {
  return prepareDialogueHistoryBackfill({
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

function revisionsFor(
  preparedValue: { chunks: ReadonlyArray<{ conversationId: string }> },
  overrides: Record<string, number> = {},
): Map<string, number> {
  const map = new Map<string, number>();
  for (const chunk of preparedValue.chunks) {
    if (!map.has(chunk.conversationId)) {
      map.set(chunk.conversationId, overrides[chunk.conversationId] ?? 0);
    }
  }
  return map;
}

function options(overrides: Record<string, unknown> = {}) {
  const preparedValue = (overrides.prepared as PreparedDialogueHistoryBackfill | undefined) ?? prepared();
  return {
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    priceSnapshot: PRICE,
    maxBudgetUsd: '1',
    nowMs: NOW_MS,
    execute: false,
    prepared: preparedValue,
    conversationRevisions: revisionsFor(preparedValue),
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

function createAllOperations() {
  return async (request: MemoryV3DialogueReconcileRequest) => ({
    rawContent: JSON.stringify({
      operations: request.input.candidates.map((candidate) => ({
        type: 'create',
        candidateRef: candidate.candidateRef,
        targetMemoryRef: null,
        topic: 'fact',
      })),
    }),
    usage: null,
    resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
  });
}

function msg(id: string, createdAt: string, text: string, role: 'user' | 'assistant' = 'user'): MemoryV3DialogueMessage {
  return { id, role, text, createdAt };
}

function requestBytesFor(userId: string, conversationId: string, messages: MemoryV3DialogueMessage[]): number {
  const dialogue = validateMemoryV3Dialogue({
    caseId: `memory-v3-shadow:${userId}:${conversationId}`,
    messages,
  });
  return new TextEncoder().encode(
    JSON.stringify(buildMemoryV3ExtractorRequest(dialogue)),
  ).byteLength;
}

/** Text whose single-message extractor request lands exactly at the 40,000-byte cap. */
function textAtRequestByteCap(userId: string, conversationId: string, id: string, createdAt: string): string {
  const seed = msg(id, createdAt, 'x');
  const seedBytes = requestBytesFor(userId, conversationId, [seed]);
  assert.ok(seedBytes <= 40_000);
  return 'x'.repeat(1 + 40_000 - seedBytes);
}

/**
 * Builds two conversations, each split into exactly two chunks (a short message
 * then a message engineered to sit exactly at the 40,000-byte extractor request
 * cap, forcing a chunk boundary). Their timestamps are arranged so the prepared,
 * globally time-sorted `chunks` array naturally interleaves as
 * [A-chunk0, B-chunk0, A-chunk1, B-chunk1] -- this is what real production data
 * looks like once two conversations' histories are merged into one time-sorted
 * feed, not an artificial reordering.
 */
function buildInterleavedTwoConversationFixture(): {
  prepared: PreparedDialogueHistoryBackfill;
  conversationAId: string;
  conversationBId: string;
  claimByMessageId: Map<string, string>;
} {
  const userId = syntheticUuid(1);
  const conversationAId = syntheticUuid(1_001);
  const conversationBId = syntheticUuid(1_002);
  const shortAId = syntheticUuid(2_001);
  const longAId = syntheticUuid(2_002);
  const shortBId = syntheticUuid(2_003);
  const longBId = syntheticUuid(2_004);

  const longAText = textAtRequestByteCap(userId, conversationAId, longAId, '2026-09-10T10:02:00.000Z');
  const longBText = textAtRequestByteCap(userId, conversationBId, longBId, '2026-09-10T10:03:00.000Z');

  const preparedValue = prepareDialogueHistoryBackfill({
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    snapshot: {
      userId,
      sourceCutoff: '2026-09-20T00:00:00.000Z',
      conversations: [
        {
          conversationId: conversationAId,
          createdAt: '2026-09-10T09:00:00.000Z',
          messages: [
            msg(shortAId, '2026-09-10T10:00:00.000Z', 'a-short'),
            msg(longAId, '2026-09-10T10:02:00.000Z', longAText),
          ],
        },
        {
          conversationId: conversationBId,
          createdAt: '2026-09-10T09:00:00.000Z',
          messages: [
            msg(shortBId, '2026-09-10T10:01:00.000Z', 'b-short'),
            msg(longBId, '2026-09-10T10:03:00.000Z', longBText),
          ],
        },
      ],
    },
  });

  // Sanity-check the fixture actually interleaves before trusting it to prove anything.
  assert.equal(preparedValue.chunks.length, 4);
  assert.deepEqual(
    preparedValue.chunks.map((chunk) => chunk.conversationId),
    [conversationAId, conversationBId, conversationAId, conversationBId],
  );

  const claimByMessageId = new Map([
    [shortAId, 'A-first'],
    [longAId, 'A-second'],
    [shortBId, 'B-first'],
    [longBId, 'B-second'],
  ]);

  return { prepared: preparedValue, conversationAId, conversationBId, claimByMessageId };
}

function claimExtractorAdapter(claimByMessageId: Map<string, string>) {
  return async (request: MemoryV3ExtractorRequest) => {
    const messageId = request.input.messages[0].id;
    const claim = claimByMessageId.get(messageId);
    assert.ok(claim, `no claim registered for message ${messageId}`);
    return {
      content: JSON.stringify({
        layerDecisions: [
          { kind: 'event', decision: 'emit', itemRefs: ['i1'] },
          { kind: 'recurrence', decision: 'omit', itemRefs: [] },
          { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
        ],
        items: [{
          itemRef: 'i1',
          kind: 'event',
          claim,
          status: 'active',
          sensitivity: 'normal',
          eventTimeStart: null,
          eventTimeEnd: null,
          alternative: null,
        }],
        evidence: [{
          itemRef: 'i1',
          sourceMessageId: messageId,
          relation: 'supports',
          supportType: null,
          episodeKey: `episode:${messageId}`,
        }],
      }),
      usage: null,
      resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
    };
  };
}

describe('Memory V3 dialogue history backfill engine', () => {
  it('validates a dry run and preserves its exact price and budget without adapters or per-conversation work', async () => {
    const result = await runDialogueHistoryBackfill(options({
      extractorAdapter: 'INVALID_ADAPTER',
      reconcilerAdapter: 'INVALID_ADAPTER',
    }) as never);
    assert.equal(result.execute, false);
    assert.equal(result.providerCallCount, 0);
    assert.deepEqual(result.conversations, []);
    assert.deepEqual(result.resolvedModelCounts, { primary: 0, fallback: 0 });
    assert.deepEqual(result.modelRoute, [
      LIFECYCLE_HISTORY_PRIMARY_MODEL,
      LIFECYCLE_HISTORY_FALLBACK_MODEL,
    ]);
    assert.deepEqual(result.priceSnapshot, PRICE);
    assert.deepEqual(result.budget, {
      maxRequests: 4,
      reservedInputTokensPerCall: 32_768,
      maxOutputTokensPerCall: 4_096,
      ceilingUsd: '0.319488',
      hardMaxUsd: '1',
      gate: 'PASS',
    });
  });

  it('runs each conversation independently, threading its own expectedStateRevision and sharing the provider-call budget across the whole run', async () => {
    const preparedValue = prepared(2);
    const firstConversationId = preparedValue.chunks[0].conversationId;
    const secondConversationId = preparedValue.chunks[1].conversationId;
    const revisions = new Map([
      [firstConversationId, 7],
      [secondConversationId, 0],
    ]);
    const result = await runDialogueHistoryBackfill({
      profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      prepared: preparedValue,
      priceSnapshot: PRICE,
      maxBudgetUsd: '1',
      nowMs: NOW_MS,
      execute: true,
      conversationRevisions: revisions,
      extractorAdapter: async (request: MemoryV3ExtractorRequest) => ({
        content: eventRaw(request),
        usage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 },
        resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      }),
      reconcilerAdapter: async (request: MemoryV3DialogueReconcileRequest) => ({
        rawContent: JSON.stringify({
          operations: request.input.candidates.map((candidate) => ({
            type: 'create',
            candidateRef: candidate.candidateRef,
            targetMemoryRef: null,
            topic: 'fact',
          })),
        }),
        usage: { promptTokens: 20, completionTokens: 3, costUsd: 0.002 },
        resolvedModel: LIFECYCLE_HISTORY_FALLBACK_MODEL,
      }),
    });

    assert.equal(result.conversations.length, 2);
    assert.equal(result.providerCallCount, 4);
    assert.deepEqual(result.resolvedModelCounts, { primary: 2, fallback: 2 });
    assert.deepEqual(result.actualUsage, { promptTokens: 60, completionTokens: 10 });

    const [convFirst, convSecond] = result.conversations;
    assert.equal(convFirst.conversationId, firstConversationId);
    assert.equal(convFirst.conversationOrdinal, 0);
    assert.equal(convFirst.expectedStateRevision, 7);
    assert.equal(convFirst.finalState?.items.length, 1);
    assert.equal(convFirst.finalState?.items[0].claim, 'remember-0');
    assert.equal(convFirst.finalState?.stateRevision, 1);

    assert.equal(convSecond.conversationId, secondConversationId);
    assert.equal(convSecond.conversationOrdinal, 1);
    assert.equal(convSecond.expectedStateRevision, 0);
    assert.equal(convSecond.finalState?.items.length, 1);
    assert.equal(convSecond.finalState?.items[0].claim, 'remember-1');
    assert.equal(convSecond.finalState?.stateRevision, 1);
  });

  it("keeps two conversations' states fully independent even when their chunks are interleaved in the input array", async () => {
    const { prepared: preparedValue, conversationAId, conversationBId, claimByMessageId } =
      buildInterleavedTwoConversationFixture();
    const result = await runDialogueHistoryBackfill({
      profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      prepared: preparedValue,
      priceSnapshot: PRICE,
      maxBudgetUsd: '1',
      nowMs: NOW_MS,
      execute: true,
      conversationRevisions: new Map([[conversationAId, 0], [conversationBId, 0]]),
      extractorAdapter: claimExtractorAdapter(claimByMessageId),
      reconcilerAdapter: createAllOperations(),
    });

    assert.equal(result.conversations.length, 2);
    const convA = result.conversations.find((row) => row.conversationId === conversationAId);
    const convB = result.conversations.find((row) => row.conversationId === conversationBId);
    assert.ok(convA);
    assert.ok(convB);

    assert.equal(convA.attemptedChunkCount, 2);
    assert.equal(convA.failureCount, 0);
    assert.deepEqual(
      convA.finalState?.items.map((item) => item.claim).sort(),
      ['A-first', 'A-second'],
    );

    assert.equal(convB.attemptedChunkCount, 2);
    assert.equal(convB.failureCount, 0);
    assert.deepEqual(
      convB.finalState?.items.map((item) => item.claim).sort(),
      ['B-first', 'B-second'],
    );

    // The decisive proof of isolation: neither conversation's final memory
    // contains any trace of the other conversation's claims.
    assert.equal(convA.finalState?.items.some((item) => item.claim.startsWith('B-')), false);
    assert.equal(convB.finalState?.items.some((item) => item.claim.startsWith('A-')), false);
  });

  it('fails only the affected conversation, letting other conversations complete normally', async () => {
    const preparedValue = prepared(2);
    const [chunkA, chunkB] = preparedValue.chunks;
    const revisions = new Map([
      [chunkA.conversationId, 0],
      [chunkB.conversationId, 3],
    ]);
    const result = await runDialogueHistoryBackfill({
      profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      prepared: preparedValue,
      priceSnapshot: PRICE,
      maxBudgetUsd: '1',
      nowMs: NOW_MS,
      execute: true,
      conversationRevisions: revisions,
      extractorAdapter: async (request: MemoryV3ExtractorRequest) => {
        if (request.input.messages[0].id === chunkA.messages[0].id) {
          return { content: 'NOT_JSON{', usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL };
        }
        return { content: JSON.stringify(OMIT), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL };
      },
      reconcilerAdapter: async () => ({
        rawContent: JSON.stringify({ operations: [] }),
        usage: null,
        resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      }),
    });

    const convA = result.conversations.find((row) => row.conversationId === chunkA.conversationId)!;
    const convB = result.conversations.find((row) => row.conversationId === chunkB.conversationId)!;
    assert.equal(convA.failureCount, 1);
    assert.equal(convA.failures[0].stage, 'extractor_parse');
    assert.equal(convA.finalState, null);

    assert.equal(convB.failureCount, 0);
    assert.notEqual(convB.finalState, null);
    assert.equal(convB.expectedStateRevision, 3);
  });

  it('throws and aborts the whole run if conversationRevisions is missing an entry for a conversation present in the chunks', async () => {
    const preparedValue = prepared(2);
    const firstConversationId = preparedValue.chunks[0].conversationId;
    const secondConversationId = preparedValue.chunks[1].conversationId;
    assert.notEqual(firstConversationId, secondConversationId);
    let extractorCalls = 0;
    let reconcilerCalls = 0;
    await assert.rejects(
      () => runDialogueHistoryBackfill({
        profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
        prepared: preparedValue,
        priceSnapshot: PRICE,
        maxBudgetUsd: '1',
        nowMs: NOW_MS,
        execute: true,
        // Deliberately missing the FIRST conversation's revision entry.
        conversationRevisions: new Map([[secondConversationId, 0]]),
        extractorAdapter: async () => {
          extractorCalls += 1;
          return { content: JSON.stringify(OMIT), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL };
        },
        reconcilerAdapter: async () => {
          reconcilerCalls += 1;
          return { rawContent: JSON.stringify({ operations: [] }), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL };
        },
      }),
      /\[memory-v3:dialogue-history-backfill-engine\] operation failed/u,
    );
    // The whole run must abort before doing ANY per-chunk work -- not silently
    // skip the affected conversation and keep going.
    assert.equal(extractorCalls, 0);
    assert.equal(reconcilerCalls, 0);
  });

  // NOTE: the plan's review focus also asks for "fails only the affected
  // conversation when one conversation has no user messages, not the whole
  // run". That specific trigger (an all-assistant conversation) is rejected at
  // PREPARATION time, inside prepareDialogueHistoryBackfill's chunker
  // (dialogue-history-backfill-contract.ts's chunkOneConversation), before
  // this engine ever runs -- see "requires a user message in every chunk and
  // fails on an unusable assistant prefix" in
  // dialogue-history-backfill-contract.test.ts, which already documents that
  // a single bad conversation aborts the whole batch at the preparation
  // stage. The general "one conversation's mid-run failure does not affect
  // others" behavior this engine DOES have is covered above instead.

  it('rejects a non-Map conversationRevisions value without touching adapters', async () => {
    let calls = 0;
    await assert.rejects(() => runDialogueHistoryBackfill({
      profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      prepared: prepared(1),
      priceSnapshot: PRICE,
      maxBudgetUsd: '1',
      nowMs: NOW_MS,
      execute: true,
      conversationRevisions: { notAMap: true } as never,
      extractorAdapter: async () => {
        calls += 1;
        return { content: JSON.stringify(OMIT), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL };
      },
      reconcilerAdapter: async () => {
        calls += 1;
        return { rawContent: JSON.stringify({ operations: [] }), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL };
      },
    }));
    assert.equal(calls, 0);
  });

  it('requires conversationRevisions and both adapters only after source and budget preflight', async () => {
    await assert.rejects(() => runDialogueHistoryBackfill(options({
      execute: true,
      prepared: { ...prepared(), chunks: [] },
    }) as never), /\[memory-v3:dialogue-history-backfill-engine\]/u);
    await assert.rejects(() => runDialogueHistoryBackfill(options({ execute: true }) as never));
  });

  it('builds a review packet that flattens conversations, tags each item with conversationId, and is digest-bound', async () => {
    const preparedValue = prepared(2);
    const revisions = revisionsFor(preparedValue);
    const result = await runDialogueHistoryBackfill({
      profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      prepared: preparedValue,
      priceSnapshot: PRICE,
      maxBudgetUsd: '1',
      nowMs: NOW_MS,
      execute: true,
      conversationRevisions: revisions,
      extractorAdapter: async (request: MemoryV3ExtractorRequest) => ({
        content: eventRaw(request),
        usage: null,
        resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      }),
      reconcilerAdapter: createAllOperations(),
    });

    const packet = buildDialogueHistoryReviewPacket(result);
    assert.equal(packet.items.length, 2);
    assert.deepEqual(
      packet.items.map((item) => item.conversationId).sort(),
      [preparedValue.chunks[0].conversationId, preparedValue.chunks[1].conversationId].sort(),
    );
    assert.match(packet.payloadSha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      packet.payloadSha256,
      createHash('sha256')
        .update(canonicalStringify({ benchmarkResult: result, items: packet.items }), 'utf8')
        .digest('hex'),
    );

    const mutatedItems = structuredClone(packet.items);
    mutatedItems[0].claim = 'mutated claim';
    assert.notEqual(
      packet.payloadSha256,
      createHash('sha256')
        .update(canonicalStringify({ benchmarkResult: result, items: mutatedItems }), 'utf8')
        .digest('hex'),
    );
  });

  it('refuses to build a review packet while any conversation still has a failure', async () => {
    const preparedValue = prepared(2);
    const revisions = revisionsFor(preparedValue);
    const result = await runDialogueHistoryBackfill({
      profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      prepared: preparedValue,
      priceSnapshot: PRICE,
      maxBudgetUsd: '1',
      nowMs: NOW_MS,
      execute: true,
      conversationRevisions: revisions,
      extractorAdapter: async () => ({
        content: 'NOT_JSON{',
        usage: null,
        resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      }),
      reconcilerAdapter: async () => ({
        rawContent: JSON.stringify({ operations: [] }),
        usage: null,
        resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
      }),
    });
    assert.equal(result.conversations.every((row) => row.failureCount > 0), true);
    assert.throws(() => buildDialogueHistoryReviewPacket(result));
  });
});
