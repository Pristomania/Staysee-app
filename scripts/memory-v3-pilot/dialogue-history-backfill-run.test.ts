import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from './dialogue-history-backfill-run.ts';
import { buildReadableReport } from './dialogue-history-backfill-report.ts';
import { canonicalStringify } from './contracts.mjs';
import {
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';

// The shared profile both the lifecycle and dialogue tools use for their
// limits (see dialogue-history-backfill-cli.test.ts's own PROFILE_ID note).
const PROFILE_ID = 'memory-v3-lifecycle-history-backfill-v1';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const NOW_MS = Date.parse('2026-09-22T12:00:00.000Z');
const PRICE_PATH = 'C:\\safe\\price.json';
const OUTPUT_PATH = 'C:\\safe\\history-backfill.json';
const REPORT_PATH = 'C:\\safe\\history-backfill.txt';
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
const ENV_TEXT = [
  'SUPABASE_URL=https://synthetic.supabase.co',
  'SUPABASE_SERVICE_ROLE_KEY=fake-service-role-key',
  `STAYSEE_MEMORY_V3_BACKFILL_USER_ID=${USER_ID}`,
  'OPENROUTER_API_KEY=fake-openrouter-key',
].join('\n');

const INSPECT_ARGV = [
  '--inspect-source',
  '--profile', PROFILE_ID,
  '--source-cutoff', '2026-09-20T00:00:00.000Z',
  '--price-snapshot-file', PRICE_PATH,
  '--max-budget-usd', '1.000000000',
];

function executeArgv(digest: string) {
  return [
    '--execute-history-backfill-paid-requests',
    '--profile', PROFILE_ID,
    '--source-cutoff', '2026-09-20T00:00:00.000Z',
    '--expected-source-sha256', digest,
    '--price-snapshot-file', PRICE_PATH,
    '--max-budget-usd', '1.000000000',
    '--safe-output-file', OUTPUT_PATH,
  ];
}

function enoent(): Error {
  const error = new Error('not found');
  Object.defineProperty(error, 'code', { value: 'ENOENT', enumerable: true });
  return error;
}

function sourceReader(log: string[]) {
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
}

/** Two-conversation source fixture used by the partial-failure test below:
 * both conversations are real, distinct, never-touched conversations -- one
 * is made to fail via the provider fetch, the other must still succeed and
 * survive in the published result. */
function twoConversationSourceReader(log: string[]) {
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
          content: 'synthetic durable preference',
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
}

/** A fake Supabase-client-shaped revision reader: `.from(table).select(...)
 * .eq(...).eq(...).maybeSingle()`, the exact chain
 * dialogue-history-backfill-cli.ts's buildReadRevision queries against
 * memory_v3_dialogue_heads. Reports "no row yet" (revision 0) for the
 * fixture's conversation, which has never run before. */
function revisionClient(log: string[]) {
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
                      return { data: null, error: null };
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
            type: 'create', candidateRef: 'candidate:0001', targetMemoryRef: null, topic: 'preference',
          }],
        });
    return openRouterResponse(content);
  };
  return Object.assign(fetchImpl as typeof fetch, { calls });
}

/** Like providerFetch, but the extractor call for `failingConversationId`
 * returns unparsable content, so exactly ONE conversation ends the run with a
 * real extractor_parse failure while every other conversation's extractor and
 * reconciler calls still succeed normally (mirrors
 * dialogue-history-backfill-cli.test.ts's own providerFetchWithFailingConversation).
 * Routes by request content (the extractor request's caseId embeds the
 * conversationId) and by the extractor/reconciler max_tokens split (4096 vs
 * 1200), not by call-count parity, so ordering across conversations never
 * matters. */
