/**
 * Shared Memory V3 V2 live-benchmark composition-root tests.
 * All IO is injected. No real env, provider, network, or paid calls.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildProfileSemanticReviewPacketV2,
  main,
  runProfileBenchmarkFromArgvV2,
} from './live-benchmark-run-v2.mjs';

const MODEL = 'google/gemini-3.7-flash';
const API_KEY = 'test-profile-run-v2-key';
const ENV_PATH = 'C:\\synthetic\\profile-run-v2.env';
const OUTPUT_PATH = 'C:\\synthetic\\profile-run-v2.json';
const TMP_PATH = `${OUTPUT_PATH}.tmp`;
const SIX_PREFIX = '[memory-v3:live-benchmark-six-run-v2]';
const SIX_NAME = 'MemoryV3SixCaseBenchmarkRunV2Error';
const SENTINEL = 'RAW_PROFILE_RUN_V2_SENTINEL';
const REAL_GOLDEN_TEXT = readFileSync(
  new URL('./memory-v3-ru-golden.v2.json', import.meta.url),
  'utf8',
);

function dryArgv() {
  return ['--model', MODEL, '--max-budget-usd', '0.11'];
}

function executeArgv() {
  return [...dryArgv(), '--env-file', ENV_PATH, '--execute-six-paid-requests'];
}

function jsonResponse() {
  return {
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '{"items":[],"evidence":[]}',
              refusal: null,
            },
          },
        ],
      });
    },
  };
}

function recordingFetch(timeline) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (timeline) timeline.push('http');
    return jsonResponse();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function recordingReader(timeline) {
  const calls = [];
  const readFileImpl = async (path, encoding) => {
    calls.push({ path: String(path), encoding });
    if (String(path).includes('memory-v3-ru-golden.v2.json')) {
      if (timeline) timeline.push('dataset');
      return REAL_GOLDEN_TEXT;
    }
    if (String(path) === ENV_PATH) {
      if (timeline) timeline.push('env');
      return `OPENROUTER_API_KEY=${API_KEY}\n`;
    }
    throw new Error(SENTINEL);
  };
  readFileImpl.calls = calls;
  return readFileImpl;
}

function writer(timeline, label) {
  const calls = [];
  const write = (text) => {
    calls.push(String(text));
    if (timeline && label) timeline.push(label);
  };
  write.calls = calls;
  return write;
}

function enoent() {
  const error = new Error('not found');
  Object.defineProperty(error, 'code', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 'ENOENT',
  });
  return error;
}

function outputFs({
  existing = [],
  raceTarget = false,
  accessError,
  tmpAppearsBeforeWrite = false,
  finalUnlinkRemovesThenRejects = false,
  timeline,
} = {}) {
  const present = new Set(existing);
  const contents = new Map();
  const events = [];
  const accessImpl = async (path) => {
    const key = String(path);
    events.push(['access', key]);
    if (timeline) timeline.push(key === OUTPUT_PATH ? 'access-target' : 'access-tmp');
    if (accessError) throw accessError;
    if (present.has(key)) return;
    throw enoent();
  };
  const writeFileImpl = async (path, text, options) => {
    const key = String(path);
    events.push(['write', key, options]);
    if (timeline) timeline.push('write-tmp');
    assert.deepEqual(options, { encoding: 'utf8', flag: 'wx' });
    if (tmpAppearsBeforeWrite) {
      present.add(key);
      contents.set(key, 'FOREIGN_TMP');
    }
    if (present.has(key)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    present.add(key);
    contents.set(key, text);
    if (raceTarget) {
      present.add(OUTPUT_PATH);
      contents.set(OUTPUT_PATH, 'FOREIGN_TARGET');
    }
  };
  const linkImpl = async (from, to) => {
    const source = String(from);
    const target = String(to);
    events.push(['link', source, target]);
    if (timeline) timeline.push('link-target');
    if (present.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    present.add(target);
    contents.set(target, contents.get(source));
  };
  const unlinkImpl = async (path) => {
    const key = String(path);
    events.push(['unlink', key]);
    if (timeline) timeline.push('unlink-tmp');
    present.delete(key);
    contents.delete(key);
    if (finalUnlinkRemovesThenRejects && events.filter((entry) => entry[0] === 'unlink').length === 1) {
      present.add(key);
      contents.set(key, 'FOREIGN_TMP');
      throw new Error('UNLINK_REPORTED_FAILURE');
    }
  };
  return { present, contents, events, accessImpl, writeFileImpl, linkImpl, unlinkImpl };
}

function outputFsOptions(fsIo) {
  return {
    accessImpl: fsIo.accessImpl,
    writeFileImpl: fsIo.writeFileImpl,
    linkImpl: fsIo.linkImpl,
    unlinkImpl: fsIo.unlinkImpl,
  };
}

function options(overrides = {}, timeline) {
  const readFileImpl = recordingReader(timeline);
  const fetchImpl = recordingFetch(timeline);
  const writeStdout = writer(timeline, 'stdout');
  const writeStderr = writer(timeline, 'stderr');
  return {
    argv: dryArgv(),
    profileId: 'six-category-v2',
    readFileImpl,
    fetchImpl,
    writeStdout,
    writeStderr,
    ...overrides,
  };
}

function assertPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes(ENV_PATH), false);
  assert.equal(text.includes(OUTPUT_PATH), false);
  assert.equal(text.includes(SENTINEL), false);
  assert.equal(text.includes('Authorization'), false);
  assert.equal(text.includes('OPENROUTER_API_KEY'), false);
}

async function assertRunRejects(fn) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.name, SIX_NAME);
    assert.equal(String(error.message).startsWith(`${SIX_PREFIX} `), true);
    assert.equal('cause' in error, false);
    assertPrivate(error);
    return true;
  });
}

function withProfileIdDescriptor(base, kind, probe) {
  const copy = { ...base };
  delete copy.profileId;
  if (kind === 'valid-own-enumerable-string') {
    Object.defineProperty(copy, 'profileId', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return copy;
  }
  if (kind === 'getter') {
    Object.defineProperty(copy, 'profileId', {
      enumerable: true,
      configurable: true,
      get() {
        probe.getterCalls += 1;
        return 'six-category-v2';
      },
    });
    return copy;
  }
  if (kind === 'setter-only') {
    Object.defineProperty(copy, 'profileId', {
      enumerable: true,
      configurable: true,
      set() {
        probe.setterCalls += 1;
      },
    });
    return copy;
  }
  if (kind === 'non-enumerable') {
    Object.defineProperty(copy, 'profileId', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: 'six-category-v2',
    });
    return copy;
  }
  if (kind === 'symbol-keyed') {
    Object.defineProperty(copy, Symbol('profileId'), {
      enumerable: true,
      value: 'six-category-v2',
    });
    return copy;
  }
  if (kind === 'inherited') {
    return Object.assign(Object.create({ profileId: 'six-category-v2' }), copy);
  }
  throw new Error('unknown descriptor kind');
}

describe('shared profile-driven run import and dry-run', () => {
  it('is import-safe and re-exports shared CLI and packet APIs', () => {
    assert.equal(typeof main, 'function');
    assert.equal(typeof runProfileBenchmarkFromArgvV2, 'function');
    assert.equal(typeof buildProfileSemanticReviewPacketV2, 'function');
  });

  it('loads Golden V2 once and produces one safe dry-run JSON object', async () => {
    const value = options();
    const result = await main(value);
    assert.equal(value.readFileImpl.calls.length, 1);
    assert.equal(value.fetchImpl.calls.length, 0);
    assert.equal(value.writeStdout.calls.length, 1);
    assert.equal(value.writeStderr.calls.length, 0);
    assert.deepEqual(Object.keys(JSON.parse(value.writeStdout.calls[0])), [
      'benchmarkResult',
      'semanticReviewPacket',
    ]);
    assert.equal(result.semanticReviewPacket, null);
    assert.equal(result.benchmarkResult.providerHttpCalls, 0);
    assertPrivate(result);
  });

  it('does not import profile wrappers', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-run-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.equal(source.includes('live-benchmark-six-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-cli-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-six-run-v2.mjs'), false);
    assert.equal(source.includes('live-benchmark-hypothesis-four'), false);
    assert.equal(source.includes('process.env'), false);
    assert.equal(source.includes('process.exit('), false);
  });

  it('keeps six-case compatibility aliases bound to the canonical profile', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./live-benchmark-six-run-v2.mjs', import.meta.url)),
      'utf8',
    );
    assert.match(source, /const runSixCaseBenchmarkFromArgvV2 = \(options\) =>/);
    assert.match(source, /const buildSixCaseSemanticReviewPacketV2 = \(options\) =>/);
    assert.equal((source.match(/profileId: CANONICAL\.profileId/g) ?? []).length >= 3, true);
  });
});

describe('shared profile-driven run safe output', () => {
  it('rejects safe-output-file without execute before env or HTTP', async () => {
    const fsIo = outputFs();
    const value = options({
      argv: [...dryArgv(), '--safe-output-file', OUTPUT_PATH],
      ...outputFsOptions(fsIo),
    });
    await assertRunRejects(() => main(value));
    assert.equal(value.readFileImpl.calls.length, 0);
    assert.equal(value.fetchImpl.calls.length, 0);
    assert.deepEqual(fsIo.events, []);
  });

  it('preflights target and tmp, then publishes exact stdout through an owned tmp', async () => {
    const timeline = [];
    const fsIo = outputFs({ timeline });
    const value = options({
      argv: [...executeArgv(), '--safe-output-file', OUTPUT_PATH],
      ...outputFsOptions(fsIo),
    }, timeline);
    const result = await main(value);
    assert.equal(value.fetchImpl.calls.length, 6);
    assert.deepEqual(fsIo.events.map((entry) => entry[0]), [
      'access',
      'access',
      'write',
      'link',
      'unlink',
    ]);
    assert.deepEqual(fsIo.events.slice(0, 2), [
      ['access', OUTPUT_PATH],
      ['access', TMP_PATH],
    ]);
    assert.equal(fsIo.contents.get(OUTPUT_PATH), value.writeStdout.calls[0]);
    assert.equal(fsIo.present.has(TMP_PATH), false);
    assert.equal(result.semanticReviewPacket.cases.length, 6);
    assertPrivate(result);
    assert.deepEqual(timeline, [
      'access-target',
      'access-tmp',
      'dataset',
      'env',
      'http',
      'http',
      'http',
      'http',
      'http',
      'http',
      'stdout',
      'write-tmp',
      'link-target',
      'unlink-tmp',
    ]);
  });

  it('does not unlink a pre-existing target or tmp and performs zero HTTP', async () => {
    for (const existing of [[OUTPUT_PATH], [TMP_PATH]]) {
      const fsIo = outputFs({ existing });
      const value = options({
        argv: [...executeArgv(), '--safe-output-file', OUTPUT_PATH],
        ...outputFsOptions(fsIo),
      });
      await assertRunRejects(() => main(value));
      assert.equal(value.readFileImpl.calls.length, 0);
      assert.equal(value.fetchImpl.calls.length, 0);
      assert.equal(fsIo.events.some((entry) => entry[0] === 'unlink'), false);
      assert.equal(fsIo.present.has(existing[0]), true);
    }
  });

  it('does not replace a racing target and unlinks only its owned tmp', async () => {
    const fsIo = outputFs({ raceTarget: true });
    const value = options({
      argv: [...executeArgv(), '--safe-output-file', OUTPUT_PATH],
      ...outputFsOptions(fsIo),
    });
    await assert.rejects(() => main(value));
    assert.equal(value.fetchImpl.calls.length, 6);
    assert.equal(fsIo.contents.get(OUTPUT_PATH), 'FOREIGN_TARGET');
    assert.equal(fsIo.present.has(TMP_PATH), false);
    assert.deepEqual(
      fsIo.events.filter((entry) => entry[0] === 'unlink'),
      [['unlink', TMP_PATH]],
    );
    for (const text of [...value.writeStdout.calls, ...value.writeStderr.calls]) assertPrivate(text);
  });

  it('does not unlink a foreign tmp that appears after preflight but before wx', async () => {
    const fsIo = outputFs({ tmpAppearsBeforeWrite: true });
    const value = options({
      argv: [...executeArgv(), '--safe-output-file', OUTPUT_PATH],
      ...outputFsOptions(fsIo),
    });
    await assert.rejects(() => main(value));
    assert.equal(value.fetchImpl.calls.length, 6);
    assert.equal(fsIo.contents.get(TMP_PATH), 'FOREIGN_TMP');
    assert.equal(fsIo.events.filter((entry) => entry[0] === 'unlink').length, 0);
  });

  it('never retries final unlink after ownership becomes uncertain', async () => {
    const fsIo = outputFs({ finalUnlinkRemovesThenRejects: true });
    const value = options({
      argv: [...executeArgv(), '--safe-output-file', OUTPUT_PATH],
      ...outputFsOptions(fsIo),
    });
    await assert.rejects(() => main(value));
    assert.equal(value.fetchImpl.calls.length, 6);
    assert.equal(fsIo.events.filter((entry) => entry[0] === 'unlink').length, 1);
    assert.equal(fsIo.contents.get(TMP_PATH), 'FOREIGN_TMP');
  });

  it('does not execute an error.code getter or leak output details', async () => {
    let getterCalls = 0;
    const accessError = new Error(SENTINEL);
    Object.defineProperty(accessError, 'code', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'ENOENT';
      },
    });
    const fsIo = outputFs({ accessError });
    const value = options({
      argv: [...executeArgv(), '--safe-output-file', OUTPUT_PATH],
      ...outputFsOptions(fsIo),
    });
    await assertRunRejects(() => main(value));
    assert.equal(getterCalls, 0);
    assert.equal(value.readFileImpl.calls.length, 0);
    assert.equal(value.fetchImpl.calls.length, 0);
    assert.equal(fsIo.events.some((entry) => entry[0] === 'write'), false);
  });
});

describe('shared profile-driven run profileId boundary', () => {
  it('rejects invalid descriptors before dataset, env, fetch, and fs', async () => {
    const counters = { read: 0, fetch: 0, write: 0, link: 0, unlink: 0, access: 0 };
    const base = {
      argv: executeArgv(),
      profileId: 'six-category-v2',
      readFileImpl: async () => {
        counters.read += 1;
        return REAL_GOLDEN_TEXT;
      },
      fetchImpl: async () => {
        counters.fetch += 1;
        return jsonResponse();
      },
      writeStdout: () => {},
      writeStderr: () => {},
      writeFileImpl: async () => {
        counters.write += 1;
      },
      linkImpl: async () => {
        counters.link += 1;
      },
      unlinkImpl: async () => {
        counters.unlink += 1;
      },
      accessImpl: async () => {
        counters.access += 1;
      },
    };
    for (const kind of ['getter', 'setter-only', 'non-enumerable', 'symbol-keyed', 'inherited']) {
      const probe = { getterCalls: 0, setterCalls: 0 };
      await assert.rejects(() => main(withProfileIdDescriptor(base, kind, probe)));
      assert.equal(probe.getterCalls, 0);
      assert.equal(probe.setterCalls, 0);
    }
    assert.deepEqual(counters, { read: 0, fetch: 0, write: 0, link: 0, unlink: 0, access: 0 });

    const valid = options();
    const result = await main(
      withProfileIdDescriptor(valid, 'valid-own-enumerable-string', {
        getterCalls: 0,
        setterCalls: 0,
      }),
    );
    assert.equal(result.benchmarkResult.providerHttpCalls, 0);
    assert.equal(valid.fetchImpl.calls.length, 0);
  });
});
