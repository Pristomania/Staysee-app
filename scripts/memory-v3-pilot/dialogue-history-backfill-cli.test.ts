import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runDialogueHistoryBackfillFromArgv } from './dialogue-history-backfill-cli.ts';
import { canonicalDialogueHistoryDigest } from './dialogue-history-backfill-contract.ts';
import {
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';

// profile.maxMessagesPerChunk for memory-v3-lifecycle-history-backfill-v1 (the
// shared profile both the lifecycle and dialogue tools use for their limits).
const CHUNK_SIZE_CAP = 60;
const PROFILE_ID = 'memory-v3-lifecycle-history-backfill-v1';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const NOW_MS = Date.parse('2026-09-22T12:00:00.000Z');
const PRICE_PATH = 'C:\\safe\\price.json';
const OUTPUT_PATH = 'C:\\safe\\history-backfill.json';
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
};

const INSPECT_ARGV = [
  '--inspect-source',
  '--profile', PROFILE_ID,
  '--source-cutoff', '2026-09-20T00:00:00.000Z',
  '--price-snapshot-file', PRICE_PATH,
  '--max-budget-usd', '1.000000000',
];

function executeArgv(expectedDigest: string) {
  return [
    '--execute-history-backfill-paid-requests',
    '--profile', PROFILE_ID,
    '--source-cutoff', '2026-09-20T00:00:00.000Z',
    '--expected-source-sha256', expectedDigest,
    '--price-snapshot-file', PRICE_PATH,
    '--max-budget-usd', '1.000000000',
    '--safe-output-file', OUTPUT_PATH,
  ];
}

function sourceFactory(log: string[] = []) {
  const factory = (url: string, serviceKey: string) => {
    log.push(`factory:${url}:${serviceKey}`);
    return {
      async listConversationsPage() {
        log.push('source:conversations');
        return [{ id: CONVERSATION_ID, user_id: USER_ID, created_at: '2026-09-10T10:00:00.000Z' }];
      },
      async listMessagesPage(input: { conversationId: string }) {
        log.push('source:messages');
        if (input.conversationId !== CONVERSATION_ID) return [];
        return [{
          id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          sender: 'user',
          content: 'synthetic durable preference',
          created_at: '2026-09-10T10:01:00.000Z',
        }];
      },
    };
  };
  return factory;
}

/** Two-conversation source fixture used by the revision-capture test: a
 * never-touched conversation and one that already has organic live data. */
function twoConversationSourceFactory(log: string[] = []) {
  const factory = (url: string, serviceKey: string) => {
    log.push(`factory:${url}:${serviceKey}`);
    return {
      async listConversationsPage() {
        log.push('source:conversations');
        return [
          { id: CONVERSATION_ID, user_id: USER_ID, created_at: '2026-09-10T10:00:00.000Z' },
          { id: SECOND_CONVERSATION_ID, user_id: USER_ID, created_at: '2026-09-11T10:00:00.000Z' },
        ];
      },
      async listMessagesPage(input: { conversationId: string }) {
        log.push('source:messages');
        if (input.conversationId === CONVERSATION_ID) {
          return [{
            id: MESSAGE_ID,
            conversation_id: CONVERSATION_ID,
            sender: 'user',
            content: 'first conversation preference',
            created_at: '2026-09-10T10:01:00.000Z',
          }];
        }
        if (input.conversationId === SECOND_CONVERSATION_ID) {
          return [{
            id: SECOND_MESSAGE_ID,
            conversation_id: SECOND_CONVERSATION_ID,
            sender: 'user',
            content: 'second conversation preference',
            created_at: '2026-09-11T10:01:00.000Z',
          }];
        }
        return [];
      },
    };
  };
  return factory;
}

/** A fake Supabase-client-shaped revision reader: `.from(table).select(...)
 * .eq(...).eq(...).maybeSingle()`, reporting a fixed revision per
 * conversationId (0/undefined means "no row yet"). */
