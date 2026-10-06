import type { VoiceDictationPrepareProgress } from './voiceDictationContract';
import {
  browserVoiceModelCacheDeps,
  deleteVoiceModelPackage,
  DOWNLOAD_STALL_TIMEOUT_MS,
  isVoiceModelCached,
  loadVoiceModelPackage,
  purgeStaleVoiceModelCaches,
  voiceModelFileUrl,
  VOICE_MODEL_CACHE_NAME,
  VOICE_MODEL_DATA_BYTES,
  VOICE_MODEL_DATA_FILE,
  VOICE_MODEL_TOTAL_BYTES,
  VOICE_MODEL_WASM_BYTES,
  VOICE_MODEL_WASM_FILE,
  VoiceModelPrepareError,
  type CacheLike,
  type CacheStorageLike,
  type ResponseLike,
  type VoiceModelCacheDeps,
} from './voiceModelCache';

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = 'values must be equal'): void {
  assert(Object.is(actual, expected), `${message}: ${String(actual)} !== ${String(expected)}`);
}

function assertDeepEqual(actual: unknown, expected: unknown, message = 'values must be deeply equal'): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function runCase(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  console.log(`PASS: ${name}`);
}

/**
 * `loadVoiceModelPackage` runs `purgeStaleVoiceModelCaches`, opens the
 * cache and probes both files before a download ever starts, so reaching
 * the point a test wants to control (the stall watchdog armed, or the
 * in-flight read captured) takes more than a fixed couple of microtask
 * ticks. Flushing until the condition holds (bounded, so a genuine
 * regression still fails loudly instead of hanging) is what actually
 * waits for "the implementation is now waiting on the thing this test
 * is about to manipulate" rather than guessing a tick count.
 */
async function flushUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function fakeResponse(byteLength: number, options: { ok?: boolean; status?: number; chunks?: number } = {}): ResponseLike {
  const chunks = options.chunks ?? 2;
  const perChunk = Math.ceil(byteLength / chunks);
  let sent = 0;
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: (name) => (name === 'content-length' ? String(byteLength) : null) },
    body: {
      getReader: () => ({
        async read() {
          if (sent >= byteLength) return { done: true };
          const size = Math.min(perChunk, byteLength - sent);
          sent += size;
          return { done: false, value: new Uint8Array(size) };
        },
      }),
    },
    arrayBuffer: async () => new ArrayBuffer(byteLength),
  };
}

