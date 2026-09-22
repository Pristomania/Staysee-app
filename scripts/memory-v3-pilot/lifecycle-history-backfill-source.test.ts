import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLifecycleHistorySupabaseReader,
  inspectLifecycleHistorySource,
  type LifecycleHistoryPageCursor,
  type LifecycleHistorySourceReader,
} from './lifecycle-history-backfill-source.ts';

const PROFILE_ID = 'memory-v3-lifecycle-history-backfill-v1';
const USER_ID = syntheticUuid(1);
const OTHER_USER_ID = syntheticUuid(2);
const SOURCE_CUTOFF = '2026-09-21T00:00:00.000000000Z';

function syntheticUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 8, 20, 0, 0, index)).toISOString();
}

function conversationRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: syntheticUuid(1_000 + index),
    user_id: USER_ID,
    created_at: timestamp(index),
    ...overrides,
  };
}

function messageRow(
  index: number,
  conversationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: syntheticUuid(10_000 + index),
    conversation_id: conversationId,
    sender: index % 2 === 0 ? 'ai' : 'user',
    content: `synthetic-${index}`,
    created_at: timestamp(index),
    ...overrides,
  };
}

function assertSourceError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'MemoryV3LifecycleHistoryBackfillSourceError');
  assert.equal(
    error.message,
    '[memory-v3:lifecycle-history-backfill-source] source inspection failed',
  );
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(error.message.includes('RAW_SOURCE_SENTINEL'), false);
  return true;
}

function cursorKey(cursor: LifecycleHistoryPageCursor | null): string {
  return cursor === null ? 'start' : `${cursor.createdAt}|${cursor.id}`;
}

function createReader(options: {
  conversationPages: Map<string, unknown>;
  messagePages: Map<string, Map<string, unknown>>;
}) {
  const calls: Array<Record<string, unknown>> = [];
  let active = 0;
  let maxActive = 0;
  const reader: LifecycleHistorySourceReader = {
    async listConversationsPage(input) {
      calls.push({ type: 'conversations', ...input });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      const key = cursorKey(input.after);
      if (!options.conversationPages.has(key)) throw new Error('RAW_SOURCE_SENTINEL');
      return options.conversationPages.get(key);
    },
    async listMessagesPage(input) {
      calls.push({ type: 'messages', ...input });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      const pages = options.messagePages.get(input.conversationId);
      const key = cursorKey(input.after);
      if (!pages?.has(key)) throw new Error('RAW_SOURCE_SENTINEL');
      return pages.get(key);
    },
  };
  return { reader, calls, get maxActive() { return maxActive; } };
}

function oneConversationReader(input?: {
  conversation?: ReturnType<typeof conversationRow>;
  messages?: unknown;
}) {
  const conversation = input?.conversation ?? conversationRow(1);
  return createReader({
    conversationPages: new Map([['start', [conversation]]]),
    messagePages: new Map([
      [conversation.id as string, new Map([['start', input?.messages ?? [messageRow(1, conversation.id as string)] ]])],
    ]),
  });
}

function inspect(reader: unknown, overrides: Record<string, unknown> = {}) {
  return inspectLifecycleHistorySource({
    profileId: PROFILE_ID,
    userId: USER_ID,
    sourceCutoff: SOURCE_CUTOFF,
    reader,
    ...overrides,
  });
}

