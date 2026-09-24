import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { validateMemoryV3Dialogue } from '../../supabase/functions/_shared/memoryV3/contract.ts';
import type { MemoryV3DialogueMessage } from '../../supabase/functions/_shared/memoryV3/messages.ts';
import { buildMemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import { canonicalStringify } from './contracts.mjs';
import {
  canonicalDialogueHistoryDigest,
  prepareDialogueHistoryBackfill,
} from './dialogue-history-backfill-contract.ts';

const PROFILE_ID = 'memory-v3-lifecycle-history-backfill-v1';
const SOURCE_CUTOFF = '2026-09-21T23:59:59.000Z';

function syntheticUuid(index: number): string {
  const tail = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 8, 20, 0, index, 0, 0)).toISOString();
}

function message(
  index: number,
  role: 'user' | 'assistant' = 'user',
  createdAt = timestamp(index),
  text = `synthetic-message-${index}`,
): MemoryV3DialogueMessage {
  return { id: syntheticUuid(10_000 + index), role, text, createdAt };
}

function conversation(
  index: number,
  messages: MemoryV3DialogueMessage[],
  createdAt = '2026-09-19T00:00:00.000Z',
) {
  return { conversationId: syntheticUuid(1_000 + index), createdAt, messages };
}

function snapshot(conversations: ReturnType<typeof conversation>[]) {
  return {
    userId: syntheticUuid(1),
    sourceCutoff: SOURCE_CUTOFF,
    conversations,
  };
}

function prepare(conversations: ReturnType<typeof conversation>[]) {
  return prepareDialogueHistoryBackfill({
    profileId: PROFILE_ID,
    snapshot: snapshot(conversations),
  });
}

function requestBytes(
  userId: string,
  conversationId: string,
  messages: MemoryV3DialogueMessage[],
): number {
  const dialogue = validateMemoryV3Dialogue({
    caseId: `memory-v3-shadow:${userId}:${conversationId}`,
    messages,
  });
  return new TextEncoder().encode(
    JSON.stringify(buildMemoryV3ExtractorRequest(dialogue)),
  ).byteLength;
}

function textForExactRequestBytes(
  targetBytes: number,
  userId: string,
  conversationId: string,
  prefix: MemoryV3DialogueMessage[],
  finalIndex: number,
): string {
  const seed = message(finalIndex, 'user', timestamp(finalIndex), 'x');
  const seedBytes = requestBytes(userId, conversationId, [...prefix, seed]);
  assert.ok(seedBytes <= targetBytes);
  return 'x'.repeat(1 + targetBytes - seedBytes);
}

function captureContractError(operation: () => unknown): Error {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, 'MemoryV3DialogueHistoryBackfillContractError');
  assert.equal(
    thrown.message,
    '[memory-v3:dialogue-history-backfill-contract] source is invalid',
  );
  assert.equal(Object.hasOwn(thrown, 'cause'), false);
  return thrown;
}