function createFakeDeps(options: {
  cached?: boolean;
  cachedDataBytes?: number;
  noCacheStorage?: boolean;
  putError?: unknown;
  otherCaches?: string[];
  responses?: Record<string, ResponseLike>;
} = {}) {
  const stored = new Map<string, ResponseLike>();
  if (options.cached) {
    stored.set(voiceModelFileUrl(VOICE_MODEL_DATA_FILE), fakeResponse(options.cachedDataBytes ?? VOICE_MODEL_DATA_BYTES));
    stored.set(voiceModelFileUrl(VOICE_MODEL_WASM_FILE), fakeResponse(VOICE_MODEL_WASM_BYTES));
  }
  const fetchedUrls: string[] = [];
  const deletedCaches: string[] = [];
  const putUrls: string[] = [];
  const openedCaches: string[] = [];
  const names = new Set<string>([...(options.otherCaches ?? [])]);
  if (options.cached) names.add(VOICE_MODEL_CACHE_NAME);
  const abortedSignals: boolean[] = [];
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let now = 1_000;

  const cache: CacheLike = {
    async match(request) { return stored.get(request); },
    async put(request, response) {
      if (options.putError) throw options.putError;
      putUrls.push(request);
      stored.set(request, response);
      names.add(VOICE_MODEL_CACHE_NAME);
    },
  };

  const cacheStorage: CacheStorageLike = {
    async open(name) { openedCaches.push(name); return cache; },
    async keys() { return [...names]; },
    async delete(name) {
      deletedCaches.push(name);
      if (name === VOICE_MODEL_CACHE_NAME) stored.clear();
      return names.delete(name);
    },
  };

  const value: VoiceModelCacheDeps = {
    caches: options.noCacheStorage ? null : cacheStorage,
    async fetch(url, init) {
      fetchedUrls.push(url);
      abortedSignals.push(init.signal.aborted);
      const scripted = options.responses?.[url];
      if (scripted) return scripted;
      const expected = url.endsWith(VOICE_MODEL_DATA_FILE) ? VOICE_MODEL_DATA_BYTES : VOICE_MODEL_WASM_BYTES;
      return fakeResponse(expected);
    },
    createResponse: (bytes) => fakeResponse(bytes.byteLength),
    createAbortController() {
      const listeners: Array<() => void> = [];
      let aborted = false;
      return {
        signal: {
          get aborted() { return aborted; },
          addEventListener(_type, listener) { listeners.push(listener); },
          removeEventListener() { /* nothing to detach in the fake */ },
        },
        abort() {
          aborted = true;
          for (const listener of listeners) listener();
        },
      };
    },
    setTimeout(callback, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    now: () => now,
  };

  return {
    value,
    fetchedUrls,
    deletedCaches,
    putUrls,
    openedCaches,
    get cacheNames() { return [...names]; },
    advance(ms: number) { now += ms; },
    fireTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
    get pendingTimers() { return timers.size; },
  };
}

function externalSignal() {
  const listeners: Array<() => void> = [];
  let aborted = false;
  return {
    value: {
      get aborted() { return aborted; },
      addEventListener(_type: 'abort', listener: () => void) { listeners.push(listener); },
      removeEventListener() { /* nothing to detach in the fake */ },
    },
    abort() { aborted = true; for (const listener of listeners) listener(); },
  };
}

await runCase('the live model URLs and sizes are pinned exactly', () => {
  // Review Focus 4: a typo in a future revision path, or a stale byte
  // count, must fail here and not in a user's browser.
  assertEqual(
    voiceModelFileUrl(VOICE_MODEL_DATA_FILE),
    'https://staysee.ru/voice-model/83bbf6f-large-int8/sherpa-onnx-wasm-main-asr.data',
  );
  assertEqual(
    voiceModelFileUrl(VOICE_MODEL_WASM_FILE),
    'https://staysee.ru/voice-model/83bbf6f-large-int8/sherpa-onnx-wasm-main-asr.wasm',
  );
  assertEqual(VOICE_MODEL_DATA_BYTES, 71_694_239);
  assertEqual(VOICE_MODEL_WASM_BYTES, 11_545_586);
  assertEqual(VOICE_MODEL_TOTAL_BYTES, 83_239_825);
  assertEqual(VOICE_MODEL_CACHE_NAME, 'staysee-voice-model-83bbf6f-large-int8');
  assert(typeof browserVoiceModelCacheDeps === 'function', 'a browser deps factory is exported');
});

await runCase('a first download reports progress across both files and caches both', async () => {
  const deps = createFakeDeps();
  const progress: VoiceDictationPrepareProgress[] = [];
  const result = await loadVoiceModelPackage(deps.value, { onProgress: (next) => progress.push(next) });
  assertEqual(result.fromCache, false);
  assertEqual(result.dataBytes.byteLength, VOICE_MODEL_DATA_BYTES);
  assertEqual(result.wasmBytes.byteLength, VOICE_MODEL_WASM_BYTES);
  assertEqual(progress[0].loadedBytes, 0, 'progress opens at zero so a bar can appear at once');
  assertEqual(progress[0].totalBytes, VOICE_MODEL_TOTAL_BYTES);
  assertEqual(progress[progress.length - 1].loadedBytes, VOICE_MODEL_TOTAL_BYTES, 'and ends at the total');
  assertDeepEqual(deps.putUrls, [
    voiceModelFileUrl(VOICE_MODEL_DATA_FILE),
    voiceModelFileUrl(VOICE_MODEL_WASM_FILE),
  ], 'both the model data and the engine wasm are cached');
});

await runCase('a cached, correctly sized package skips the network entirely', async () => {
  const deps = createFakeDeps({ cached: true });
  assertEqual(await isVoiceModelCached(deps.value), true);
  const result = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(result.fromCache, true);
  assertDeepEqual(deps.fetchedUrls, [], 'nothing was downloaded again');
});

await runCase('a cached entry with the wrong length is re-downloaded', async () => {
  const deps = createFakeDeps({ cached: true, cachedDataBytes: 1_024 });
  assertEqual(await isVoiceModelCached(deps.value), false, 'a truncated entry is not a valid package');
  const result = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(result.fromCache, false);
  assertEqual(deps.fetchedUrls.length, 2, 'both files were fetched fresh');
});

await runCase('a quota failure reports storage-full and leaves no half-written cache', async () => {
  const quota = Object.assign(new Error('out of space'), { name: 'QuotaExceededError' });
  const deps = createFakeDeps({ putError: quota });
  let caught: unknown = null;
  try {
    await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError, 'a specific prepare error, not a generic one');
  assertEqual((caught as VoiceModelPrepareError).reason, 'storage-full');
  assert(
    deps.deletedCaches.includes(VOICE_MODEL_CACHE_NAME),
    'the partially written package was removed',
  );
  assertEqual(await isVoiceModelCached(deps.value), false, 'and nothing is left to mistake for a package');
});

await runCase('delete removes only the voice package cache', async () => {
  const deps = createFakeDeps({ cached: true, otherCaches: ['workbox-precache', 'staysee-images'] });
  assertEqual(await deleteVoiceModelPackage(deps.value), true);
  assertDeepEqual(deps.deletedCaches, [VOICE_MODEL_CACHE_NAME], 'exactly one named cache was targeted');
  assert(deps.cacheNames.includes('workbox-precache'), 'unrelated caches survive');
  assert(deps.cacheNames.includes('staysee-images'), 'unrelated caches survive');
});

await runCase('stale revision caches are purged and unrelated ones are kept', async () => {
  const deps = createFakeDeps({
    cached: true,
    otherCaches: ['staysee-voice-model-oldrev-large-int8', 'staysee-images'],
  });
  const removed = await purgeStaleVoiceModelCaches(deps.value);
  assertDeepEqual(removed, ['staysee-voice-model-oldrev-large-int8']);
  assert(deps.cacheNames.includes(VOICE_MODEL_CACHE_NAME), 'the current package survives');
  assert(deps.cacheNames.includes('staysee-images'), 'unrelated caches survive');
});

await runCase('a download that receives nothing for a full minute fails as a prepare error', async () => {
  const stuck: ResponseLike = {
    ok: true,
    status: 200,
    headers: { get: () => String(VOICE_MODEL_DATA_BYTES) },
    body: { getReader: () => ({ read: () => new Promise(() => undefined) }) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: stuck } });
  const pending = loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  await flushUntil(() => deps.pendingTimers > 0, 'the stall watchdog to arm');
  deps.advance(DOWNLOAD_STALL_TIMEOUT_MS);
  deps.fireTimers();
  let caught: unknown = null;
  try { await pending; } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'network');
});