describe('provider-free lifecycle history pagination', () => {
  it('continues exact 100-row conversation and message pages with composite cursors', async () => {
    const conversations = Array.from({ length: 101 }, (_, index) => conversationRow(index + 1));
    const firstConversationPage = conversations.slice(0, 100).reverse();
    const conversationAfter = conversations[99];
    const messagePages = new Map<string, Map<string, unknown>>();
    for (const [index, row] of conversations.entries()) {
      const id = row.id as string;
      messagePages.set(id, new Map([
        ['start', [messageRow(1_000 + index, id, { sender: 'user' })]],
      ]));
    }
    const longConversationId = conversations[0].id as string;
    const longMessages = Array.from({ length: 101 }, (_, index) =>
      messageRow(index + 1, longConversationId)
    );
    messagePages.set(longConversationId, new Map([
      ['start', longMessages.slice(0, 100).reverse()],
      [`${longMessages[99].created_at}|${longMessages[99].id}`, [longMessages[100]]],
    ]));
    const fake = createReader({
      conversationPages: new Map([
        ['start', firstConversationPage],
        [`${conversationAfter.created_at}|${conversationAfter.id}`, [conversations[100]]],
      ]),
      messagePages,
    });

    const result = await inspect(fake.reader);

    assert.equal(result.manifest.conversationCount, 101);
    assert.equal(result.manifest.messageCount, 201);
    assert.equal(fake.maxActive, 1);
    assert.deepEqual(fake.calls[0], {
      type: 'conversations',
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      after: null,
      limit: 100,
    });
    assert.deepEqual(fake.calls[1], {
      type: 'conversations',
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      after: { createdAt: conversationAfter.created_at, id: conversationAfter.id },
      limit: 100,
    });
    const longMessageContinuation = fake.calls.find((call) =>
      call.type === 'messages' && call.conversationId === longConversationId && call.after !== null
    );
    assert.deepEqual(longMessageContinuation?.after, {
      createdAt: longMessages[99].created_at,
      id: longMessages[99].id,
    });
  });

  it('includes rows at the cutoff and rejects rows even one nanosecond newer', async () => {
    const atCutoff = conversationRow(1, { created_at: SOURCE_CUTOFF });
    const accepted = oneConversationReader({
      conversation: atCutoff,
      messages: [messageRow(1, atCutoff.id as string, { created_at: SOURCE_CUTOFF })],
    });
    assert.equal((await inspect(accepted.reader)).manifest.messageCount, 1);

    const newer = oneConversationReader({
      messages: [messageRow(1, conversationRow(1).id as string, {
        created_at: '2026-09-21T00:00:00.000000001Z',
      })],
    });
    await assert.rejects(() => inspect(newer.reader), assertSourceError);
  });

  it('canonicalizes out-of-order pages to the same source digest', async () => {
    const first = conversationRow(1);
    const second = conversationRow(2);
    const messages = [messageRow(1, first.id as string), messageRow(2, first.id as string)];
    const ordered = createReader({
      conversationPages: new Map([['start', [first, second]]]),
      messagePages: new Map([
        [first.id as string, new Map([['start', messages]])],
        [second.id as string, new Map([['start', [messageRow(3, second.id as string)] ]])],
      ]),
    });
    const reversed = createReader({
      conversationPages: new Map([['start', [second, first]]]),
      messagePages: new Map([
        [first.id as string, new Map([['start', [...messages].reverse()]])],
        [second.id as string, new Map([['start', [messageRow(3, second.id as string)] ]])],
      ]),
    });

    assert.equal(
      (await inspect(ordered.reader)).manifest.sourceSnapshotDigest,
      (await inspect(reversed.reader)).manifest.sourceSnapshotDigest,
    );
  });

  it('rejects foreign ownership and duplicate conversation or message IDs', async () => {
    const foreign = oneConversationReader({
      conversation: conversationRow(1, { user_id: OTHER_USER_ID }),
    });
    await assert.rejects(() => inspect(foreign.reader), assertSourceError);

    const duplicateConversation = conversationRow(1);
    const duplicateConversations = createReader({
      conversationPages: new Map([['start', [duplicateConversation, { ...duplicateConversation }]]]),
      messagePages: new Map(),
    });
    await assert.rejects(() => inspect(duplicateConversations.reader), assertSourceError);

    const conversation = conversationRow(2);
    const duplicateMessage = messageRow(1, conversation.id as string);
    const duplicateMessages = oneConversationReader({
      conversation,
      messages: [duplicateMessage, { ...duplicateMessage }],
    });
    await assert.rejects(() => inspect(duplicateMessages.reader), assertSourceError);

    const foreignMessage = oneConversationReader({
      conversation,
      messages: [messageRow(2, syntheticUuid(9_999))],
    });
    await assert.rejects(() => inspect(foreignMessage.reader), assertSourceError);
  });

  it('stops before message reads when a conversation ID repeats across pages', async () => {
    const conversations = Array.from({ length: 100 }, (_, index) =>
      conversationRow(index + 1)
    );
    const conversationLast = conversations[99];
    const messagePages = new Map<string, Map<string, unknown>>();
    for (const [index, row] of conversations.entries()) {
      messagePages.set(row.id as string, new Map([['start', [
        messageRow(1_000 + index, row.id as string, { sender: 'user' }),
      ]]]));
    }
    const duplicateConversationAcrossPages = createReader({
      conversationPages: new Map([
        ['start', conversations],
        [
          `${conversationLast.created_at}|${conversationLast.id}`,
          [{ ...conversations[0], created_at: timestamp(200) }],
        ],
      ]),
      messagePages,
    });
    await assert.rejects(
      () => inspect(duplicateConversationAcrossPages.reader),
      assertSourceError,
    );
    assert.equal(duplicateConversationAcrossPages.calls.length, 2);
    assert.equal(
      duplicateConversationAcrossPages.calls.every((call) => call.type === 'conversations'),
      true,
    );
  });

  it('stops before the next conversation when a message ID repeats across pages', async () => {
    const conversation = conversationRow(200, { created_at: timestamp(0) });
    const nextConversation = conversationRow(201, { created_at: timestamp(0) });
    const messages = Array.from({ length: 100 }, (_, index) =>
      messageRow(index + 1, conversation.id as string)
    );
    const messageLast = messages[99];
    const duplicateMessageAcrossPages = createReader({
      conversationPages: new Map([['start', [conversation, nextConversation]]]),
      messagePages: new Map([
        [conversation.id as string, new Map([
          ['start', messages],
          [
            `${messageLast.created_at}|${messageLast.id}`,
            [{ ...messages[0], created_at: timestamp(200) }],
          ],
        ])],
        [nextConversation.id as string, new Map([['start', [
          messageRow(300, nextConversation.id as string, { sender: 'user' }),
        ]]])],
      ]),
    });
    await assert.rejects(
      () => inspect(duplicateMessageAcrossPages.reader),
      assertSourceError,
    );
    assert.equal(
      duplicateMessageAcrossPages.calls.some((call) =>
        call.type === 'messages' && call.conversationId === nextConversation.id
      ),
      false,
    );
  });

  it('stops before a third conversation when message IDs repeat across conversations', async () => {
    const firstConversation = conversationRow(300, { created_at: timestamp(0) });
    const secondConversation = conversationRow(301, { created_at: timestamp(0) });
    const thirdConversation = conversationRow(302, { created_at: timestamp(0) });
    const sharedMessageId = syntheticUuid(90_000);
    const duplicateMessageAcrossConversations = createReader({
      conversationPages: new Map([['start', [
        firstConversation,
        secondConversation,
        thirdConversation,
      ]]]),
      messagePages: new Map([
        [firstConversation.id as string, new Map([['start', [
          messageRow(1, firstConversation.id as string, {
            id: sharedMessageId,
            sender: 'user',
          }),
        ]]])],
        [secondConversation.id as string, new Map([['start', [
          messageRow(2, secondConversation.id as string, {
            id: sharedMessageId,
            sender: 'user',
          }),
        ]]])],
        [thirdConversation.id as string, new Map([['start', [
          messageRow(3, thirdConversation.id as string, { sender: 'user' }),
        ]]])],
      ]),
    });
    await assert.rejects(
      () => inspect(duplicateMessageAcrossConversations.reader),
      assertSourceError,
    );
    assert.equal(
      duplicateMessageAcrossConversations.calls.some((call) =>
        call.type === 'messages' && call.conversationId === thirdConversation.id
      ),
      false,
    );
  });

  it('rejects missing, repeated, and nonadvancing page cursors instead of looping', async () => {
    const conversation = conversationRow(1);
    const missingCursorRows = Array.from({ length: 100 }, (_, index) =>
      conversationRow(index + 1)
    );
    delete (missingCursorRows[99] as Record<string, unknown>).id;
    const missing = createReader({
      conversationPages: new Map([['start', missingCursorRows]]),
      messagePages: new Map(),
    });
    await assert.rejects(() => inspect(missing.reader), assertSourceError);

    const fullPage = Array.from({ length: 100 }, (_, index) =>
      messageRow(index + 1, conversation.id as string)
    );
    const last = fullPage[99];
    const repeated = createReader({
      conversationPages: new Map([['start', [conversation]]]),
      messagePages: new Map([[conversation.id as string, new Map([
        ['start', fullPage],
        [`${last.created_at}|${last.id}`, fullPage],
      ])]]),
    });
    await assert.rejects(() => inspect(repeated.reader), assertSourceError);

    const lowerRows = Array.from({ length: 100 }, (_, index) =>
      messageRow(index + 1, conversation.id as string, { id: syntheticUuid(20_000 + index) })
    );
    const nonadvancing = createReader({
      conversationPages: new Map([['start', [conversation]]]),
      messagePages: new Map([[conversation.id as string, new Map([
        ['start', fullPage],
        [`${last.created_at}|${last.id}`, lowerRows],
      ])]]),
    });
    await assert.rejects(() => inspect(nonadvancing.reader), assertSourceError);
  });
});

