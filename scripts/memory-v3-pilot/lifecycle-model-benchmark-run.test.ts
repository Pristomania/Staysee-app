import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { main } from './lifecycle-model-benchmark-run.ts';
import {
  LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
  getLifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';
import {
  prepareLifecycleModelBenchmarkCases,
  type PreparedLifecycleModelCase,
} from './lifecycle-model-benchmark-dataset.ts';
import {
  buildMemoryV3LifecycleReconcileRequest,
  type MemoryV3LifecycleReconcileRequest,
} from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';

const execFileAsync = promisify(execFile);
const DATASET_PATH = new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url);
const RUN_PATH = new URL('./lifecycle-model-benchmark-run.ts', import.meta.url);
const DATASET_TEXT = readFileSync(DATASET_PATH, 'utf8');
const profile = getLifecycleModelBenchmarkProfile(LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID);
const API_KEY = 'test-key-lifecycle-run';
const ENV_PATH = 'C:\\synthetic\\lifecycle.env';
const OUTPUT_PATH = 'D:\\synthetic\\lifecycle-model-result.json';
const TMP_PATH = `${OUTPUT_PATH}.tmp`;
const RAW_SENTINEL = 'RAW_LIFECYCLE_RUN_SECRET_SENTINEL';

function dryArgv(): string[] {
  return [
    '--profile', LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
    '--model', profile.model,
    '--max-budget-usd', '0.36',
  ];
}

function executeArgv(withOutput = false): string[] {
  const argv = [
    ...dryArgv(),
    '--env-file', ENV_PATH,
    '--execute-twelve-paid-requests',
  ];
  if (withOutput) argv.push('--safe-output-file', OUTPUT_PATH);
  return argv;
}

function enoent() {
  const error = new Error('not found');
  Object.defineProperty(error, 'code', { value: 'ENOENT', enumerable: true });
  return error;
}

function wireOperations(testCase: PreparedLifecycleModelCase) {
  const bundle = buildMemoryV3LifecycleReconcileRequest({
    userId: testCase.userId,
    conversationId: testCase.conversationId,
    messages: testCase.messages,
    state: testCase.state,
    extraction: testCase.extraction,
  });
  return testCase.expectedProposal.map((operation) => ({
    type: operation.type,
    candidateRef: bundle.bindings.candidates.find(
      (binding) => binding.localItemKey === operation.candidateLocalItemKey,
    )?.candidateRef,
    targetMemoryRef: operation.targetMemoryKey === null
      ? null
      : bundle.bindings.memories.find(
        (binding) => binding.memoryKey === operation.targetMemoryKey,
      )?.memoryRef,
  }));
}

async function exactFetch() {
  const dataset = JSON.parse(DATASET_TEXT);
  const prepared = await prepareLifecycleModelBenchmarkCases({
    profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
    dataset,
  });
  const fixtures = new Map(prepared.map((testCase) => [
    testCase.conversationId,
    { stepId: testCase.stepId, operations: wireOperations(testCase) },
  ]));
  let active = 0;
  let maxActive = 0;
  const calls: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const requestInput = JSON.parse(String(body.messages[1].content)) as MemoryV3LifecycleReconcileRequest['input'];
    const fixture = fixtures.get(requestInput.session.conversationId);
    assert.ok(fixture);
    calls.push(fixture.stepId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    try {
      return new Response(JSON.stringify({
        id: 'synthetic-response',
        object: 'chat.completion',
        created: 1,
        model: profile.model,
        provider: 'synthetic',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          native_finish_reason: 'STOP',
          message: {
            role: 'assistant',
            content: JSON.stringify({ operations: fixture.operations }),
            refusal: null,
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 25, cost: 0.0001 },
      }), { status: 200 });
    } finally {
      active -= 1;
    }
  }) as typeof fetch & { readonly calls: string[]; readonly maxActive: number };
  Object.defineProperties(fetchImpl, {
    calls: { value: calls, enumerable: true },
    maxActive: { get: () => maxActive, enumerable: true },
  });
  return fetchImpl;
}

function baseIo(overrides: Record<string, unknown> = {}): any {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    options: {
      argv: dryArgv(),
      readFileImpl: async () => DATASET_TEXT,
      accessImpl: async () => { throw enoent(); },
      writeFileImpl: async () => {},
      linkImpl: async () => {},
      unlinkImpl: async () => {},
      fetchImpl: (async () => { throw new Error('FETCH_MUST_NOT_RUN'); }) as typeof fetch,
      writeStdout: (text: string) => { stdout.push(text); },
      writeStderr: (text: string) => { stderr.push(text); },
      ...overrides,
    },
    stdout,
    stderr,
  };
}