await runCase('a tab that slept mid-download re-arms instead of failing', async () => {
  // Review Focus 1: the watchdog timer fires late after a suspend, so it
  // must judge by real elapsed time since the last byte, not by firing.
  // (The capture lives on an object rather than a bare `let` because a
  // bare `let` reassigned only inside this nested Promise executor gets
  // over-narrowed to `never` by TS's control-flow analysis at the call
  // site below — a plain property access is not subject to that quirk.)
  const released: { current: (() => void) | null } = { current: null };
  let delivered = false;
  const slow: ResponseLike = {
    ok: true,
    status: 200,
    headers: { get: () => String(VOICE_MODEL_DATA_BYTES) },
    body: {
      getReader: () => ({
        read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
          if (delivered) { resolve({ done: true }); return; }
          released.current = () => { delivered = true; resolve({ done: false, value: new Uint8Array(VOICE_MODEL_DATA_BYTES) }); };
        }),
      }),
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: slow } });
  const pending = loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  await flushUntil(() => deps.pendingTimers > 0, 'the stall watchdog to arm');
  // The timer fires, but only 1 ms of real time has passed.
  deps.advance(1);
  deps.fireTimers();
  assert(deps.pendingTimers > 0, 'the watchdog re-armed rather than failing the download');
  released.current?.();
  const result = await pending;
  assertEqual(result.dataBytes.byteLength, VOICE_MODEL_DATA_BYTES, 'the download completed normally');
});

