/** Hypothesis-four composition-root compatibility tests. No live calls. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from './live-benchmark-hypothesis-four-run-v2.mjs';

const MODEL = 'google/gemini-3.7-flash';
const GOLDEN = readFileSync(new URL('./memory-v3-ru-golden.v2.json', import.meta.url), 'utf8');

function writer() {
  const calls = [];
  const write = (text) => calls.push(String(text));
  write.calls = calls;
  return write;
}

describe('hypothesis-four run wrapper', () => {
  it('runs the 0.075 dry-run without env or HTTP', async () => {
    let reads = 0;
    let fetches = 0;
    const stdout = writer();
    const stderr = writer();
    const result = await main({
      argv: ['--model', MODEL, '--max-budget-usd', '0.075'],
      readFileImpl: async () => {
        reads += 1;
        return GOLDEN;
      },
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('GLOBAL_FETCH_SENTINEL');
      },
      writeStdout: stdout,
      writeStderr: stderr,
    });
    assert.equal(reads, 1);
    assert.equal(fetches, 0);
    assert.equal(stdout.calls.length, 1);
    assert.equal(stderr.calls.length, 0);
    assert.equal(result.benchmarkResult.providerHttpCalls, 0);
    assert.equal(result.benchmarkResult.caseIds.length, 4);
    assert.equal(result.semanticReviewPacket, null);
  });

  it('rejects caller profileId and the six-case execute flag before env and HTTP', async () => {
    let reads = 0;
    let fetches = 0;
    const base = {
      argv: [
        '--model',
        MODEL,
        '--max-budget-usd',
        '0.075',
        '--execute-six-paid-requests',
      ],
      readFileImpl: async () => {
        reads += 1;
        return GOLDEN;
      },
      fetchImpl: async () => {
        fetches += 1;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    };
    await assert.rejects(() => main(base));
    await assert.rejects(() => main({ ...base, profileId: 'hypothesis-four-v2' }));
    assert.equal(reads, 1);
    assert.equal(fetches, 0);
  });

  it('does not inspect a thrown error.name getter from an options proxy', async () => {
    let nameGetterCalls = 0;
    const thrown = {};
    Object.defineProperty(thrown, 'name', {
      enumerable: true,
      get() {
        nameGetterCalls += 1;
        throw new Error('RAW_RUN_WRAPPER_NAME_SENTINEL');
      },
    });
    const options = new Proxy({}, {
      getPrototypeOf() {
        throw thrown;
      },
    });

    await assert.rejects(() => main(options), (error) => {
      assert.equal(error.name, 'MemoryV3HypothesisFourBenchmarkRunV2Error');
      assert.equal(
        String(error.message).startsWith('[memory-v3:live-benchmark-hypothesis-four-run-v2] '),
        true,
      );
      assert.equal(String(error.message).includes('RAW_RUN_WRAPPER_NAME_SENTINEL'), false);
      assert.equal('cause' in error, false);
      return true;
    });
    assert.equal(nameGetterCalls, 0);
  });

  it('imports only profiles-v2 and shared run', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-hypothesis-four-run-v2.mjs', import.meta.url)),
      'utf8',
    );
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.deepEqual(imports, [
      'node:fs/promises',
      'node:url',
      './live-benchmark-profiles-v2.mjs',
      './live-benchmark-run-v2.mjs',
    ]);
    assert.equal(source.includes('live-benchmark-six'), false);
    assert.equal(source.includes('process.env'), false);
  });

  it('supports a direct dry-run command without execute or env', () => {
    const modulePath = fileURLToPath(
      new URL('./live-benchmark-hypothesis-four-run-v2.mjs', import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      [modulePath, '--model', MODEL, '--max-budget-usd', '0.075'],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const payload = JSON.parse(child.stdout);
    assert.equal(payload.benchmarkResult.providerHttpCalls, 0);
    assert.equal(payload.benchmarkResult.caseIds.length, 4);
    assert.equal(payload.semanticReviewPacket, null);
  });
});
