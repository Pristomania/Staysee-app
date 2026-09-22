import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runLifecycleHistoryBackfillFromArgv } from './lifecycle-history-backfill-cli.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const NOW_MS = Date.parse('2026-09-22T12:00:00.000Z');
const PRICE_PATH = 'C:\\safe\\price.json';
const OUTPUT_PATH = 'C:\\safe\\history-backfill.json';
const PRICE = {
  model: 'google/gemini-3.7-flash',
  inputUsdPerMillion: '0.75',
  outputUsdPerMillion: '3.75',
  observedAt: '2026-09-22T11:00:00.000Z',
  sourceUrl: 'https://openrouter.ai/google/gemini-3.7-flash',
};

const INSPECT_ARGV = [
  '--inspect-source',
  '--profile', 'memory-v3-lifecycle-history-backfill-v1',
  '--source-cutoff', '2026-09-20T00:00:00.000Z',
  '--price-snapshot-file', PRICE_PATH,
  '--max-budget-usd', '1.000000000',
];

function executeArgv(expectedDigest: string) {
  return [
    '--execute-history-backfill-paid-requests',
    '--profile', 'memory-v3-lifecycle-history-backfill-v1',
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
      async listMessagesPage() {
        log.push('source:messages');
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
    ...overrides,
  };
}

describe('Memory V3 lifecycle history backfill CLI', () => {
  it('inspects the frozen source provider-free and returns no review packet', async () => {
    const log: string[] = [];
    const fetchImpl = providerFetch();
    const result = await runLifecycleHistoryBackfillFromArgv(baseOptions({
      sourceReader: sourceFactory(log),
      readEnvText: textReader(log),
      fetchImpl,
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
      await assert.rejects(() => runLifecycleHistoryBackfillFromArgv(baseOptions({
        argv,
        sourceReader: () => { calls.push('source'); },
        readEnvText: async () => { calls.push('read'); return ''; },
        fetchImpl: (async () => { calls.push('fetch'); return new Response(); }) as typeof fetch,
      }) as never), /\[memory-v3:lifecycle-history-backfill-cli\] command failed/u);
    }
    assert.deepEqual(calls, []);
  });

  it('rejects unknown, duplicate, reordered, relative, wrong-extension, sparse, accessor, and symbol argv', async () => {
    const invalid: unknown[] = [
      [...INSPECT_ARGV, '--unknown'],
      [...INSPECT_ARGV, '--profile', 'memory-v3-lifecycle-history-backfill-v1'],
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
      await assert.rejects(() => runLifecycleHistoryBackfillFromArgv(baseOptions({ argv }) as never));
    }
  });

  it('rejects user IDs passed through argv and requires exact injected source credentials', async () => {
    await assert.rejects(() => runLifecycleHistoryBackfillFromArgv(baseOptions({
      argv: [...INSPECT_ARGV, '--user-id', USER_ID],
    }) as never));
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STAYSEE_MEMORY_V3_BACKFILL_USER_ID']) {
      await assert.rejects(() => runLifecycleHistoryBackfillFromArgv(baseOptions({
        readEnvText: textReader([], { [name]: '' }),
      }) as never));
    }
  });

  it('blocks execute on source digest mismatch before API key or provider access', async () => {
    const log: string[] = [];
    const fetchImpl = providerFetch();
    await assert.rejects(() => runLifecycleHistoryBackfillFromArgv(baseOptions({
      argv: executeArgv('a'.repeat(64)),
      sourceReader: sourceFactory(log),
      readEnvText: textReader(log),
      fetchImpl,
    }) as never));
    assert.equal(log.includes('read:OPENROUTER_API_KEY'), false);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('executes the exact frozen profile only after digest and budget preflight', async () => {
    const inspect = await runLifecycleHistoryBackfillFromArgv(baseOptions() as never);
    const digest = inspect.benchmarkResult.manifest.sourceSnapshotDigest;
    const log: string[] = [];
    const fetchImpl = providerFetch();
    const result = await runLifecycleHistoryBackfillFromArgv(baseOptions({
      argv: executeArgv(digest),
      sourceReader: sourceFactory(log),
      readEnvText: textReader(log),
      fetchImpl,
    }) as never);

    assert.equal(result.benchmarkResult.profileId, 'memory-v3-lifecycle-history-backfill-v1');
    assert.equal(result.benchmarkResult.model, 'google/gemini-3.7-flash');
    assert.equal(result.benchmarkResult.budget.hardMaxUsd, '1.000000000');
    assert.equal(result.benchmarkResult.failureCount, 0);
    assert.equal(result.benchmarkResult.providerCallCount, 2);
    assert.equal(result.semanticReviewPacket?.schemaVersion, 'memory-v3-lifecycle-history-review-packet-v1');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(log.indexOf('read:OPENROUTER_API_KEY') > log.indexOf('source:messages'), true);
    for (const call of fetchImpl.calls) {
      const body = JSON.parse(String(call.init.body));
      assert.equal(body.model, 'google/gemini-3.7-flash');
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
      await runLifecycleHistoryBackfillFromArgv(baseOptions({
        readEnvText: async () => { throw new Error(secrets.join('|')); },
      }) as never);
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error);
    assert.match(String(error), /^MemoryV3LifecycleHistoryBackfillCliError:/u);
    for (const secret of secrets) {
      assert.equal(String(error).includes(secret), false);
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(error as object, 'cause'), false);
  });
});