await runCase('a missing Cache Storage still prepares, in memory', async () => {
  // Review Focus 5.
  const deps = createFakeDeps({ noCacheStorage: true });
  assertEqual(await isVoiceModelCached(deps.value), false);
  const result = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(result.fromCache, false);
  assertEqual(result.dataBytes.byteLength, VOICE_MODEL_DATA_BYTES, 'voice input still works this session');
  assertEqual(await deleteVoiceModelPackage(deps.value), false, 'deleting is a harmless no-op');
  assertDeepEqual(await purgeStaleVoiceModelCaches(deps.value), []);
});

await runCase('cancelling aborts the in-flight fetch and reports cancelled', async () => {
  // (See the object-wrapped capture note above: a bare `let` reassigned
  // only inside this nested Promise executor gets over-narrowed to
  // `never` by TS at the call site below.)
  const released: { current: ((step: { done: boolean; value?: Uint8Array }) => void) | null } = { current: null };
  const slow: ResponseLike = {
    ok: true,
    status: 200,
    headers: { get: () => String(VOICE_MODEL_DATA_BYTES) },
    body: { getReader: () => ({ read: () => new Promise((resolve) => { released.current = resolve; }) }) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: slow } });
  const signal = externalSignal();
  const pending = loadVoiceModelPackage(deps.value, { onProgress: () => undefined, signal: signal.value });
  // Wait for the read to actually be in flight before cancelling, so this
  // exercises aborting a fetch that is genuinely under way (not a signal
  // that happens to already be aborted before the download ever starts).
  await flushUntil(() => released.current !== null, 'the in-flight read to begin');
  signal.abort();
  released.current?.({ done: true });
  let caught: unknown = null;
  try { await pending; } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'cancelled');
});

await runCase('an HTTP 404 from a mistyped revision path fails as a prepare error', async () => {
  const missing: ResponseLike = {
    ok: false,
    status: 404,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: missing } });
  let caught: unknown = null;
  try { await loadVoiceModelPackage(deps.value, { onProgress: () => undefined }); } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'network');
});

await runCase('a short body fails instead of reaching the engine', async () => {
  const short = fakeResponse(VOICE_MODEL_DATA_BYTES - 1);
  const deps = createFakeDeps({ responses: { [voiceModelFileUrl(VOICE_MODEL_DATA_FILE)]: short } });
  let caught: unknown = null;
  try { await loadVoiceModelPackage(deps.value, { onProgress: () => undefined }); } catch (error) { caught = error; }
  assert(caught instanceof VoiceModelPrepareError);
  assertEqual((caught as VoiceModelPrepareError).reason, 'network');
  assertDeepEqual(deps.putUrls, [], 'a broken download is never cached');
});

await runCase('a cache another tab filled mid-download is overwritten, not an error', async () => {
  // Review Focus 2, storage half: two tabs can both download and both
  // write. The second write must simply win.
  const deps = createFakeDeps();
  await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  const second = await loadVoiceModelPackage(deps.value, { onProgress: () => undefined });
  assertEqual(second.fromCache, true, 'the second attempt now reads the cache the first filled');
});

console.log('voiceModelCache.cases.test.ts — all passed');
