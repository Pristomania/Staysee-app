import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from './lifecycle-history-backfill-run.ts';
import { canonicalStringify } from './contracts.mjs';
import {
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
} from './lifecycle-history-backfill-profile.ts';
import { prepareLifecycleHistoryBackfill } from './lifecycle-history-backfill-contract.ts';

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
const ENV_TEXT = [
  'SUPABASE_URL=https://synthetic.supabase.co',
  'SUPABASE_SERVICE_ROLE_KEY=fake-service-role-key',
  `STAYSEE_MEMORY_V3_BACKFILL_USER_ID=${USER_ID}`,
  'OPENROUTER_API_KEY=fake-openrouter-key',
].join('\n');

const INSPECT_ARGV = [
  '--inspect-source',
  '--profile', LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  '--source-cutoff', '2026-09-20T00:00:00.000Z',
  '--price-snapshot-file', PRICE_PATH,
  '--max-budget-usd', '1.000000000',
];

const EXPECTED_DIGEST = prepareLifecycleHistoryBackfill({
  profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  snapshot: {
    userId: USER_ID,
    sourceCutoff: '2026-09-20T00:00:00.000Z',
    conversations: [{
      conversationId: CONVERSATION_ID,
      createdAt: '2026-09-10T10:00:00.000Z',
      messages: [{
        id: MESSAGE_ID,
        role: 'user',
        text: 'synthetic durable preference',
        createdAt: '2026-09-10T10:01:00.000Z',
      }],
    }],
  },
}).manifest.sourceSnapshotDigest;

const EXECUTE_ARGV = [
  '--execute-history-backfill-paid-requests',
  '--profile', LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  '--source-cutoff', '2026-09-20T00:00:00.000Z',
  '--expected-source-sha256', EXPECTED_DIGEST,
  '--price-snapshot-file', PRICE_PATH,
  '--max-budget-usd', '1.000000000',
  '--safe-output-file', OUTPUT_PATH,
];

function enoent(): Error {
  const error = new Error('not found');
  Object.defineProperty(error, 'code', { value: 'ENOENT', enumerable: true });
  return error;
}