describe('history source validation and canonicalization', () => {
  it('does not mutate source objects and returns a deeply frozen detached result', () => {
    const input = snapshot([conversation(1, [message(1), message(2, 'assistant')])]);
    const before = JSON.stringify(input);
    const result = prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: input });

    assert.equal(JSON.stringify(input), before);
    assert.notEqual(result.chunks[0].messages, input.conversations[0].messages);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.manifest), true);
    assert.equal(Object.isFrozen(result.chunks), true);
    assert.equal(Object.isFrozen(result.chunks[0].messages), true);
  });

  it('sorts conversations by earliest message time then conversation ID', () => {
    const laterId = conversation(2, [message(20, 'user', timestamp(1))]);
    const earlierId = conversation(1, [message(10, 'user', timestamp(1))]);
    const earliest = conversation(3, [message(30, 'user', timestamp(0))]);
    const result = prepare([laterId, earlierId, earliest]);

    assert.deepEqual(
      result.manifest.conversations.map((row) => row.conversationOrdinal),
      [0, 1, 2],
    );
    const byOrdinal = [...result.chunks].sort(
      (left, right) => left.conversationOrdinal - right.conversationOrdinal,
    );
    assert.deepEqual(
      byOrdinal.map((chunk) => chunk.conversationId),
      [earliest.conversationId, earlierId.conversationId, laterId.conversationId],
    );
  });

  it('sorts messages by createdAt then ID using UTF-16 relational order', () => {
    const sameTime = timestamp(0);
    const high = message(11, 'user', sameTime);
    const low = message(10, 'assistant', sameTime);
    const later = message(12, 'user', timestamp(1));
    const result = prepare([conversation(1, [later, high, low])]);

    assert.deepEqual(
      result.chunks[0].messages.map((row) => row.id),
      [low.id, high.id, later.id],
    );
  });

  it('preserves sub-millisecond timestamp order before the message ID tie-break', () => {
    const earlier = message(
      11,
      'user',
      '2026-09-20T00:00:00.000100000Z',
    );
    const laterWithLowerId = message(
      10,
      'assistant',
      '2026-09-20T00:00:00.000900000Z',
    );
    const result = prepare([conversation(1, [laterWithLowerId, earlier])]);

    assert.deepEqual(
      result.chunks[0].messages.map((row) => row.id),
      [earlier.id, laterWithLowerId.id],
    );
  });

  it('rejects a source row even one nanosecond after the exact cutoff', () => {
    const input = snapshot([
      conversation(1, [
        message(1, 'user', '2026-09-21T23:59:59.000000001Z'),
      ]),
    ]);
    input.sourceCutoff = '2026-09-21T23:59:59.000000000Z';

    captureContractError(() =>
      prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: input })
    );
  });

  it('changes the source digest when role, text, ID, time, or conversation changes', () => {
    const baseMessages = [message(1), message(2, 'assistant')];
    const base = prepare([conversation(1, baseMessages)]).manifest.sourceSnapshotDigest;
    const variants = [
      [conversation(1, [{ ...baseMessages[0], role: 'assistant' as const }, { ...baseMessages[1], role: 'user' as const }])],
      [conversation(1, [{ ...baseMessages[0], text: 'changed' }, baseMessages[1]])],
      [conversation(1, [{ ...baseMessages[0], id: syntheticUuid(99_999) }, baseMessages[1]])],
      [conversation(1, [{ ...baseMessages[0], createdAt: timestamp(3) }, baseMessages[1]])],
      [{ ...conversation(1, baseMessages), conversationId: syntheticUuid(77_777) }],
    ];

    for (const variant of variants) {
      assert.notEqual(prepare(variant).manifest.sourceSnapshotDigest, base);
    }
  });

  it('skips a conversation with zero messages instead of failing the whole snapshot', () => {
    // A real production account (25.09.2026) has a conversation the person
    // opened but never sent a single message into. That conversation
    // carries nothing to extract, but under the old all-or-nothing
    // behavior it blocked every other real conversation in the account
    // from being processed at all.
    const real = conversation(1, [message(1), message(2, 'assistant')]);
    const empty = conversation(2, []);

    const result = prepare([real, empty]);

    assert.equal(result.manifest.conversationCount, 1);
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.conversationId),
      [real.conversationId],
    );
  });
});

