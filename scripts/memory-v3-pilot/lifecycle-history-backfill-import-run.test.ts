import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLifecycleHistoryReviewPacket, runLifecycleHistoryBackfill } from './lifecycle-history-backfill-engine.ts';
import { prepareLifecycleHistoryBackfill } from './lifecycle-history-backfill-contract.ts';
import {
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';
import { main } from './lifecycle-history-backfill-import-run.ts';
import type { MemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import type { MemoryV3LifecycleReconcileRequest } from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IMPORT_ID = '99999999-9999-4999-8999-999999999999';
const ARTIFACT_PATH = 'C:\\safe\\history-backfill.json';
const REVIEW_PATH = 'C:\\safe\\history-backfill-review.json';
const ARGV = [
  '--import-reviewed-history',
  '--artifact-file', ARTIFACT_PATH,
  '--review-file', REVIEW_PATH,
  '--import-id', IMPORT_ID,
];

async function files() {
  const prepared = prepareLifecycleHistoryBackfill({
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    snapshot: {
      userId: USER_ID,
      sourceCutoff: '2026-09-20T00:00:00.000Z',
      conversations: [{
        conversationId: '22222222-2222-4222-8222-222222222222',
        createdAt: '2026-09-10T10:00:00.000Z',
        messages: [{
          id: '33333333-3333-4333-8333-333333333333', role: 'user',
          text: 'Предпочитает спокойные прогулки вечером',
          createdAt: '2026-09-10T10:01:00.000Z',
        }],
      }],
    },
  });
  const result = await runLifecycleHistoryBackfill({
    profileId: LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
    prepared,
    priceSnapshot: {
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
    },
    maxBudgetUsd: '1', nowMs: Date.parse('2026-09-21T12:00:00.000Z'), execute: true,
    extractorAdapter: async (request: MemoryV3ExtractorRequest) => ({
      content: JSON.stringify({
        layerDecisions: [
          { kind: 'event', decision: 'emit', itemRefs: ['i1'] },
          { kind: 'recurrence', decision: 'omit', itemRefs: [] },
          { kind: 'hypothesis', decision: 'omit', itemRefs: [] },
        ],
        items: [{ itemRef: 'i1', kind: 'event', claim: request.input.messages[0].text,
          status: 'active', sensitivity: 'normal', eventTimeStart: null,
          eventTimeEnd: null, alternative: null }],
        evidence: [{ itemRef: 'i1', sourceMessageId: request.input.messages[0].id,
          relation: 'supports', supportType: null,
          episodeKey: `episode:${request.input.messages[0].id}` }],
      }), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
    }),
    reconcilerAdapter: async (request: MemoryV3LifecycleReconcileRequest) => ({
      rawContent: JSON.stringify({ operations: request.input.candidates.map((candidate) => ({
        type: 'create', candidateRef: candidate.candidateRef, targetMemoryRef: null,
      })) }), usage: null, resolvedModel: LIFECYCLE_HISTORY_PRIMARY_MODEL,
    }),
  });
  const packet = buildLifecycleHistoryReviewPacket(result);
  return {
    prepared,
    artifactText: JSON.stringify({ benchmarkResult: result, semanticReviewPacket: packet }),
    reviewText: JSON.stringify({
      schemaVersion: 'memory-v3-lifecycle-history-review-v1',
      payloadSha256: packet.payloadSha256,
      verdict: 'PASS', reviewedAt: '2026-09-21T12:00:00.000Z', reviewer: 'Nastya',
      items: packet.items.map((item) => ({ memoryKey: item.memoryKey,
        semanticVerdict: 'PASS', reviewerNotes: null })),
    }),
    stateRevision: result.finalState!.stateRevision,
  };
}

async function harness(argv: unknown = ARGV) {
  const fixture = await files();
  const log: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let rpcCalls = 0;
  const options = {
    argv,
    async readFileImpl(path: string, encoding: 'utf8') {
      assert.equal(encoding, 'utf8');
      log.push(`file:${path}`);
      if (path === ARTIFACT_PATH) return fixture.artifactText;
      if (path === REVIEW_PATH) return fixture.reviewText;
      throw new Error('RAW_PATH_SENTINEL');
    },
    async readEnvText(name: string) {
      log.push(`env:${name}`);
      if (name === 'STAYSEE_MEMORY_V3_BACKFILL_USER_ID') return USER_ID;
      if (name === 'SUPABASE_URL') return 'https://synthetic.supabase.co';
      if (name === 'SUPABASE_SERVICE_ROLE_KEY') return 'fake-service-role-key';
      throw new Error(`FORBIDDEN_ENV_${name}`);
    },
    createSourceReader(url: string, key: string) {
      log.push(`sourceFactory:${url}:${key}`);
      return {
        async listConversationsPage() {
          log.push('source:conversations');
          return [{ id: '22222222-2222-4222-8222-222222222222', user_id: USER_ID,
            created_at: '2026-09-10T10:00:00.000Z' }];
        },
        async listMessagesPage() {
          log.push('source:messages');
          return [{ id: '33333333-3333-4333-8333-333333333333',
            conversation_id: '22222222-2222-4222-8222-222222222222', sender: 'user',
            content: 'Предпочитает спокойные прогулки вечером',
            created_at: '2026-09-10T10:01:00.000Z' }];
        },
      };
    },
    createImportClient(url: string, key: string) {
      log.push(`importFactory:${url}:${key}`);
      return {
        async loadCurrentHead() { log.push('head'); return { stateRevision: 0, itemCount: 0 }; },
        async importInitialState() {
          log.push('rpc'); rpcCalls += 1;
          return { result: 'succeeded', resultingStateRevision: fixture.stateRevision };
        },
      };
    },
    writeStdout(text: string) { stdout.push(text); },
    writeStderr(text: string) { stderr.push(text); },
  };
  return { fixture, log, stdout, stderr, options, get rpcCalls() { return rpcCalls; } };
}

describe('lifecycle history import-only runner', () => {
  it('reads both absolute JSON files before exact env names and performs one fresh inspection then one RPC', async () => {
    const h = await harness();
    assert.equal(await main(h.options), 0);
    assert.equal(h.rpcCalls, 1);
    assert.deepEqual(h.log.slice(0, 2), [`file:${ARTIFACT_PATH}`, `file:${REVIEW_PATH}`]);
    assert.deepEqual(h.log.filter((entry) => entry.startsWith('env:')), [
      'env:STAYSEE_MEMORY_V3_BACKFILL_USER_ID', 'env:SUPABASE_URL',
      'env:SUPABASE_SERVICE_ROLE_KEY',
    ]);
    assert.ok(h.log.indexOf('source:messages') < h.log.indexOf('head'));
    assert.ok(h.log.indexOf('head') < h.log.indexOf('rpc'));
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(JSON.parse(h.stdout[0]), {
      status: 'succeeded',
      artifactDigest: JSON.parse(h.fixture.reviewText).payloadSha256,
      sourceSnapshotDigest: h.fixture.prepared.manifest.sourceSnapshotDigest,
      resultingStateRevision: h.fixture.stateRevision,
      itemCount: 1,
      evidenceCount: 1,
    });
    assert.deepEqual(h.stderr, []);
  });

  it('rejects any missing, duplicate, extra, relative, or non-json flag value before file reads', async () => {
    for (const argv of [
      [], [...ARGV, '--extra'], ARGV.slice(0, -1),
      ARGV.map((value) => value === ARTIFACT_PATH ? 'relative.json' : value),
      ARGV.map((value) => value === REVIEW_PATH ? 'C:\\safe\\review.txt' : value),
      [...ARGV, '--artifact-file', ARTIFACT_PATH],
    ]) {
      const h = await harness(argv);
      assert.equal(await main(h.options), 1);
      assert.deepEqual(h.log, []);
      assert.equal(h.rpcCalls, 0);
      assert.equal(h.stderr.length, 1);
    }
  });

  it('stops malformed files before env, source, head, or RPC and emits one fixed safe failure', async () => {
    const h = await harness();
    h.options.readFileImpl = async (path: string) => {
      h.log.push(`file:${path}`);
      return path === ARTIFACT_PATH ? '{RAW_DIALOGUE_SENTINEL' : h.fixture.reviewText;
    };
    assert.equal(await main(h.options), 1);
    assert.equal(h.rpcCalls, 0);
    assert.equal(h.log.some((entry) => entry.startsWith('env:')), false);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.equal(h.stderr[0].includes('RAW_DIALOGUE_SENTINEL'), false);
  });

  it('fully validates a semantic FAIL review before reading service env or source', async () => {
    const h = await harness();
    const review = JSON.parse(h.fixture.reviewText);
    review.verdict = 'FAIL';
    h.options.readFileImpl = async (path: string) => {
      h.log.push(`file:${path}`);
      return path === ARTIFACT_PATH ? h.fixture.artifactText : JSON.stringify(review);
    };
    assert.equal(await main(h.options), 1);
    assert.equal(h.log.some((entry) => entry.startsWith('env:')), false);
    assert.equal(h.log.some((entry) => entry.startsWith('source')), false);
    assert.equal(h.rpcCalls, 0);
  });

  it('does not retry a source, head, or RPC failure and never reads provider credentials', async () => {
    const h = await harness();
    h.options.createImportClient = () => ({
      async loadCurrentHead() { return { stateRevision: 0, itemCount: 0 }; },
      async importInitialState() { throw new Error('RAW_RPC_SENTINEL'); },
    });
    assert.equal(await main(h.options), 1);
    assert.equal(h.log.some((entry) => /OPENROUTER|PROVIDER/iu.test(entry)), false);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
    assert.equal(h.stderr[0].includes('RAW_RPC_SENTINEL'), false);
  });
});