describe('lifecycle history source safety boundary', () => {
  it('wraps malformed pages, reader throws, getters, and proxies in one fixed diagnostic', async () => {
    const malformed = oneConversationReader({ messages: { data: [] } });
    await assert.rejects(() => inspect(malformed.reader), assertSourceError);

    const throwing = {
      async listConversationsPage() {
        throw new Error('RAW_SOURCE_SENTINEL');
      },
      async listMessagesPage() {
        throw new Error('RAW_SOURCE_SENTINEL');
      },
    };
    await assert.rejects(() => inspect(throwing), assertSourceError);

    let getterCalls = 0;
    const getterReader = { listMessagesPage() {} } as Record<string, unknown>;
    Object.defineProperty(getterReader, 'listConversationsPage', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_SOURCE_SENTINEL');
      },
    });
    await assert.rejects(() => inspect(getterReader), assertSourceError);
    assert.equal(getterCalls, 0);

    let trapCalls = 0;
    const proxy = new Proxy(throwing, {
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    await assert.rejects(() => inspect(proxy), assertSourceError);
    assert.equal(trapCalls, 0);
  });

  it('rejects a Proxy prototype without executing its reflection traps', () => {
    let trapCalls = 0;
    const proxyPrototype = new Proxy({
      from() {
        throw new Error('RAW_SOURCE_SENTINEL');
      },
    }, {
      getOwnPropertyDescriptor(target, key) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    const client = Object.create(proxyPrototype);

    assert.throws(
      () => createLifecycleHistorySupabaseReader(client),
      assertSourceError,
    );
    assert.equal(trapCalls, 0);
  });

  it('performs no provider or global fetch work and returns only the Task 3 manifest schema', async () => {
    const fake = oneConversationReader();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('RAW_SOURCE_SENTINEL');
    }) as typeof fetch;
    try {
      const prepared = await inspect(fake.reader);
      assert.equal(fetchCalls, 0);
      assert.deepEqual(Object.keys(prepared.manifest).sort(), [
        'chunkCount',
        'chunks',
        'conversationCount',
        'conversations',
        'maxProviderCalls',
        'messageCount',
        'profileId',
        'schemaVersion',
        'sourceCutoff',
        'sourceSnapshotDigest',
        'userMessageCount',
      ]);
      assert.deepEqual(Reflect.ownKeys(prepared.manifest.conversations[0]), [
        'conversationOrdinal',
        'messageCount',
        'userMessageCount',
        'firstCreatedAt',
        'lastCreatedAt',
        'chunkCount',
      ]);
      assert.deepEqual(Reflect.ownKeys(prepared.manifest.chunks[0]), [
        'chunkId',
        'conversationOrdinal',
        'chunkOrdinal',
        'messageCount',
        'userMessageCount',
        'firstCreatedAt',
        'lastCreatedAt',
        'extractorRequestBytes',
        'extractorRequestSha256',
        'sourceDigest',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('injected Supabase history reader', () => {
  it('accepts the current Supabase success marker only when it is true', async () => {
    function readerFor(success: boolean) {
      const response = {
        data: [conversationRow(1)],
        error: null,
        count: null,
        status: 200,
        statusText: 'OK',
        success,
      };
      const query = {
        select() { return this; },
        eq() { return this; },
        lte() { return this; },
        order() { return this; },
        limit: async () => response,
      };
      return createLifecycleHistorySupabaseReader({ from() { return query; } });
    }

    assert.deepEqual(await readerFor(true).listConversationsPage({
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      after: null,
      limit: 100,
    }), [conversationRow(1)]);
    await assert.rejects(() => readerFor(false).listConversationsPage({
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      after: null,
      limit: 100,
    }), assertSourceError);
  });

  it('emits ownership, cutoff, ordering, keyset, and limit filters', async () => {
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const responses = {
      conversations: { data: [conversationRow(1)], error: null },
      messages: {
        data: [{
          ...messageRow(1, conversationRow(1).id as string),
          conversations: { user_id: USER_ID },
        }],
        error: null,
      },
    };
    function builder(table: 'conversations' | 'messages') {
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ['select', 'eq', 'lte', 'order', 'or']) {
        chain[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return chain;
        };
      }
      chain.limit = async (...args: unknown[]) => {
        calls.push({ table, method: 'limit', args });
        return responses[table];
      };
      return chain;
    }
    const client = {
      from(table: string) {
        assert.ok(table === 'conversations' || table === 'messages');
        calls.push({ table, method: 'from', args: [table] });
        return builder(table);
      },
    };
    const reader = createLifecycleHistorySupabaseReader(client);
    const after = { createdAt: timestamp(1), id: syntheticUuid(1_001) };

    assert.deepEqual(
      await reader.listConversationsPage({
        userId: USER_ID,
        sourceCutoff: SOURCE_CUTOFF,
        after,
        limit: 100,
      }),
      [conversationRow(1)],
    );
    assert.deepEqual(
      await reader.listMessagesPage({
        userId: USER_ID,
        conversationId: conversationRow(1).id as string,
        sourceCutoff: SOURCE_CUTOFF,
        after,
        limit: 100,
      }),
      [messageRow(1, conversationRow(1).id as string)],
    );

    const keyset =
      `created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`;
    assert.deepEqual(calls, [
      { table: 'conversations', method: 'from', args: ['conversations'] },
      { table: 'conversations', method: 'select', args: ['id, user_id, created_at'] },
      { table: 'conversations', method: 'eq', args: ['user_id', USER_ID] },
      { table: 'conversations', method: 'lte', args: ['created_at', SOURCE_CUTOFF] },
      { table: 'conversations', method: 'order', args: ['created_at', { ascending: true }] },
      { table: 'conversations', method: 'order', args: ['id', { ascending: true }] },
      { table: 'conversations', method: 'or', args: [keyset] },
      { table: 'conversations', method: 'limit', args: [100] },
      { table: 'messages', method: 'from', args: ['messages'] },
      {
        table: 'messages',
        method: 'select',
        args: [
          'id, conversation_id, sender, content, created_at, conversations!inner(user_id)',
        ],
      },
      {
        table: 'messages',
        method: 'eq',
        args: ['conversation_id', conversationRow(1).id],
      },
      { table: 'messages', method: 'eq', args: ['conversations.user_id', USER_ID] },
      { table: 'messages', method: 'lte', args: ['created_at', SOURCE_CUTOFF] },
      { table: 'messages', method: 'order', args: ['created_at', { ascending: true }] },
      { table: 'messages', method: 'order', args: ['id', { ascending: true }] },
      { table: 'messages', method: 'or', args: [keyset] },
      { table: 'messages', method: 'limit', args: [100] },
    ]);
  });

  it('sanitizes a non-null Supabase query error', async () => {
    const response = {
      data: [],
      error: new Error('RAW_SOURCE_SENTINEL'),
    };
    const query = {
      select() { return this; },
      eq() { return this; },
      lte() { return this; },
      order() { return this; },
      limit: async () => response,
    };
    const reader = createLifecycleHistorySupabaseReader({ from() { return query; } });

    await assert.rejects(() => reader.listConversationsPage({
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      after: null,
      limit: 100,
    }), assertSourceError);
  });

  it('sanitizes malformed Supabase responses without executing accessors', async () => {
    let getterCalls = 0;
    const response = { error: null } as Record<string, unknown>;
    Object.defineProperty(response, 'data', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_SOURCE_SENTINEL');
      },
    });
    const query = {
      select() { return this; },
      eq() { return this; },
      lte() { return this; },
      order() { return this; },
      limit: async () => response,
    };
    const reader = createLifecycleHistorySupabaseReader({ from() { return query; } });

    await assert.rejects(() => reader.listConversationsPage({
      userId: USER_ID,
      sourceCutoff: SOURCE_CUTOFF,
      after: null,
      limit: 100,
    }), assertSourceError);
    assert.equal(getterCalls, 0);
  });
});