describe('deterministic history chunk planning', () => {
  it('turns 61 short messages into two contiguous chunks', () => {
    const messages = Array.from({ length: 61 }, (_, index) =>
      message(index + 1, 'user', timestamp(index + 1), `m${index + 1}`)
    );
    const result = prepare([conversation(1, messages)]);

    assert.deepEqual(result.chunks.map((chunk) => chunk.messageCount), [60, 1]);
    assert.deepEqual(
      result.chunks.flatMap((chunk) => chunk.messages.map((row) => row.id)),
      messages.map((row) => row.id),
    );
    assert.deepEqual(result.chunks.map((chunk) => chunk.chunkOrdinal), [0, 1]);
  });

  it('preserves an unsplittable historical user message above the live request cap', () => {
    const userId = syntheticUuid(1);
    const conversationId = syntheticUuid(1_001);
    const exactText = textForExactRequestBytes(27_097, userId, conversationId, [], 1);
    const historicalMessage = message(1, 'user', timestamp(1), exactText);

    const result = prepare([conversation(1, [historicalMessage])]);

    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0].extractorRequestBytes, 27_097);
    assert.equal(result.chunks[0].messages[0].text, exactText);
  });

  it('selects the largest contiguous prefix at or below 40,000 bytes', () => {
    const userId = syntheticUuid(1);
    const conversationId = syntheticUuid(1_001);
    const first = message(1, 'user', timestamp(1), 'first');
    const secondText = textForExactRequestBytes(
      40_000,
      userId,
      conversationId,
      [first],
      2,
    );
    const second = message(2, 'user', timestamp(2), secondText);
    const third = message(3, 'user', timestamp(3), 'third');
    assert.equal(requestBytes(userId, conversationId, [first, second]), 40_000);
    assert.ok(requestBytes(userId, conversationId, [first, second, third]) > 40_000);

    const result = prepare([conversation(1, [first, second, third])]);
    assert.deepEqual(result.chunks.map((chunk) => chunk.messageCount), [2, 1]);
    assert.equal(result.chunks[0].extractorRequestBytes, 40_000);
  });

  it('accepts exactly 40,000 bytes and rejects a 40,001-byte single message', () => {
    const userId = syntheticUuid(1);
    const conversationId = syntheticUuid(1_001);
    const exactText = textForExactRequestBytes(40_000, userId, conversationId, [], 1);
    const exact = message(1, 'user', timestamp(1), exactText);
    assert.equal(prepare([conversation(1, [exact])]).chunks[0].extractorRequestBytes, 40_000);

    const oversized = message(1, 'user', timestamp(1), `${exactText}x`);
    assert.equal(requestBytes(userId, conversationId, [oversized]), 40_001);
    captureContractError(() => prepare([conversation(1, [oversized])]));
  });

  it('counts multibyte Unicode by UTF-8 bytes at the exact request boundary', () => {
    const userId = syntheticUuid(1);
    const conversationId = syntheticUuid(1_001);
    const unicodePrefix = 'я🙂'.repeat(100);
    const seed = message(1, 'user', timestamp(1), unicodePrefix);
    const seedBytes = requestBytes(userId, conversationId, [seed]);
    const exact = message(
      1,
      'user',
      timestamp(1),
      `${unicodePrefix}${'x'.repeat(40_000 - seedBytes)}`,
    );

    assert.equal(requestBytes(userId, conversationId, [exact]), 40_000);
    assert.equal(prepare([conversation(1, [exact])]).chunks[0].extractorRequestBytes, 40_000);
  });

  it('requires a user message in every chunk and fails on an unusable assistant prefix', () => {
    const user = message(1, 'user');
    const assistant = message(2, 'assistant');
    assert.ok(prepare([conversation(1, [assistant, user])]).chunks[0].userMessageCount > 0);
    captureContractError(() => prepare([conversation(1, [assistant])]));
  });

  it('drops a trailing assistant-only tail after at least one real chunk instead of failing the whole conversation', () => {
    // A real production run (25.09.2026) hit exactly this: a conversation
    // whose byte-size-forced chunk boundary leaves a lone trailing
    // assistant reply -- the normal "conversation is waiting for a
    // reply" state -- with no further user message. That must not fail
    // the whole conversation, unlike a conversation with zero user
    // engagement from the very start (the test above).
    const userId = syntheticUuid(1);
    const conversationId = syntheticUuid(1_001);
    const first = message(1, 'user', timestamp(1), 'first');
    const secondText = textForExactRequestBytes(40_000, userId, conversationId, [first], 2);
    const second = message(2, 'user', timestamp(2), secondText);
    const trailingAssistant = message(3, 'assistant', timestamp(3), 'hanging reply, no reply yet');
    assert.equal(requestBytes(userId, conversationId, [first, second]), 40_000);

    const result = prepare([conversation(1, [first, second, trailingAssistant])]);

    assert.equal(result.chunks.length, 1);
    assert.deepEqual(result.chunks[0].messages.map((row) => row.id), [first.id, second.id]);
    assert.equal(result.chunks[0].extractorRequestBytes, 40_000);

    // A real production run (25.09.2026) also hit this: the manifest's own
    // totals were computed from the raw 3-message conversation instead of
    // the 2-message chunk that actually survived the drop above, so the
    // manifest disagreed with the chunk it was supposed to describe.
    assert.equal(result.manifest.messageCount, 2);
    assert.equal(result.manifest.userMessageCount, 2);
    assert.equal(result.manifest.conversations[0].messageCount, 2);
    assert.equal(result.manifest.conversations[0].userMessageCount, 2);
    assert.equal(result.manifest.conversations[0].lastCreatedAt, second.createdAt);
  });

  it('still fails when a genuinely long assistant-only run separates two real user stretches', () => {
    // The size cap forces a chunk boundary right after `first`+`second`,
    // then the very next window has no user message within its own
    // maxMessagesPerChunk-sized reach even though `third` (a real user
    // message) exists further out -- this is the "implausibly long
    // assistant-only run in the middle" case the fix explicitly still
    // treats as a genuine anomaly, not a trailing tail to drop.
    const userId = syntheticUuid(1);
    const conversationId = syntheticUuid(1_001);
    const first = message(1, 'user', timestamp(1), 'first');
    const secondText = textForExactRequestBytes(40_000, userId, conversationId, [first], 2);
    const second = message(2, 'user', timestamp(2), secondText);
    const longAssistantRun = Array.from({ length: 60 }, (_, index) =>
      message(100 + index, 'assistant', timestamp(100 + index), `filler-${index}`)
    );
    const third = message(3, 'user', timestamp(200), 'third');

    captureContractError(() =>
      prepare([conversation(1, [first, second, ...longAssistantRun, third])])
    );
  });

  it('does not duplicate, omit, truncate, or move messages between conversations', () => {
    const firstMessages = Array.from({ length: 61 }, (_, index) =>
      message(index + 1, 'user', timestamp(index + 1), `first-${index + 1}`)
    );
    const secondMessages = [
      message(101, 'user', timestamp(101), 'second-1'),
      message(102, 'assistant', timestamp(102), 'second-2'),
    ];
    const firstConversation = conversation(1, firstMessages);
    const secondConversation = conversation(2, secondMessages);
    const result = prepare([secondConversation, firstConversation]);

    for (const source of [firstConversation, secondConversation]) {
      const actual = result.chunks
        .filter((chunk) => chunk.conversationId === source.conversationId)
        .sort((left, right) => left.chunkOrdinal - right.chunkOrdinal)
        .flatMap((chunk) => chunk.messages);
      assert.deepEqual(actual, source.messages);
    }
    const allIds = result.chunks.flatMap((chunk) => chunk.messages.map((row) => row.id));
    assert.equal(new Set(allIds).size, firstMessages.length + secondMessages.length);
  });

  it('orders chunks globally by last time, last ID, conversation ordinal, and chunk ordinal', () => {
    const longConversation = conversation(1, [
      message(1, 'user', timestamp(0)),
      message(2, 'user', timestamp(10)),
    ]);
    const shortConversation = conversation(2, [message(3, 'user', timestamp(5))]);
    const result = prepare([longConversation, shortConversation]);

    assert.deepEqual(
      result.chunks.map((chunk) => chunk.conversationId),
      [shortConversation.conversationId, longConversation.conversationId],
    );
    assert.deepEqual(result.chunks.map((chunk) => chunk.conversationOrdinal), [1, 0]);

    const sameTime = timestamp(20);
    const higherLastId = conversation(1, [message(20, 'user', sameTime)]);
    const lowerLastId = conversation(2, [message(19, 'user', sameTime)]);
    const tied = prepare([higherLastId, lowerLastId]);
    assert.deepEqual(
      tied.chunks.map((chunk) => chunk.lastMessageId),
      [lowerLastId.messages[0].id, higherLastId.messages[0].id],
    );
  });
});