function revisionClientFactory(
  revisionsByConversationId: Record<string, number> = {},
  log: string[] = [],
) {
  const factory = (url: string, serviceKey: string) => {
    log.push(`revisionFactory:${url}:${serviceKey}`);
    return {
      from(table: string) {
        return {
          select(_columns: string) {
            return {
              eq(_col1: string, _userIdArg: string) {
                return {
                  eq(_col2: string, conversationIdArg: string) {
                    return {
                      async maybeSingle() {
                        log.push(`revision:${table}:${conversationIdArg}`);
                        const revision = revisionsByConversationId[conversationIdArg];
                        return revision === undefined
                          ? { data: null, error: null }
                          : { data: { state_revision: revision }, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  };
  return factory;
}

function syntheticUuid(groupTag: number, index: number): string {
  const tail = (groupTag * 1_000_000 + index).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

function tickIso(baseMs: number, tick: number): string {
  return new Date(baseMs + tick * 60_000).toISOString();
}

/** Builds a three-conversation fixture whose raw messages are interleaved in
 * real time across conversations (round-robin between the two 65-message
 * conversations, with the single-message conversation landing squarely
 * between their first and second chunks), so the chunks
 * inspectLifecycleHistorySource/reconstructDialogueConversations must handle
 * arrive in genuinely interleaved global order -- not pre-grouped by
 * conversation -- and two of the three conversations span multiple chunks
 * each (65 messages > the profile's 60-message-per-chunk cap). This is the
 * non-trivial reconstruction path the trivial one-message-per-conversation
 * tests above never exercise. */
function buildMultiChunkInterleavedFixture() {
  const baseMs = Date.parse('2026-09-10T10:00:00.000Z');
  const conversationAId = syntheticUuid(1, 0);
  const conversationBId = syntheticUuid(2, 0);
  const conversationCId = syntheticUuid(3, 0);
  const conversationCreatedAt = '2026-09-10T09:00:00.000Z';

  function buildMessages(
    groupTag: number,
    label: string,
    count: number,
    tickOf: (index: number) => number,
  ) {
    return Array.from({ length: count }, (_, index) => ({
      id: syntheticUuid(groupTag, index),
      role: 'user' as const,
      text: `${label}-msg-${index}`,
      createdAt: tickIso(baseMs, tickOf(index)),
    }));
  }

  // A and B: 65 messages each, interleaved minute-by-minute (A even ticks,
  // B odd ticks) for their first 60 messages, then C's single message lands
  // right after both first chunks close, then A/B's remaining 5 messages
  // (their second chunks) continue interleaved after that.
  const messagesA = buildMessages(11, 'a', 65, (index) =>
    index < 60 ? index * 2 : 121 + (index - 60) * 2);
  const messagesB = buildMessages(12, 'b', 65, (index) =>
    index < 60 ? index * 2 + 1 : 122 + (index - 60) * 2);
  const messagesC = buildMessages(13, 'c', 1, () => 120);

  const messagesByConversationId: Record<string, typeof messagesA> = {
    [conversationAId]: messagesA,
    [conversationBId]: messagesB,
    [conversationCId]: messagesC,
  };

  function sourceFactory(log: string[] = []) {
    return (url: string, serviceKey: string) => {
      log.push(`factory:${url}:${serviceKey}`);
      return {
        async listConversationsPage() {
          log.push('source:conversations');
          return [
            { id: conversationAId, user_id: USER_ID, created_at: conversationCreatedAt },
            { id: conversationBId, user_id: USER_ID, created_at: conversationCreatedAt },
            { id: conversationCId, user_id: USER_ID, created_at: conversationCreatedAt },
          ];
        },
        async listMessagesPage(input: { conversationId: string }) {
          log.push('source:messages');
          const messages = messagesByConversationId[input.conversationId] ?? [];
          return messages.map((message) => ({
            id: message.id,
            conversation_id: input.conversationId,
            sender: 'user',
            content: message.text,
            created_at: message.createdAt,
          }));
        },
      };
    };
  }

  return {
    conversationAId,
    conversationBId,
    conversationCId,
    messagesA,
    messagesB,
    messagesC,
    sourceFactory,
  };
}

function textReader(log: string[] = [], overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    [PRICE_PATH]: JSON.stringify(PRICE),
    SUPABASE_URL: 'https://synthetic.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key',
    STAYSEE_MEMORY_V3_BACKFILL_USER_ID: USER_ID,
    OPENROUTER_API_KEY: 'fake-openrouter-key',
    ...overrides,
  };
  return async (selector: string) => {
    log.push(`read:${selector}`);
    if (!(selector in values)) throw new Error('RAW_READ_SENTINEL');
    return values[selector];
  };
}

function openRouterResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: 'fake-response',
    object: 'chat.completion',
    created: 1,
    model: 'google/gemini-3.7-flash',
    provider: 'fake',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      native_finish_reason: 'STOP',
      message: { role: 'assistant', content, refusal: null },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function providerFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const content = calls.length % 2 === 1
      ? JSON.stringify({
          layerDecisions: [
            { kind: 'event', decision: 'omit', itemRefs: [] },
            { kind: 'recurrence', decision: 'omit', itemRefs: [] },
            { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
          ],
          items: [],
          evidence: [],
        })
      : JSON.stringify({ operations: [] });
    return openRouterResponse(content);
  };
  return Object.assign(fetchImpl as typeof fetch, { calls });
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    argv: INSPECT_ARGV,
    sourceReader: sourceFactory(),
    readEnvText: textReader(),
    fetchImpl: providerFetch(),
    nowMs: NOW_MS,
    revisionClient: revisionClientFactory(),
    ...overrides,
  };
}

describe('Memory V3 dialogue history backfill CLI', () => {
  it('inspects the frozen source provider-free and returns no review packet', async () => {
    const log: string[] = [];
    const fetchImpl = providerFetch();
    const result = await runDialogueHistoryBackfillFromArgv(baseOptions({
      sourceReader: sourceFactory(log),
      readEnvText: textReader(log),
      fetchImpl,
      revisionClient: revisionClientFactory({}, log),
    }) as never);

    assert.equal(result.benchmarkResult.execute, false);
    assert.equal(result.benchmarkResult.providerCallCount, 0);
    assert.equal(result.benchmarkResult.manifest.chunkCount, 1);
    assert.equal(result.semanticReviewPacket, null);
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(log.slice(0, 5), [
      `read:${PRICE_PATH}`,
      'read:SUPABASE_URL',
      'read:SUPABASE_SERVICE_ROLE_KEY',
      'read:STAYSEE_MEMORY_V3_BACKFILL_USER_ID',
      'factory:https://synthetic.supabase.co:fake-service-role-key',
    ]);
    assert.equal(log.includes(`revision:memory_v3_dialogue_heads:${CONVERSATION_ID}`), true);
    assert.equal(log.includes('read:OPENROUTER_API_KEY'), false);
  });

  it('rejects mixed modes and incomplete execute commands before dependencies', async () => {
    const calls: string[] = [];
    const invalid = [
      [...INSPECT_ARGV, '--execute-history-backfill-paid-requests'],
      executeArgv('a'.repeat(64)).filter((entry) => entry !== '--expected-source-sha256' && entry !== 'a'.repeat(64)),
      executeArgv('a'.repeat(64)).slice(0, -2),
    ];
    for (const argv of invalid) {
      await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({
        argv,
        sourceReader: () => { calls.push('source'); },
        readEnvText: async () => { calls.push('read'); return ''; },
        fetchImpl: (async () => { calls.push('fetch'); return new Response(); }) as typeof fetch,
        revisionClient: () => { calls.push('revision'); return {}; },
      }) as never), /\[memory-v3:dialogue-history-backfill-cli\] command failed/u);
    }
    assert.deepEqual(calls, []);
  });

  it('rejects unknown, duplicate, reordered, relative, wrong-extension, sparse, accessor, and symbol argv', async () => {
    const invalid: unknown[] = [
      [...INSPECT_ARGV, '--unknown'],
      [...INSPECT_ARGV, '--profile', PROFILE_ID],
      [INSPECT_ARGV[0], ...INSPECT_ARGV.slice(3), ...INSPECT_ARGV.slice(1, 3)],
      INSPECT_ARGV.map((entry) => entry === PRICE_PATH ? 'price.json' : entry),
      INSPECT_ARGV.map((entry) => entry === PRICE_PATH ? 'C:\\safe\\price.txt' : entry),
      Object.assign([...INSPECT_ARGV], { extra: 'x' }),
      Object.defineProperty([...INSPECT_ARGV], '0', { enumerable: true, get() { return '--inspect-source'; } }),
      Object.assign([...INSPECT_ARGV], { [Symbol('raw')]: 'x' }),
    ];
    const sparse = [...INSPECT_ARGV];
    delete sparse[2];
    invalid.push(sparse);
    for (const argv of invalid) {
      await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({ argv }) as never));
    }
  });

  it('rejects user IDs passed through argv and requires exact injected source credentials', async () => {
    await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({
      argv: [...INSPECT_ARGV, '--user-id', USER_ID],
    }) as never));
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STAYSEE_MEMORY_V3_BACKFILL_USER_ID']) {
      await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({
        readEnvText: textReader([], { [name]: '' }),
      }) as never));
    }
  });

  it('blocks execute on source digest mismatch before API key or provider access', async () => {
    const log: string[] = [];
    const fetchImpl = providerFetch();
    await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({
      argv: executeArgv('a'.repeat(64)),
      sourceReader: sourceFactory(log),
      readEnvText: textReader(log),
      fetchImpl,
    }) as never));
    assert.equal(log.includes('read:OPENROUTER_API_KEY'), false);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('executes the exact frozen profile only after digest and budget preflight', async () => {
    const inspect = await runDialogueHistoryBackfillFromArgv(baseOptions() as never);
    const digest = inspect.benchmarkResult.manifest.sourceSnapshotDigest;
    const log: string[] = [];
    const fetchImpl = providerFetch();
    const result = await runDialogueHistoryBackfillFromArgv(baseOptions({
      argv: executeArgv(digest),
      sourceReader: sourceFactory(log),
      readEnvText: textReader(log),
      fetchImpl,
    }) as never);

    assert.equal(result.benchmarkResult.profileId, 'memory-v3-dialogue-history-backfill-v1');
    assert.equal(result.benchmarkResult.model, 'google/gemini-3.7-flash');
    assert.equal(result.benchmarkResult.budget.hardMaxUsd, '1.000000000');
    assert.equal(result.benchmarkResult.conversations.length, 1);
    assert.equal(result.benchmarkResult.conversations[0].failureCount, 0);
    assert.notEqual(result.benchmarkResult.conversations[0].finalState, null);
    assert.equal(result.benchmarkResult.providerCallCount, 2);
    assert.equal(result.semanticReviewPacket?.schemaVersion, 'memory-v3-dialogue-history-review-packet-v1');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(log.indexOf('read:OPENROUTER_API_KEY') > log.indexOf('source:messages'), true);
    for (const [index, call] of fetchImpl.calls.entries()) {
      const body = JSON.parse(String(call.init.body));
      assert.equal(Object.hasOwn(body, 'model'), false);
      assert.deepEqual(body.models, [
        LIFECYCLE_HISTORY_PRIMARY_MODEL,
        LIFECYCLE_HISTORY_FALLBACK_MODEL,
      ]);
      assert.equal(body.max_tokens, index === 0 ? 4_096 : 1_200);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.deepEqual(body.provider, {
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
      });
    }
  });

  it('returns fixed safe errors without credentials, paths, rows, claims, evidence, or raw failures', async () => {
    const secrets = [
      'fake-service-role-key', 'fake-openrouter-key', USER_ID, PRICE_PATH,
      'synthetic durable preference', MESSAGE_ID, 'RAW_READ_SENTINEL',
    ];
    let error: unknown;
    try {
      await runDialogueHistoryBackfillFromArgv(baseOptions({
        readEnvText: async () => { throw new Error(secrets.join('|')); },
      }) as never);
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error);
    assert.match(String(error), /^MemoryV3DialogueHistoryBackfillCliError:/u);
    for (const secret of secrets) {
      assert.equal(String(error).includes(secret), false);
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(error as object, 'cause'), false);
  });

  it('validates sourceReader, readEnvText, fetchImpl, and revisionClient before the first read in both modes', async () => {
    for (const argv of [INSPECT_ARGV, executeArgv('a'.repeat(64))]) {
      for (const [field, value] of [
        ['sourceReader', 123],
        ['readEnvText', 123],
        ['fetchImpl', 123],
        ['revisionClient', 123],
      ] as const) {
        const log: string[] = [];
        await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({
          argv,
          [field]: value,
          sourceReader: field === 'sourceReader'
            ? value
            : () => { log.push('source'); return sourceFactory()('', ''); },
          readEnvText: field === 'readEnvText' ? value : textReader(log),
          fetchImpl: field === 'fetchImpl' ? value : providerFetch(),
          revisionClient: field === 'revisionClient' ? value : revisionClientFactory({}, log),
        }) as never), /command failed/u);
        assert.deepEqual(log, []);
      }
    }
  });

  it('rejects hostile top-level options without executing getters or proxy traps', async () => {
    let getterCalls = 0;
    const getterOptions = baseOptions();
    Object.defineProperty(getterOptions, 'fetchImpl', {
      enumerable: true,
      get() { getterCalls += 1; return providerFetch(); },
    });
    const setterOptions = baseOptions();
    Object.defineProperty(setterOptions, 'readEnvText', {
      enumerable: true,
      set(value) { void value; getterCalls += 1; },
    });
    const proxy = new Proxy(baseOptions(), {
      getPrototypeOf() { getterCalls += 1; throw new Error('RAW_PROXY_SENTINEL'); },
    });
    const revocable = Proxy.revocable(baseOptions(), {});
    revocable.revoke();
    for (const options of [getterOptions, setterOptions, proxy, revocable.proxy]) {
      await assert.rejects(() => runDialogueHistoryBackfillFromArgv(options as never));
    }
    assert.equal(getterCalls, 0);
  });

  it('accepts a direct reader object and sanitizes hostile factory results', async () => {
    const directReader = sourceFactory()('https://synthetic.supabase.co', 'fake-service-role-key');
    const direct = await runDialogueHistoryBackfillFromArgv(baseOptions({ sourceReader: directReader }) as never);
    assert.equal(direct.benchmarkResult.manifest.messageCount, 1);
    const nullPrototypeReader = Object.assign(Object.create(null), directReader);
    const nullPrototype = await runDialogueHistoryBackfillFromArgv(baseOptions({
      sourceReader: nullPrototypeReader,
    }) as never);
    assert.equal(nullPrototype.benchmarkResult.manifest.messageCount, 1);

    let trapCalls = 0;
    const hostileReader = new Proxy({}, {
      get() { trapCalls += 1; throw new Error('RAW_READER_PROXY_SENTINEL'); },
    });
    let error: unknown;
    try {
      await runDialogueHistoryBackfillFromArgv(baseOptions({
        sourceReader: () => hostileReader,
      }) as never);
    } catch (caught) {
      error = caught;
    }
    assert.equal(trapCalls, 0);
    assert.equal(String(error).includes('RAW_READER_PROXY_SENTINEL'), false);
  });

  it('rejects malformed direct readers before any price, env, source, or provider read', async () => {
    const valid = sourceFactory()('https://synthetic.supabase.co', 'fake-service-role-key');
    let getterCalls = 0;
    const accessor = {
      get listConversationsPage() { getterCalls += 1; return valid.listConversationsPage; },
      listMessagesPage: valid.listMessagesPage,
    };
    const setterOnly = Object.defineProperties({}, {
      listConversationsPage: {
        enumerable: true,
        set(value) { void value; getterCalls += 1; },
      },
      listMessagesPage: { enumerable: true, value: valid.listMessagesPage },
    });
    const nonEnumerable = Object.defineProperties({}, {
      listConversationsPage: { enumerable: false, value: valid.listConversationsPage },
      listMessagesPage: { enumerable: true, value: valid.listMessagesPage },
    });
    const inherited = Object.create(valid);
    const proxy = new Proxy(valid, {
      ownKeys() { getterCalls += 1; throw new Error('RAW_READER_KEYS'); },
    });
    const revocable = Proxy.revocable(valid, {});
    revocable.revoke();
    const proxiedMethod = new Proxy(valid.listMessagesPage, {
      apply() { getterCalls += 1; throw new Error('RAW_METHOD_APPLY'); },
    });
    const malformed: unknown[] = [
      {}, [], new Date(), null, Symbol('reader'),
      { ...valid, extra: () => undefined },
      { listConversationsPage: valid.listConversationsPage },
      accessor, setterOnly, nonEnumerable, inherited, proxy, revocable.proxy,
      { ...valid, listMessagesPage: proxiedMethod },
    ];
    for (const sourceReader of malformed) {
      const log: string[] = [];
      const fetchImpl = providerFetch();
      await assert.rejects(() => runDialogueHistoryBackfillFromArgv(baseOptions({
        sourceReader,
        readEnvText: textReader(log),
        fetchImpl,
      }) as never), /command failed/u);
      assert.deepEqual(log, []);
      assert.equal(fetchImpl.calls.length, 0);
    }
    assert.equal(getterCalls, 0);
  });

  it('sanitizes raw source and provider failures without retrying', async () => {
    const sourceSentinel = 'RAW_SOURCE_FAILURE_SENTINEL';
    const spoofedSourceError = Object.assign(new Error(sourceSentinel), {
      name: 'MemoryV3DialogueHistoryBackfillCliError',
      diagnosticCode: 'provider_call_cap_exceeded',
    });
    let sourceError: unknown;
    try {
      await runDialogueHistoryBackfillFromArgv(baseOptions({
        sourceReader: () => ({
          async listConversationsPage() { throw spoofedSourceError; },
          async listMessagesPage() { throw spoofedSourceError; },
        }),
      }) as never);
    } catch (caught) {
      sourceError = caught;
    }
    assert.equal(String(sourceError).includes(sourceSentinel), false);

    const inspect = await runDialogueHistoryBackfillFromArgv(baseOptions() as never);
    let providerCalls = 0;
    const providerSentinel = 'RAW_PROVIDER_FAILURE_SENTINEL';
    const spoofedProviderError = Object.assign(new Error(providerSentinel), {
      name: 'MemoryV3DialogueHistoryBackfillCliError',
      diagnosticCode: 'provider_call_cap_exceeded',
    });
    let providerError: unknown;
    try {
      await runDialogueHistoryBackfillFromArgv(baseOptions({
        argv: executeArgv(inspect.benchmarkResult.manifest.sourceSnapshotDigest),
        fetchImpl: (async () => {
          providerCalls += 1;
          throw spoofedProviderError;
        }) as typeof fetch,
      }) as never);
    } catch (caught) {
      providerError = caught;
    }
    assert.equal(providerCalls, 1);
    assert.equal(String(providerError).includes(providerSentinel), false);
  });

  it('constructs provider adapters only through the audited routed boundary', () => {
    const source = readFileSync(
      new URL('./dialogue-history-backfill-cli.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /createDialogueHistoryRoutedAdapters/u);
    assert.doesNotMatch(
      source,
      /createOpenRouterAdapter|createOpenRouterFetchTransport|createMemoryV3DialogueOpenRouterAdapter/u,
    );
  });

  it("captures each conversation's existing revision and still includes it in the run, even when the revision is nonzero", async () => {
    const log: string[] = [];
    const revisionLog: string[] = [];
    const inspect = await runDialogueHistoryBackfillFromArgv(baseOptions({
      sourceReader: twoConversationSourceFactory(),
      // The first conversation has never been touched (no row yet -> 0);
      // the second already has organic live data at revision 4.
      revisionClient: revisionClientFactory({ [SECOND_CONVERSATION_ID]: 4 }),
    }) as never);
    const digest = inspect.benchmarkResult.manifest.sourceSnapshotDigest;

    const fetchImpl = providerFetch();
    const result = await runDialogueHistoryBackfillFromArgv(baseOptions({
      argv: executeArgv(digest),
      sourceReader: twoConversationSourceFactory(log),
      fetchImpl,
      revisionClient: revisionClientFactory({ [SECOND_CONVERSATION_ID]: 4 }, revisionLog),
    }) as never);

    assert.equal(result.benchmarkResult.conversations.length, 2);
    const first = result.benchmarkResult.conversations.find(
      (conversation) => conversation.conversationId === CONVERSATION_ID,
    );
    const second = result.benchmarkResult.conversations.find(
      (conversation) => conversation.conversationId === SECOND_CONVERSATION_ID,
    );
    assert.ok(first, 'never-touched conversation must still be included in the run');
    assert.ok(second, 'conversation with existing live data must still be included, not excluded');
    assert.equal(first.expectedStateRevision, 0);
    assert.equal(second.expectedStateRevision, 4);
    assert.equal(first.failureCount, 0);
    assert.equal(second.failureCount, 0);
    assert.notEqual(first.finalState, null);
    assert.notEqual(second.finalState, null);
    assert.equal(
      revisionLog.includes(`revision:memory_v3_dialogue_heads:${SECOND_CONVERSATION_ID}`),
      true,
    );
  });

  it('reconstructs every conversation\'s full, correctly ordered message sequence across multiple chunks, even when chunks arrive globally interleaved across conversations', async () => {
    const fixture = buildMultiChunkInterleavedFixture();
    const revisions = {
      [fixture.conversationAId]: 0,
      [fixture.conversationBId]: 9,
      [fixture.conversationCId]: 2,
    };

    const inspect = await runDialogueHistoryBackfillFromArgv(baseOptions({
      sourceReader: fixture.sourceFactory(),
      revisionClient: revisionClientFactory(revisions),
    }) as never);
    assert.equal(inspect.benchmarkResult.manifest.chunkCount, 5);
    assert.equal(inspect.benchmarkResult.manifest.conversationCount, 3);
    const digest = inspect.benchmarkResult.manifest.sourceSnapshotDigest;

    const fetchImpl = providerFetch();
    const result = await runDialogueHistoryBackfillFromArgv(baseOptions({
      argv: executeArgv(digest),
      sourceReader: fixture.sourceFactory(),
      fetchImpl,
      revisionClient: revisionClientFactory(revisions),
    }) as never);

    assert.equal(result.benchmarkResult.conversations.length, 3);
    assert.equal(result.benchmarkResult.conversations.every((c) => c.failureCount === 0), true);
    assert.equal(result.benchmarkResult.conversations.every((c) => c.finalState !== null), true);

    // Prove the fixture's chunks genuinely arrived in globally interleaved
    // order (not pre-grouped by conversation) before trusting it to exercise
    // anything -- mirrors the engine test's own interleaving sanity check.
    const globalOrdinalSequence = result.benchmarkResult.manifest.chunks.map(
      (chunk) => chunk.conversationOrdinal,
    );
    const transitions = globalOrdinalSequence
      .slice(1)
      .filter((ordinal, index) => ordinal !== globalOrdinalSequence[index]).length;
    const distinctOrdinals = new Set(globalOrdinalSequence).size;
    assert.equal(distinctOrdinals, 3);
    assert.ok(
      transitions > distinctOrdinals - 1,
      `fixture must actually interleave chunks across conversations, not arrive pre-grouped (sequence: ${globalOrdinalSequence.join(',')})`,
    );

    const conversationExpectations = [
      { id: fixture.conversationAId, revision: 0, messages: fixture.messagesA },
      { id: fixture.conversationBId, revision: 9, messages: fixture.messagesB },
      { id: fixture.conversationCId, revision: 2, messages: fixture.messagesC },
    ];

    for (const expectation of conversationExpectations) {
      const conversationResult = result.benchmarkResult.conversations.find(
        (conversation) => conversation.conversationId === expectation.id,
      );
      assert.ok(conversationResult, `conversation ${expectation.id} must be present in the run`);
      assert.equal(
        conversationResult.expectedStateRevision,
        expectation.revision,
        `expectedStateRevision must be correctly attributed to conversation ${expectation.id}, not mixed up with another conversation's`,
      );

      const ordinal = conversationResult.conversationOrdinal;
      const expectedChunkCount = Math.ceil(expectation.messages.length / CHUNK_SIZE_CAP);
      const manifestChunksForConversation = result.benchmarkResult.manifest.chunks.filter(
        (chunk) => chunk.conversationOrdinal === ordinal,
      );
      assert.equal(manifestChunksForConversation.length, expectedChunkCount);

      // The decisive proof: independently recompute the exact content-addressed
      // digest each chunk's message slice must produce (canonicalDialogueHistoryDigest
      // is the SAME function dialogue-history-backfill-contract.ts uses internally
      // to compute sourceDigest) and compare it against what the real pipeline
      // actually produced. A mismatch here would mean a dropped, duplicated,
      // reordered, or misattributed message somewhere in the source-read ->
      // lifecycle-prepare -> reconstruct -> dialogue-prepare bridge.
      for (let chunkOrdinal = 0; chunkOrdinal < expectedChunkCount; chunkOrdinal += 1) {
        const start = chunkOrdinal * CHUNK_SIZE_CAP;
        const end = Math.min(start + CHUNK_SIZE_CAP, expectation.messages.length);
        const expectedSlice = expectation.messages.slice(start, end);
        const expectedSourceDigest = canonicalDialogueHistoryDigest({
          conversationId: expectation.id,
          messages: expectedSlice,
        });
        const manifestChunk = manifestChunksForConversation.find(
          (chunk) => chunk.chunkOrdinal === chunkOrdinal,
        );
        assert.ok(
          manifestChunk,
          `chunk ${chunkOrdinal} of conversation ${expectation.id} must exist in the manifest`,
        );
        assert.equal(manifestChunk!.messageCount, expectedSlice.length);
        assert.equal(
          manifestChunk!.sourceDigest,
          expectedSourceDigest,
          `chunk ${chunkOrdinal} of conversation ${expectation.id} must contain exactly its ` +
            'original, correctly ordered message slice',
        );
      }
    }
  });
});