function providerFetchWithFailingConversation(log: string[], failingConversationId: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    log.push('provider');
    calls.push({ url: String(url), init: init ?? {} });
    const bodyText = String(init?.body ?? '');
    const isExtractor = JSON.parse(bodyText).max_tokens === 4_096;
    if (isExtractor && bodyText.includes(failingConversationId)) {
      return openRouterResponse('NOT_JSON{');
    }
    const content = isExtractor
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

function harness(argv: unknown = INSPECT_ARGV) {
  const log: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes: Array<{ path: string; data: string; options: { flag: 'wx' } }> = [];
  const links: Array<[string, string]> = [];
  const unlinks: string[] = [];
  const fetchImpl = providerFetch(log);
  let accessCalls = 0;
  // The one composition-root factory under test: it must be called AT MOST
  // ONCE per run and its single result must serve both the source reader and
  // the revision client -- see the "constructs exactly one Supabase-shaped
  // access instance" test below for the direct proof.
  const createSourceAndRevisionAccess = (url: string, serviceKey: string) => {
    accessCalls += 1;
    log.push(`supabase:${url}:${serviceKey}`);
    return {
      reader: sourceReader(log),
      revisionClient: revisionClient(log),
    };
  };
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
    createSourceAndRevisionAccess,
    fetchImpl,
    nowMs: NOW_MS,
    writeStdout: (text: string) => { stdout.push(text); },
    writeStderr: (text: string) => { stderr.push(text); },
  };
  return {
    options, log, stdout, stderr, writes, links, unlinks, fetchImpl,
    getAccessCalls: () => accessCalls,
  };
}

/** Runs a real inspect-only pass through `main()` to obtain the actual
 * frozen-source digest the paid-run tests must supply as
 * `--expected-source-sha256` for the CLI to accept the run at all. */
async function computeExpectedDigest(): Promise<string> {
  const h = harness(INSPECT_ARGV);
  assert.equal(await main(h.options), 0);
  const summary = JSON.parse(h.stdout[0]);
  return summary.sourceSnapshotDigest;
}