describe('lifecycle model benchmark run import safety and dry-run', () => {
  it('does not perform file, fetch, or writer work on import', () => {
    const io = baseIo();
    assert.deepEqual(io.stdout, []);
    assert.deepEqual(io.stderr, []);
  });

  it('reads only the dataset and writes one safe JSON line during dry-run', async () => {
    const reads: string[] = [];
    let fetchCalls = 0;
    let writes = 0;
    const io = baseIo({
      readFileImpl: async (path: string) => {
        reads.push(String(path));
        return DATASET_TEXT;
      },
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('FETCH_MUST_NOT_RUN');
      }) as typeof fetch,
      writeFileImpl: async () => { writes += 1; },
    });
    const exitCode = await main(io.options);
    assert.equal(exitCode, 0);
    assert.equal(reads.length, 1);
    assert.match(reads[0], /memory-v3-synthetic-lifecycle\.v1\.json$/);
    assert.equal(fetchCalls, 0);
    assert.equal(writes, 0);
    assert.equal(io.stdout.length, 1);
    assert.deepEqual(io.stderr, []);
    assert.equal(io.stdout[0].endsWith('\n'), true);
    const payload = JSON.parse(io.stdout[0]);
    assert.equal(payload.benchmarkResult.providerHttpCalls, 0);
    assert.equal(payload.semanticReviewPacket, null);
    assert.equal(io.stdout[0].includes('Я помню'), false);
  });
});

describe('lifecycle model benchmark run safe-output preflight', () => {
  it('requires every filesystem dependency before dataset, env, fetch, or mutation', async () => {
    for (const missing of ['accessImpl', 'writeFileImpl', 'linkImpl', 'unlinkImpl']) {
      let reads = 0;
      let fetches = 0;
      const io = baseIo({
        argv: executeArgv(true),
        readFileImpl: async () => { reads += 1; return DATASET_TEXT; },
        fetchImpl: (async () => { fetches += 1; throw new Error('must not run'); }) as typeof fetch,
      });
      delete io.options[missing];
      const exitCode = await main(io.options);
      assert.equal(exitCode, 1);
      assert.equal(reads, 0);
      assert.equal(fetches, 0);
      assert.equal(io.stdout.length, 0);
      assert.equal(io.stderr.length, 1);
    }
  });

  it('rejects existing target or temp before all other work and never unlinks foreign files', async () => {
    for (const existing of [OUTPUT_PATH, TMP_PATH]) {
      const accesses: string[] = [];
      const unlinks: string[] = [];
      let reads = 0;
      const io = baseIo({
        argv: executeArgv(true),
        accessImpl: async (path: string) => {
          accesses.push(path);
          if (path === existing) return;
          throw enoent();
        },
        readFileImpl: async () => { reads += 1; return DATASET_TEXT; },
        unlinkImpl: async (path: string) => { unlinks.push(path); },
      });
      const exitCode = await main(io.options);
      assert.equal(exitCode, 1);
      assert.equal(reads, 0);
      assert.deepEqual(unlinks, []);
      assert.deepEqual(accesses, existing === OUTPUT_PATH ? [OUTPUT_PATH] : [OUTPUT_PATH, TMP_PATH]);
    }
  });

  it('does not execute error.code getters or leak paths and trap sentinels', async () => {
    let getterCalls = 0;
    const unsafeError = new Error('RAW_ACCESS_TRAP_SENTINEL');
    Object.defineProperty(unsafeError, 'code', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'ENOENT';
      },
    });
    let reads = 0;
    const io = baseIo({
      argv: executeArgv(true),
      accessImpl: async () => { throw unsafeError; },
      readFileImpl: async () => { reads += 1; return DATASET_TEXT; },
    });
    assert.equal(await main(io.options), 1);
    assert.equal(getterCalls, 0);
    assert.equal(reads, 0);
    const publicText = `${io.stdout.join('')}${io.stderr.join('')}`;
    assert.equal(publicText.includes(OUTPUT_PATH), false);
    assert.equal(publicText.includes('RAW_ACCESS_TRAP_SENTINEL'), false);
  });
});