function sourceFactory(log: string[]) {
  return (url: string, serviceKey: string) => {
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
}

function openRouterResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: 'fake-response', object: 'chat.completion', created: 1,
    model: 'google/gemini-3.7-flash', provider: 'fake',
    choices: [{
      index: 0, finish_reason: 'stop', native_finish_reason: 'STOP',
      message: { role: 'assistant', content, refusal: null },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function providerFetch(log: string[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    log.push('provider');
    calls.push({ url: String(url), init: init ?? {} });
    const content = calls.length === 1
      ? JSON.stringify({
          layerDecisions: [
            { kind: 'event', decision: 'emit', itemRefs: ['i1'] },
            { kind: 'recurrence', decision: 'omit', itemRefs: [] },
            { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
          ],
          items: [{
            itemRef: 'i1', kind: 'event', claim: 'synthetic durable preference',
            status: 'active', sensitivity: 'normal', eventTimeStart: null,
            eventTimeEnd: null, alternative: null,
          }],
          evidence: [{
            itemRef: 'i1', sourceMessageId: MESSAGE_ID, relation: 'supports',
            supportType: null, episodeKey: `episode:${MESSAGE_ID}`,
          }],
        })
      : JSON.stringify({
          operations: [{
            type: 'create', candidateRef: 'candidate:0001', targetMemoryRef: null,
          }],
        });
    return openRouterResponse(content);
  };
  return Object.assign(fetchImpl as typeof fetch, { calls });
}

function harness(argv: unknown = EXECUTE_ARGV) {
  const log: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes: Array<{ path: string; data: string; options: { flag: 'wx' } }> = [];
  const links: Array<[string, string]> = [];
  const unlinks: string[] = [];
  const fetchImpl = providerFetch(log);
  const options = {
    argv,
    readFileImpl: async (path: string, encoding: 'utf8') => {
      assert.equal(encoding, 'utf8');
      log.push(`read:${path}`);
      return path === PRICE_PATH ? JSON.stringify(PRICE) : ENV_TEXT;
    },
    accessImpl: async (path: string) => { log.push(`access:${path}`); throw enoent(); },
    writeFileImpl: async (path: string, data: string, fileOptions: { flag: 'wx' }) => {
      log.push(`write:${path}`);
      writes.push({ path, data, options: fileOptions });
    },
    linkImpl: async (from: string, to: string) => {
      log.push(`link:${from}:${to}`);
      links.push([from, to]);
    },
    unlinkImpl: async (path: string) => { log.push(`unlink:${path}`); unlinks.push(path); },
    createSourceReader: sourceFactory(log),
    fetchImpl,
    nowMs: NOW_MS,
    writeStdout: (text: string) => { stdout.push(text); },
    writeStderr: (text: string) => { stderr.push(text); },
  };
  return { options, log, stdout, stderr, writes, links, unlinks, fetchImpl };
}

describe('Memory V3 lifecycle history backfill composition root', () => {
  it('preflights target and temp before every file, env, source, or provider read', async () => {
    const h = harness();
    const code = await main(h.options);
    assert.equal(code, 0);
    assert.deepEqual(h.log.slice(0, 2), [
      `access:${OUTPUT_PATH}`,
      `access:${OUTPUT_PATH}.tmp`,
    ]);
    assert.equal(h.log.findIndex((entry) => entry.startsWith('read:')) > 1, true);
    assert.equal(h.log.findIndex((entry) => entry.startsWith('source:')) > 1, true);
    assert.equal(h.log.findIndex((entry) => entry === 'provider') > 1, true);
  });

  it('blocks existing target or temp with zero reads, source calls, provider calls, or mutations', async () => {
    for (const existing of [OUTPUT_PATH, `${OUTPUT_PATH}.tmp`]) {
      const h = harness();
      h.options.accessImpl = async (path: string) => {
        h.log.push(`access:${path}`);
        if (path === existing) return;
        throw enoent();
      };
      assert.equal(await main(h.options), 1);
      assert.equal(h.log.some((entry) => entry.startsWith('read:') || entry.startsWith('source:') ||
        entry === 'provider' || entry.startsWith('write:') || entry.startsWith('link:') ||
        entry.startsWith('unlink:')), false);
      assert.equal(h.fetchImpl.calls.length, 0);
    }
  });

  it('rejects missing filesystem dependencies before reads, source, or provider work', async () => {
    for (const field of ['accessImpl', 'writeFileImpl', 'linkImpl', 'unlinkImpl'] as const) {
      const h = harness();
      delete (h.options as unknown as Record<string, unknown>)[field];
      assert.equal(await main(h.options as never), 1);
      assert.deepEqual(h.log, []);
      assert.equal(h.fetchImpl.calls.length, 0);
    }
  });

  it('publishes with wx plus no-clobber link, unlinks only its owned temp, and prints only safe summary', async () => {
    const h = harness();
    assert.equal(await main(h.options), 0);
    assert.deepEqual(h.writes.map((row) => [row.path, row.options]), [
      [`${OUTPUT_PATH}.tmp`, { flag: 'wx' }],
    ]);
    assert.deepEqual(h.links, [[`${OUTPUT_PATH}.tmp`, OUTPUT_PATH]]);
    assert.deepEqual(h.unlinks, [`${OUTPUT_PATH}.tmp`]);
    assert.equal(h.stderr.length, 0);
    assert.equal(h.stdout.length, 1);
    const summary = JSON.parse(h.stdout[0]);
    assert.deepEqual(Object.keys(summary).sort(), [
      'chunkCount', 'evidenceCount', 'itemCount', 'outputWritten', 'payloadSha256',
      'profileId', 'sourceSnapshotDigest', 'status',
    ]);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.outputWritten, true);
    assert.equal(summary.itemCount, 1);
    assert.equal(summary.evidenceCount, 1);
    for (const forbidden of [
      USER_ID, CONVERSATION_ID, MESSAGE_ID, 'synthetic durable preference',
      'fake-service-role-key', 'fake-openrouter-key', OUTPUT_PATH,
    ]) assert.equal(h.stdout[0].includes(forbidden), false);
  });

  it('does not clobber a race-created target and cleans up only the temp it created', async () => {
    const h = harness();
    h.options.linkImpl = async () => { h.log.push('link:race'); throw new Error('FOREIGN_TARGET'); };
    assert.equal(await main(h.options), 1);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.unlinks, [`${OUTPUT_PATH}.tmp`]);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.equal(h.stderr[0].includes('FOREIGN_TARGET'), false);
  });

  it('never unlinks a pre-existing temp when wx creation fails', async () => {
    const h = harness();
    h.options.writeFileImpl = async () => { throw new Error('EEXIST_FOREIGN_TMP'); };
    assert.equal(await main(h.options), 1);
    assert.deepEqual(h.unlinks, []);
    assert.deepEqual(h.links, []);
  });

  it('writes the complete artifact only to the file and its digest covers result plus every review item', async () => {
    const h = harness();
    assert.equal(await main(h.options), 0);
    const artifact = JSON.parse(h.writes[0].data);
    assert.ok(artifact.benchmarkResult.finalState);
    assert.equal(artifact.semanticReviewPacket.items.length, 1);
    const digest = (value: unknown) => createHash('sha256')
      .update(canonicalStringify(value), 'utf8').digest('hex');
    const projection = {
      benchmarkResult: artifact.benchmarkResult,
      items: artifact.semanticReviewPacket.items,
    };
    assert.equal(digest(projection), artifact.semanticReviewPacket.payloadSha256);

    const mutations = [
      (copy: unknown) => {
        const value = copy as { benchmarkResult: { manifest: { messageCount: number } } };
        value.benchmarkResult.manifest.messageCount += 1;
      },
      (copy: unknown) => {
        const value = copy as { benchmarkResult: { finalState: { stateRevision: number } } };
        value.benchmarkResult.finalState.stateRevision += 1;
      },
      (copy: unknown) => {
        const value = copy as { benchmarkResult: { chunks: Array<{ itemCount: number }> } };
        value.benchmarkResult.chunks[0].itemCount += 1;
      },
      (copy: unknown) => {
        const value = copy as { items: Array<{ reviewerNotes: string | null }> };
        value.items[0].reviewerNotes = 'changed';
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(projection);
      mutate(copy);
      assert.notEqual(digest(copy), artifact.semanticReviewPacket.payloadSha256);
    }
  });

  it('dry inspection does not save automatically and emits a safe provider-free summary', async () => {
    const h = harness(INSPECT_ARGV);
    assert.equal(await main(h.options), 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.links, []);
    assert.deepEqual(h.unlinks, []);
    assert.equal(h.fetchImpl.calls.length, 0);
    const summary = JSON.parse(h.stdout[0]);
    assert.equal(summary.status, 'inspected');
    assert.equal(summary.outputWritten, false);
    assert.equal(summary.sourceSnapshotDigest, EXPECTED_DIGEST);
    assert.equal(summary.payloadSha256, null);
  });

  it('emits exactly one fixed safe stderr JSON on failures and no success stdout', async () => {
    const h = harness();
    h.options.readFileImpl = async () => { throw new Error(`${USER_ID}|RAW_ROW|${OUTPUT_PATH}`); };
    assert.equal(await main(h.options), 1);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.deepEqual(JSON.parse(h.stderr[0]), {
      ok: false,
      stage: 'config',
      error: '[memory-v3:lifecycle-history-backfill-run] run failed',
    });
    assert.equal(h.stderr[0].includes(USER_ID), false);
    assert.equal(h.stderr[0].includes('RAW_ROW'), false);
    assert.equal(h.stderr[0].includes(OUTPUT_PATH), false);
  });

  it('captures a trusted writeStderr before rejecting missing or invalid filesystem dependencies', async () => {
    for (const mutate of [
      (options: Record<string, unknown>) => { delete options.accessImpl; },
      (options: Record<string, unknown>) => { options.writeFileImpl = 123; },
      (options: Record<string, unknown>) => { options.linkImpl = null; },
      (options: Record<string, unknown>) => { options.unlinkImpl = 'invalid'; },
    ]) {
      const h = harness();
      mutate(h.options as unknown as Record<string, unknown>);
      assert.equal(await main(h.options as never), 1);
      assert.deepEqual(h.stdout, []);
      assert.equal(h.stderr.length, 1);
      assert.deepEqual(JSON.parse(h.stderr[0]), {
        ok: false,
        stage: 'config',
        error: '[memory-v3:lifecycle-history-backfill-run] run failed',
      });
      assert.deepEqual(h.log, []);
      assert.equal(h.fetchImpl.calls.length, 0);
    }
  });

  it('does not execute top-level option accessors or Proxy traps while locating stderr', async () => {
    let trapCalls = 0;
    const getterOptions = harness().options;
    Object.defineProperty(getterOptions, 'writeStderr', {
      enumerable: true,
      get() { trapCalls += 1; return () => undefined; },
    });
    const setterOptions = harness().options;
    Object.defineProperty(setterOptions, 'writeStderr', {
      enumerable: true,
      set(value) { void value; trapCalls += 1; },
    });
    const proxy = new Proxy(harness().options, {
      getOwnPropertyDescriptor() { trapCalls += 1; throw new Error('RAW_TOP_PROXY'); },
    });
    const revocable = Proxy.revocable(harness().options, {});
    revocable.revoke();
    for (const options of [getterOptions, setterOptions, proxy, revocable.proxy]) {
      assert.equal(await main(options as never), 1);
    }
    assert.equal(trapCalls, 0);
  });

  it('rejects accessor, Proxy, and stateful ENOENT errors without traps or raw leakage', async () => {
    let trapCalls = 0;
    const accessorError = Object.defineProperty(new Error('RAW_ENOENT_ACCESSOR'), 'code', {
      enumerable: true,
      get() { trapCalls += 1; return 'ENOENT'; },
    });
    const proxyError = new Proxy(new Error('RAW_ENOENT_PROXY'), {
      getOwnPropertyDescriptor() { trapCalls += 1; throw new Error('RAW_DESCRIPTOR'); },
    });
    const statefulError = new Proxy(new Error('RAW_ENOENT_STATEFUL'), {
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        return { value: 'ENOENT', enumerable: true, configurable: true };
      },
    });
    for (const error of [accessorError, proxyError, statefulError]) {
      const h = harness();
      h.options.accessImpl = async () => { throw error; };
      assert.equal(await main(h.options), 1);
      assert.deepEqual(h.stdout, []);
      assert.equal(h.stderr.length, 1);
      assert.equal(h.stderr[0].includes('RAW_'), false);
      assert.deepEqual(h.writes, []);
    }
    assert.equal(trapCalls, 0);
  });

  it('rejects relative and wrong-extension execute outputs before any I/O', async () => {
    for (const output of ['history-backfill.json', 'C:\\safe\\history-backfill.txt']) {
      const h = harness(EXECUTE_ARGV.map((entry) => entry === OUTPUT_PATH ? output : entry));
      assert.equal(await main(h.options), 1);
      assert.deepEqual(h.log, []);
      assert.deepEqual(h.stdout, []);
      assert.equal(h.stderr.length, 1);
    }
  });

  it('rejects malformed, duplicate, and unclosed env assignments without external work', async () => {
    const invalidEnvTexts = [
      `${ENV_TEXT}\nnot-an-assignment`,
      `${ENV_TEXT}\nSUPABASE_URL=https://duplicate.invalid`,
      ENV_TEXT.replace('fake-service-role-key', "'unterminated-service-key"),
    ];
    for (const envText of invalidEnvTexts) {
      const h = harness(INSPECT_ARGV);
      h.options.readFileImpl = async (path: string) =>
        path === PRICE_PATH ? JSON.stringify(PRICE) : envText;
      assert.equal(await main(h.options), 1);
      assert.equal(h.fetchImpl.calls.length, 0);
      assert.equal(h.log.some((entry) => entry.startsWith('source:')), false);
      assert.deepEqual(h.stdout, []);
      assert.equal(h.stderr.length, 1);
      assert.equal(h.stderr[0].includes('unterminated-service-key'), false);
    }
  });

  it('handles throwing stdout and stderr callbacks without retry or raw leakage', async () => {
    const stdoutHarness = harness(INSPECT_ARGV);
    stdoutHarness.options.writeStdout = () => { throw new Error('RAW_STDOUT'); };
    assert.equal(await main(stdoutHarness.options), 1);
    assert.equal(stdoutHarness.stderr.length, 1);
    assert.equal(stdoutHarness.stderr[0].includes('RAW_STDOUT'), false);
    assert.equal(stdoutHarness.fetchImpl.calls.length, 0);

    const stderrHarness = harness();
    let stderrCalls = 0;
    stderrHarness.options.writeStderr = () => {
      stderrCalls += 1;
      throw new Error('RAW_STDERR');
    };
    delete (stderrHarness.options as unknown as Record<string, unknown>).accessImpl;
    assert.equal(await main(stderrHarness.options as never), 1);
    assert.equal(stderrCalls, 1);
    assert.deepEqual(stderrHarness.stdout, []);
  });

  it('reports a post-link unlink failure without success stdout or a second unlink', async () => {
    const h = harness();
    let unlinkCalls = 0;
    h.options.unlinkImpl = async () => {
      unlinkCalls += 1;
      throw new Error('RAW_POST_LINK_UNLINK');
    };
    assert.equal(await main(h.options), 1);
    assert.equal(h.links.length, 1);
    assert.equal(unlinkCalls, 1);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.equal(h.stderr[0].includes('RAW_POST_LINK_UNLINK'), false);
  });

  it('keeps real filesystem, process, env path, Supabase, and global fetch bindings in direct invocation', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./lifecycle-history-backfill-run.ts', import.meta.url)),
      'utf8',
    );
    const directStart = source.indexOf('function isDirectInvocation()');
    assert.notEqual(directStart, -1);
    const injectedBoundary = source.slice(0, directStart);
    const directBoundary = source.slice(directStart);
    const restricted = [
      /process\.argv/gu,
      /globalThis\.fetch/gu,
      /new URL\('\.\.\/\.\.\/\.env'/gu,
      /createClient\(/gu,
      /\breadFile\(/gu,
      /\bwriteFile\(/gu,
    ];
    for (const pattern of restricted) {
      assert.equal([...injectedBoundary.matchAll(pattern)].length, 0);
      assert.equal([...directBoundary.matchAll(pattern)].length > 0, true);
    }
    assert.equal([...source.matchAll(/globalThis\.fetch/gu)].length, 1);
    assert.equal([...source.matchAll(/createClient\(/gu)].length, 1);
    assert.equal([...source.matchAll(/new URL\('\.\.\/\.\.\/\.env'/gu)].length, 1);
    assert.equal(directBoundary.includes('accessImpl: access'), true);
    assert.equal(directBoundary.includes('linkImpl: link'), true);
    assert.equal(directBoundary.includes('unlinkImpl: unlink'), true);
  });
});