describe('history digests and public manifest', () => {
  it('hashes the exact extractor request bytes and changes with the request', () => {
    const source = snapshot([conversation(1, [message(1), message(2, 'assistant')])]);
    const prepared = prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: source });
    const chunk = prepared.chunks[0];
    const dialogue = validateMemoryV3Dialogue({
      caseId: `memory-v3-shadow:${source.userId}:${chunk.conversationId}`,
      messages: chunk.messages,
    });
    const serialized = JSON.stringify(buildMemoryV3ExtractorRequest(dialogue));
    const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');
    assert.equal(chunk.extractorRequestSha256, expected);

    const changed = prepare([conversation(1, [message(1, 'user', timestamp(1), 'changed')])]);
    assert.notEqual(changed.chunks[0].extractorRequestSha256, chunk.extractorRequestSha256);
  });

  it('keeps identifiers and text out of the manifest while retaining trusted IDs in memory', () => {
    const source = snapshot([conversation(1, [message(1, 'user', timestamp(1), 'PRIVATE_TEXT')])]);
    const prepared = prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: source });
    const publicJson = JSON.stringify(prepared.manifest);

    assert.equal(publicJson.includes(source.userId), false);
    assert.equal(publicJson.includes(source.conversations[0].conversationId), false);
    assert.equal(publicJson.includes(source.conversations[0].messages[0].id), false);
    assert.equal(publicJson.includes('PRIVATE_TEXT'), false);
    assert.equal(prepared.userId, source.userId);
    assert.equal(prepared.chunks[0].conversationId, source.conversations[0].conversationId);
    assert.equal(prepared.chunks[0].messages[0].id, source.conversations[0].messages[0].id);
  });

  it('canonicalizes object keys but preserves array order', () => {
    assert.equal(
      canonicalDialogueHistoryDigest({ b: 2, a: [1, 2] }),
      canonicalDialogueHistoryDigest({ a: [1, 2], b: 2 }),
    );
    assert.notEqual(
      canonicalDialogueHistoryDigest({ a: [1, 2], b: 2 }),
      canonicalDialogueHistoryDigest({ a: [2, 1], b: 2 }),
    );
  });

  it('locks the exact canonical source and chunk identity projections', () => {
    const source = snapshot([
      conversation(1, [message(1), message(2, 'assistant')]),
    ]);
    const prepared = prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: source });
    const chunk = prepared.chunks[0];
    const expectedChunkSourceDigest = createHash('sha256')
      .update(canonicalStringify({
        conversationId: source.conversations[0].conversationId,
        messages: source.conversations[0].messages,
      }), 'utf8')
      .digest('hex');
    const expectedChunkId = createHash('sha256')
      .update(canonicalStringify([
        PROFILE_ID,
        expectedChunkSourceDigest,
        0,
        0,
      ]), 'utf8')
      .digest('hex');
    const expectedSnapshotDigest = createHash('sha256')
      .update(canonicalStringify({
        profileId: PROFILE_ID,
        userId: source.userId,
        sourceCutoff: source.sourceCutoff,
        conversations: source.conversations,
      }), 'utf8')
      .digest('hex');

    assert.equal(chunk.sourceDigest, expectedChunkSourceDigest);
    assert.equal(chunk.chunkId, expectedChunkId);
    assert.equal(prepared.manifest.sourceSnapshotDigest, expectedSnapshotDigest);
  });
});