describe('lifecycle model benchmark run no-clobber publish', () => {
  it('publishes execute output with wx, exclusive link, and owned-temp unlink', async () => {
    const fetchImpl = await exactFetch();
    const reads: string[] = [];
    const writes: Array<{ path: string; data: string; options: unknown }> = [];
    const links: Array<[string, string]> = [];
    const unlinks: string[] = [];
    const io = baseIo({
      argv: executeArgv(true),
      fetchImpl,
      readFileImpl: async (path: string) => {
        reads.push(path);
        return path === ENV_PATH ? `OPENROUTER_API_KEY=${API_KEY}` : DATASET_TEXT;
      },
      writeFileImpl: async (path: string, data: string, options: unknown) => {
        writes.push({ path, data, options });
      },
      linkImpl: async (from: string, to: string) => { links.push([from, to]); },
      unlinkImpl: async (path: string) => { unlinks.push(path); },
    });
    assert.equal(await main(io.options), 0);
    assert.equal(fetchImpl.calls.length, 12);
    assert.equal(fetchImpl.maxActive, 1);
    assert.equal(reads.length, 2);
    assert.deepEqual(writes.map(({ path, options }) => ({ path, options })), [{
      path: TMP_PATH,
      options: { flag: 'wx' },
    }]);
    assert.deepEqual(links, [[TMP_PATH, OUTPUT_PATH]]);
    assert.deepEqual(unlinks, [TMP_PATH]);
    assert.equal(writes[0].data, io.stdout[0]);
    assert.equal(JSON.stringify(JSON.parse(io.stdout[0])), io.stdout[0].trimEnd());
    const publicPayload = JSON.parse(io.stdout[0]);
    assert.equal(publicPayload.semanticReviewPacket, null);
    assert.equal(io.stdout[0].includes('semanticVerdict'), false);
    assert.equal(io.stdout[0].includes('createdAt'), false);
    assert.equal(io.stdout[0].includes('expectedOperations'), false);
  });

  it('preserves a target that appears after preflight and removes only the owned temp', async () => {
    const fetchImpl = await exactFetch();
    const unlinks: string[] = [];
    let linkCalls = 0;
    const io = baseIo({
      argv: executeArgv(true),
      fetchImpl,
      readFileImpl: async (path: string) =>
        path === ENV_PATH ? `OPENROUTER_API_KEY=${API_KEY}` : DATASET_TEXT,
      linkImpl: async () => {
        linkCalls += 1;
        const error = new Error(`FOREIGN_TARGET ${RAW_SENTINEL}`);
        Object.defineProperty(error, 'code', { value: 'EEXIST', enumerable: true });
        throw error;
      },
      unlinkImpl: async (path: string) => { unlinks.push(path); },
    });
    assert.equal(await main(io.options), 1);
    assert.equal(fetchImpl.calls.length, 12);
    assert.equal(linkCalls, 1);
    assert.deepEqual(unlinks, [TMP_PATH]);
    assert.equal(io.stdout.length, 0);
    const publicText = io.stderr.join('');
    assert.equal(publicText.includes('FOREIGN_TARGET'), false);
    assert.equal(publicText.includes(RAW_SENTINEL), false);
    assert.equal(publicText.includes(OUTPUT_PATH), false);
  });

  it('does not retry write or link failures and cleans only a successfully created temp', async () => {
    for (const failAt of ['write', 'link']) {
      const fetchImpl = await exactFetch();
      let writes = 0;
      let links = 0;
      const unlinks: string[] = [];
      const io = baseIo({
        argv: executeArgv(true),
        fetchImpl,
        readFileImpl: async (path: string) =>
          path === ENV_PATH ? `OPENROUTER_API_KEY=${API_KEY}` : DATASET_TEXT,
        writeFileImpl: async () => {
          writes += 1;
          if (failAt === 'write') throw new Error(RAW_SENTINEL);
        },
        linkImpl: async () => {
          links += 1;
          if (failAt === 'link') throw new Error(RAW_SENTINEL);
        },
        unlinkImpl: async (path: string) => { unlinks.push(path); },
      });
      assert.equal(await main(io.options), 1);
      assert.equal(writes, 1);
      assert.equal(links, failAt === 'write' ? 0 : 1);
      assert.deepEqual(unlinks, failAt === 'write' ? [] : [TMP_PATH]);
      assert.equal(io.stderr.join('').includes(RAW_SENTINEL), false);
    }
  });
});

describe('lifecycle model benchmark direct dry-run', () => {
  it('prints one safe JSON line and exits zero without env or output file', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', 'tsx', fileURLToPath(RUN_PATH),
      ...dryArgv(),
    ], {
      cwd: fileURLToPath(new URL('.', RUN_PATH)),
      windowsHide: true,
    });
    assert.equal(stderr, '');
    const lines = stdout.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.benchmarkResult.providerHttpCalls, 0);
    assert.equal(payload.semanticReviewPacket, null);
    assert.equal(stdout.includes('semanticVerdict'), false);
  });
});