describe('Memory V3 dialogue history backfill composition root', () => {
  it('preflights target and temp before every file, env, source, revision, or provider read', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    const code = await main(h.options);
    assert.equal(code, 0);
    assert.deepEqual(h.log.slice(0, 4), [
      `access:${OUTPUT_PATH}`,
      `access:${OUTPUT_PATH}.tmp`,
      `access:${REPORT_PATH}`,
      `access:${REPORT_PATH}.tmp`,
    ]);
    assert.equal(h.log.findIndex((entry) => entry.startsWith('read:')) > 3, true);
    assert.equal(h.log.findIndex((entry) => entry.startsWith('supabase:')) > 3, true);
    assert.equal(h.log.findIndex((entry) => entry.startsWith('source:')) > 3, true);
    assert.equal(h.log.findIndex((entry) => entry.startsWith('revision:')) > 3, true);
    assert.equal(h.log.findIndex((entry) => entry === 'provider') > 3, true);
  });

  it('blocks existing target or temp with zero reads, source calls, provider calls, or mutations', async () => {
    for (const existing of [OUTPUT_PATH, `${OUTPUT_PATH}.tmp`, REPORT_PATH, `${REPORT_PATH}.tmp`]) {
      const h = harness(executeArgv('a'.repeat(64)));
      h.options.accessImpl = async (path: string) => {
        h.log.push(`access:${path}`);
        if (path === existing) return;
        throw enoent();
      };
      assert.equal(await main(h.options), 1);
      assert.equal(h.log.some((entry) => entry.startsWith('read:') || entry.startsWith('supabase:') ||
        entry.startsWith('source:') || entry.startsWith('revision:') ||
        entry === 'provider' || entry.startsWith('write:') || entry.startsWith('link:') ||
        entry.startsWith('unlink:')), false);
      assert.equal(h.fetchImpl.calls.length, 0);
      assert.equal(h.getAccessCalls(), 0);
    }
  });

  it('rejects missing filesystem dependencies before reads, source, or provider work', async () => {
    for (const field of ['accessImpl', 'writeFileImpl', 'linkImpl', 'unlinkImpl'] as const) {
      const h = harness(executeArgv('a'.repeat(64)));
      delete (h.options as unknown as Record<string, unknown>)[field];
      assert.equal(await main(h.options as never), 1);
      assert.deepEqual(h.log, []);
      assert.equal(h.fetchImpl.calls.length, 0);
      assert.equal(h.getAccessCalls(), 0);
    }
  });

  it('constructs exactly one Supabase-shaped access instance per run and shares it for the reader and the revision client', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    assert.equal(await main(h.options), 0);
    assert.equal(h.getAccessCalls(), 1);
    // Both the source read and the revision lookup for the SAME conversation
    // happened -- proof the one constructed access instance really served
    // both purposes, not that one side silently went unused.
    assert.equal(h.log.some((entry) => entry.startsWith('source:')), true);
    assert.equal(h.log.includes(`revision:memory_v3_dialogue_heads:${CONVERSATION_ID}`), true);

    // conversationRevisions must be built on every invocation, including a
    // dry run (see dialogue-history-backfill-cli.ts), so inspect-only mode
    // must also resolve the access exactly once, never twice.
    const inspectHarness = harness(INSPECT_ARGV);
    assert.equal(await main(inspectHarness.options), 0);
    assert.equal(inspectHarness.getAccessCalls(), 1);
  });

  it('publishes with wx plus no-clobber link, unlinks only its owned temp, and prints only a safe per-conversation summary', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    assert.equal(await main(h.options), 0);
    assert.deepEqual(h.writes.map((row) => [row.path, row.options]), [
      [`${OUTPUT_PATH}.tmp`, { flag: 'wx' }],
      [`${REPORT_PATH}.tmp`, { flag: 'wx' }],
    ]);
    assert.deepEqual(h.links, [
      [`${OUTPUT_PATH}.tmp`, OUTPUT_PATH],
      [`${REPORT_PATH}.tmp`, REPORT_PATH],
    ]);
    assert.deepEqual(h.unlinks, [`${OUTPUT_PATH}.tmp`, `${REPORT_PATH}.tmp`]);
    assert.equal(h.stderr.length, 0);
    assert.equal(h.stdout.length, 1);
    const summary = JSON.parse(h.stdout[0]);
    assert.deepEqual(Object.keys(summary).sort(), [
      'conversationCount', 'evidenceCount', 'itemCount', 'outputWritten', 'payloadSha256',
      'profileId', 'providerModelFallbackCount', 'sourceSnapshotDigest', 'status',
    ]);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.profileId, 'memory-v3-dialogue-history-backfill-v1');
    assert.equal(summary.outputWritten, true);
    assert.equal(summary.providerModelFallbackCount, 0);
    assert.equal(summary.conversationCount, 1);
    assert.equal(summary.itemCount, 1);
    assert.equal(summary.evidenceCount, 1);
    for (const forbidden of [
      USER_ID, CONVERSATION_ID, MESSAGE_ID, 'synthetic durable preference',
      'fake-service-role-key', 'fake-openrouter-key', OUTPUT_PATH,
    ]) assert.equal(h.stdout[0].includes(forbidden), false);
  });

  it('does not clobber a race-created target and cleans up only the temp it created', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    h.options.linkImpl = async () => { h.log.push('link:race'); throw new Error('FOREIGN_TARGET'); };
    assert.equal(await main(h.options), 1);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.unlinks, [`${OUTPUT_PATH}.tmp`]);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.equal(h.stderr[0].includes('FOREIGN_TARGET'), false);
  });

  it('never unlinks a pre-existing temp when wx creation fails', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    h.options.writeFileImpl = async () => { throw new Error('EEXIST_FOREIGN_TMP'); };
    assert.equal(await main(h.options), 1);
    assert.deepEqual(h.unlinks, []);
    assert.deepEqual(h.links, []);
  });

  it('writes the complete artifact only to the file and its digest covers the result plus every review item', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    assert.equal(await main(h.options), 0);
    const artifact = JSON.parse(h.writes[0].data);
    assert.equal(artifact.benchmarkResult.conversations.length, 1);
    assert.ok(artifact.benchmarkResult.conversations[0].finalState);
    assert.equal(artifact.semanticReviewPacket.items.length, 1);
    const hashDigest = (value: unknown) => createHash('sha256')
      .update(canonicalStringify(value), 'utf8').digest('hex');
    const projection = {
      benchmarkResult: artifact.benchmarkResult,
      items: artifact.semanticReviewPacket.items,
    };
    assert.equal(hashDigest(projection), artifact.semanticReviewPacket.payloadSha256);

    const mutations = [
      (copy: unknown) => {
        const value = copy as { benchmarkResult: { manifest: { messageCount: number } } };
        value.benchmarkResult.manifest.messageCount += 1;
      },
      (copy: unknown) => {
        const value = copy as {
          benchmarkResult: { conversations: Array<{ finalState: { stateRevision: number } }> };
        };
        value.benchmarkResult.conversations[0].finalState.stateRevision += 1;
      },
      (copy: unknown) => {
        const value = copy as {
          benchmarkResult: { manifest: { chunks: Array<{ messageCount: number }> } };
        };
        value.benchmarkResult.manifest.chunks[0].messageCount += 1;
      },
      (copy: unknown) => {
        const value = copy as { items: Array<{ reviewerNotes: string | null }> };
        value.items[0].reviewerNotes = 'changed';
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(projection);
      mutate(copy);
      assert.notEqual(hashDigest(copy), artifact.semanticReviewPacket.payloadSha256);
    }
  });

  it('writes a plain-Russian readable report next to the artifact, matching buildReadableReport for the same result', async () => {
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
    assert.equal(await main(h.options), 0);
    const reportWrite = h.writes.find((row) => row.path === `${REPORT_PATH}.tmp`);
    assert.ok(reportWrite, 'expected a report file to be written next to the JSON artifact');
    assert.equal(reportWrite!.options.flag, 'wx');
    assert.deepEqual(
      h.links.find((pair) => pair[1] === REPORT_PATH),
      [`${REPORT_PATH}.tmp`, REPORT_PATH],
    );
    assert.ok(h.unlinks.includes(`${REPORT_PATH}.tmp`));

    const artifactWrite = h.writes.find((row) => row.path === `${OUTPUT_PATH}.tmp`)!;
    const artifact = JSON.parse(artifactWrite.data);
    const expectedReport = buildReadableReport({ benchmarkResult: artifact.benchmarkResult });
    assert.equal(reportWrite!.data, expectedReport);
    // The readable report is plain text for Настя, not JSON, and must not
    // itself carry the artifact's JSON structure.
    assert.throws(() => JSON.parse(reportWrite!.data));
  });

  it('still writes both the JSON artifact and the readable report when one conversation fails partway through, correctly listing the failed conversation', async () => {
    // Compute the frozen-source digest against the TWO-conversation fixture
    // (not the single-conversation default harness()/computeExpectedDigest()
    // use), since the digest must match whatever source this run's own
    // inspect pass actually sees.
    const inspectHarness = harness(INSPECT_ARGV);
    inspectHarness.options.createSourceAndRevisionAccess = (url: string, serviceKey: string) => {
      inspectHarness.log.push(`supabase:${url}:${serviceKey}`);
      return {
        reader: twoConversationSourceReader(inspectHarness.log),
        revisionClient: revisionClient(inspectHarness.log),
      };
    };
    assert.equal(await main(inspectHarness.options), 0);
    const digest = JSON.parse(inspectHarness.stdout[0]).sourceSnapshotDigest;

    const h = harness(executeArgv(digest));
    h.options.createSourceAndRevisionAccess = (url: string, serviceKey: string) => {
      h.log.push(`supabase:${url}:${serviceKey}`);
      return {
        reader: twoConversationSourceReader(h.log),
        revisionClient: revisionClient(h.log),
      };
    };
    h.options.fetchImpl = providerFetchWithFailingConversation(h.log, SECOND_CONVERSATION_ID);

    // A real paid run where one conversation fails must still return 0
    // (success), not the generic failure exit code: the successfully
    // processed conversation's result -- and the money spent on it -- must
    // not be thrown away just because a sibling conversation failed.
    assert.equal(await main(h.options), 0);

    const artifactWrite = h.writes.find((row) => row.path === `${OUTPUT_PATH}.tmp`)!;
    assert.ok(artifactWrite, 'the JSON artifact must still be written on a partial failure');
    const artifact = JSON.parse(artifactWrite.data);
    assert.equal(artifact.semanticReviewPacket, null);
    assert.equal(artifact.benchmarkResult.conversations.length, 2);
    const succeeded = artifact.benchmarkResult.conversations.find(
      (conversation: { conversationId: string }) => conversation.conversationId === CONVERSATION_ID,
    );
    const failed = artifact.benchmarkResult.conversations.find(
      (conversation: { conversationId: string }) => conversation.conversationId === SECOND_CONVERSATION_ID,
    );
    assert.equal(succeeded.failureCount, 0);
    assert.notEqual(succeeded.finalState, null);
    assert.equal(failed.failureCount, 1);
    assert.equal(failed.finalState, null);

    const reportWrite = h.writes.find((row) => row.path === `${REPORT_PATH}.tmp`);
    assert.ok(reportWrite, 'the readable report must still be written on a partial failure');
    assert.deepEqual(
      h.links.find((pair) => pair[1] === REPORT_PATH),
      [`${REPORT_PATH}.tmp`, REPORT_PATH],
    );
    const expectedReport = buildReadableReport({ benchmarkResult: artifact.benchmarkResult });
    assert.equal(reportWrite!.data, expectedReport);
    assert.ok(reportWrite!.data.includes('Не удалось разобрать: 1'));
    assert.ok(reportWrite!.data.includes(SECOND_CONVERSATION_ID));

    const summary = JSON.parse(h.stdout[0]);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.outputWritten, true);
    assert.equal(summary.payloadSha256, null);
    assert.equal(summary.conversationCount, 2);
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
    // The engine returns an empty `conversations` array at preflight (see
    // dialogue-history-backfill-engine.ts's execute===false branch), so a dry
    // run's per-conversation totals are all zero -- there is nothing yet to
    // sum, not a bug in projectSummary's aggregation.
    assert.equal(summary.conversationCount, 0);
    assert.equal(summary.itemCount, 0);
    assert.equal(summary.evidenceCount, 0);
    assert.equal(typeof summary.sourceSnapshotDigest, 'string');
    assert.equal(summary.payloadSha256, null);
  });

  it('emits exactly one fixed safe stderr JSON on failures and no success stdout', async () => {
    const h = harness(executeArgv('a'.repeat(64)));
    h.options.readFileImpl = async () => { throw new Error(`${USER_ID}|RAW_ROW|${OUTPUT_PATH}`); };
    assert.equal(await main(h.options), 1);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.deepEqual(JSON.parse(h.stderr[0]), {
      ok: false,
      stage: 'config',
      error: '[memory-v3:dialogue-history-backfill-run] run failed',
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
      const h = harness(executeArgv('a'.repeat(64)));
      mutate(h.options as unknown as Record<string, unknown>);
      assert.equal(await main(h.options as never), 1);
      assert.deepEqual(h.stdout, []);
      assert.equal(h.stderr.length, 1);
      assert.deepEqual(JSON.parse(h.stderr[0]), {
        ok: false,
        stage: 'config',
        error: '[memory-v3:dialogue-history-backfill-run] run failed',
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
      const h = harness(executeArgv('a'.repeat(64)));
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
      const argv = executeArgv('a'.repeat(64)).map((entry) => entry === OUTPUT_PATH ? output : entry);
      const h = harness(argv);
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

    const stderrHarness = harness(executeArgv('a'.repeat(64)));
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
    const digest = await computeExpectedDigest();
    const h = harness(executeArgv(digest));
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
      fileURLToPath(new URL('./dialogue-history-backfill-run.ts', import.meta.url)),
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