describe('history source hostile input boundary', () => {
  it('rejects getters, setters, symbols, non-enumerable fields, sparse arrays, and cycles', () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const getterInput = { profileId: PROFILE_ID } as Record<string, unknown>;
    Object.defineProperty(getterInput, 'snapshot', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_HISTORY_GETTER_SENTINEL');
      },
    });
    captureContractError(() => prepareDialogueHistoryBackfill(getterInput as never));
    assert.equal(getterCalls, 0);

    const setterInput = { profileId: PROFILE_ID } as Record<string, unknown>;
    Object.defineProperty(setterInput, 'snapshot', {
      enumerable: true,
      set() {
        setterCalls += 1;
      },
    });
    captureContractError(() => prepareDialogueHistoryBackfill(setterInput as never));
    assert.equal(setterCalls, 0);

    const symbolInput = {
      profileId: PROFILE_ID,
      snapshot: snapshot([conversation(1, [message(1)])]),
      [Symbol('secret')]: true,
    };
    captureContractError(() => prepareDialogueHistoryBackfill(symbolInput));

    const nonEnumerable = { profileId: PROFILE_ID } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'snapshot', {
      enumerable: false,
      value: snapshot([conversation(1, [message(1)])]),
    });
    captureContractError(() => prepareDialogueHistoryBackfill(nonEnumerable as never));

    const sparse = snapshot([conversation(1, [message(1)])]);
    sparse.conversations.length = 2;
    captureContractError(() =>
      prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: sparse })
    );

    const cyclic = snapshot([conversation(1, [message(1)])]) as Record<string, unknown>;
    cyclic.sourceCutoff = cyclic;
    captureContractError(() =>
      prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: cyclic })
    );
  });

  it('rejects transparent, throwing, and revoked proxies without executing traps or leaking', () => {
    let transparentTrapCalls = 0;
    const target = snapshot([conversation(1, [message(1)])]);
    const transparent = new Proxy(target, {
      getPrototypeOf(value) {
        transparentTrapCalls += 1;
        return Reflect.getPrototypeOf(value);
      },
      ownKeys(value) {
        transparentTrapCalls += 1;
        return Reflect.ownKeys(value);
      },
    });
    captureContractError(() =>
      prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: transparent })
    );
    assert.equal(transparentTrapCalls, 0);

    const throwing = new Proxy({}, {
      ownKeys() {
        throw new Error('RAW_HISTORY_PROXY_SENTINEL');
      },
    });
    const error = captureContractError(() =>
      prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: throwing })
    );
    assert.equal(error.message.includes('RAW_HISTORY_PROXY_SENTINEL'), false);

    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    captureContractError(() =>
      prepareDialogueHistoryBackfill({ profileId: PROFILE_ID, snapshot: revoked.proxy })
    );
  });
});
