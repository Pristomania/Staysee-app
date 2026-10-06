import type { VoiceDictationPrepareProgress } from './voiceDictationContract';

/** Bump this one string when the model or engine build changes. */
export const VOICE_MODEL_REVISION = '83bbf6f-large-int8';
export const VOICE_MODEL_BASE_URL = `https://staysee.ru/voice-model/${VOICE_MODEL_REVISION}/`;
export const VOICE_MODEL_CACHE_PREFIX = 'staysee-voice-model-';
export const VOICE_MODEL_CACHE_NAME = `${VOICE_MODEL_CACHE_PREFIX}${VOICE_MODEL_REVISION}`;

export const VOICE_MODEL_DATA_FILE = 'sherpa-onnx-wasm-main-asr.data';
export const VOICE_MODEL_WASM_FILE = 'sherpa-onnx-wasm-main-asr.wasm';
export const VOICE_MODEL_DATA_BYTES = 71_694_239;
export const VOICE_MODEL_WASM_BYTES = 11_545_586;
export const VOICE_MODEL_TOTAL_BYTES = VOICE_MODEL_DATA_BYTES + VOICE_MODEL_WASM_BYTES;

/**
 * A download is judged dead only when it has received nothing at all for a
 * full minute. There is deliberately no overall deadline: even a 50 kbit/s
 * connection delivers a 16 KB body chunk every few seconds, so a slow but
 * living download keeps re-arming this watchdog, while a socket that has
 * gone silent for sixty seconds is genuinely stuck.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

export type VoiceModelPrepareReason = 'network' | 'storage-full' | 'cancelled';

export class VoiceModelPrepareError extends Error {
  readonly reason: VoiceModelPrepareReason;

  constructor(reason: VoiceModelPrepareReason, message: string) {
    super(message);
    this.name = 'VoiceModelPrepareError';
    this.reason = reason;
  }
}

export interface VoiceModelPackage {
  dataBytes: ArrayBuffer;
  wasmBytes: ArrayBuffer;
  fromCache: boolean;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

export interface ResponseBodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): ResponseBodyReaderLike } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CacheLike {
  match(request: string): Promise<ResponseLike | undefined>;
  put(request: string, response: ResponseLike): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface VoiceModelCacheDeps {
  /** `null` when the browser context has no Cache Storage at all. */
  caches: CacheStorageLike | null;
  fetch(url: string, init: { signal: AbortSignalLike }): Promise<ResponseLike>;
  createResponse(bytes: ArrayBuffer): ResponseLike;
  createAbortController(): AbortControllerLike;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): number;
}

interface ModelFile {
  name: string;
  bytes: number;
}

const FILES: readonly ModelFile[] = [
  { name: VOICE_MODEL_DATA_FILE, bytes: VOICE_MODEL_DATA_BYTES },
  { name: VOICE_MODEL_WASM_FILE, bytes: VOICE_MODEL_WASM_BYTES },
];

export function voiceModelFileUrl(fileName: string): string {
  return `${VOICE_MODEL_BASE_URL}${fileName}`;
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return (
    named.name === 'QuotaExceededError'
    || named.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || named.code === 22
  );
}

async function openCache(deps: VoiceModelCacheDeps): Promise<CacheLike | null> {
  if (!deps.caches) return null;
  try {
    return await deps.caches.open(VOICE_MODEL_CACHE_NAME);
  } catch {
    // A context that advertises Cache Storage but refuses to open it is
    // treated exactly like one that has none: download into memory.
    return null;
  }
}

async function matchValid(cache: CacheLike, file: ModelFile): Promise<ResponseLike | null> {
  try {
    const hit = await cache.match(voiceModelFileUrl(file.name));
    if (!hit) return null;
    const header = hit.headers.get('content-length');
    const length = header === null ? Number.NaN : Number(header);
    // A truncated entry (an interrupted write, a partial eviction) must be
    // re-downloaded, never handed to the WASM engine as a valid model.
    return length === file.bytes ? hit : null;
  } catch {
    return null;
  }
}

export async function isVoiceModelCached(deps: VoiceModelCacheDeps): Promise<boolean> {
  const cache = await openCache(deps);
  if (!cache) return false;
  for (const file of FILES) {
    if (!(await matchValid(cache, file))) return false;
  }
  return true;
}

export async function deleteVoiceModelPackage(deps: VoiceModelCacheDeps): Promise<boolean> {
  if (!deps.caches) return false;
  try {
    // Exactly one named cache. Nothing enumerates, nothing else is touched:
    // the account, the conversations and every other site cache survive.
    return await deps.caches.delete(VOICE_MODEL_CACHE_NAME);
  } catch {
    return false;
  }
}

export async function purgeStaleVoiceModelCaches(deps: VoiceModelCacheDeps): Promise<string[]> {
  if (!deps.caches) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = await deps.caches.keys();
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(VOICE_MODEL_CACHE_PREFIX)) continue;
    if (name === VOICE_MODEL_CACHE_NAME) continue;
    try {
      if (await deps.caches.delete(name)) removed.push(name);
    } catch {
      // A cache that refuses to be removed is not worth failing a session for.
    }
  }
  return removed;
}

interface DownloadContext {
  loadedBytes: number;
  onProgress(progress: VoiceDictationPrepareProgress): void;
}

async function downloadFile(
  deps: VoiceModelCacheDeps,
  file: ModelFile,
  options: { signal?: AbortSignalLike },
  context: DownloadContext,
): Promise<ArrayBuffer> {
  const controller = deps.createAbortController();
  const abortFromCaller = () => controller.abort();
  let lastProgressAt = deps.now();
  let stallTimerId: number | null = null;
  let stalled = false;

  if (options.signal) {
    if (options.signal.aborted) {
      throw new VoiceModelPrepareError('cancelled', 'voice_model_download_cancelled');
    }
    options.signal.addEventListener('abort', abortFromCaller);
  }

  const armStallTimer = () => {
    stallTimerId = deps.setTimeout(() => {
      stallTimerId = null;
      // Timers in a suspended or backgrounded tab fire late, never early.
      // Measuring the real gap means a laptop that slept for an hour
      // mid-download re-arms instead of killing a healthy download.
      if (deps.now() - lastProgressAt < DOWNLOAD_STALL_TIMEOUT_MS) {
        armStallTimer();
        return;
      }
      stalled = true;
      controller.abort();
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  };

  const disarm = () => {
    if (stallTimerId !== null) deps.clearTimeout(stallTimerId);
    stallTimerId = null;
    options.signal?.removeEventListener('abort', abortFromCaller);
  };

  try {
    const response = await deps.fetch(voiceModelFileUrl(file.name), { signal: controller.signal });
    if (!response.ok) {
      // A revision-path typo arrives here as a 404 and must be loud.
      throw new VoiceModelPrepareError('network', `voice_model_http_${response.status}`);
    }

    let bytes: ArrayBuffer;
    if (!response.body) {
      bytes = await response.arrayBuffer();
      context.loadedBytes += bytes.byteLength;
      context.onProgress({ loadedBytes: context.loadedBytes, totalBytes: VOICE_MODEL_TOTAL_BYTES });
    } else {
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let received = 0;
      armStallTimer();
      // Calling controller.abort() only flips a flag unless something is
      // listening for it: a read that is genuinely stuck (zero bytes,
      // forever) never settles on its own, so the stall watchdog and a
      // caller's cancellation must be able to interrupt a pending
      // reader.read() directly, not merely hope the fetch plumbing notices.
      let rejectAborted!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
      const onControllerAbort = () => rejectAborted(new Error('voice_model_download_aborted'));
      controller.signal.addEventListener('abort', onControllerAbort);
      try {
        for (;;) {
          const step = await Promise.race([reader.read(), aborted]);
          if (step.done) break;
          if (!step.value) continue;
          parts.push(step.value);
          received += step.value.byteLength;
          lastProgressAt = deps.now();
          context.onProgress({
            loadedBytes: context.loadedBytes + received,
            totalBytes: VOICE_MODEL_TOTAL_BYTES,
          });
        }
      } finally {
        controller.signal.removeEventListener('abort', onControllerAbort);
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      parts.length = 0;
      context.loadedBytes += received;
      bytes = merged.buffer;
    }

    if (bytes.byteLength !== file.bytes) {
      // A short or over-long body means the deployed file is not the one
      // this revision was built against. Failing beats feeding the engine
      // bytes it will crash on, or silently caching a broken model.
      throw new VoiceModelPrepareError(
        'network',
        `voice_model_size_mismatch_${bytes.byteLength}`,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof VoiceModelPrepareError) throw error;
    if (stalled) throw new VoiceModelPrepareError('network', 'voice_model_download_stalled');
    if (options.signal?.aborted) {
      throw new VoiceModelPrepareError('cancelled', 'voice_model_download_cancelled');
    }
    throw new VoiceModelPrepareError('network', 'voice_model_download_failed');
  } finally {
    disarm();
  }
}

export async function loadVoiceModelPackage(
  deps: VoiceModelCacheDeps,
  options: {
    onProgress(progress: VoiceDictationPrepareProgress): void;
    signal?: AbortSignalLike;
  },
): Promise<VoiceModelPackage> {
  await purgeStaleVoiceModelCaches(deps);
  const cache = await openCache(deps);

  if (cache) {
    const hits: ResponseLike[] = [];
    for (const file of FILES) {
      const hit = await matchValid(cache, file);
      if (!hit) { hits.length = 0; break; }
      hits.push(hit);
    }
    if (hits.length === FILES.length) {
      try {
        const dataBytes = await hits[0].arrayBuffer();
        const wasmBytes = await hits[1].arrayBuffer();
        return { dataBytes, wasmBytes, fromCache: true };
      } catch {
        // The entries looked right but would not read back; fall through
        // to a fresh download rather than failing the session.
      }
    }
  }

  const context: DownloadContext = { loadedBytes: 0, onProgress: options.onProgress };
  context.onProgress({ loadedBytes: 0, totalBytes: VOICE_MODEL_TOTAL_BYTES });
  const dataBytes = await downloadFile(deps, FILES[0], options, context);
  const wasmBytes = await downloadFile(deps, FILES[1], options, context);

  if (cache) {
    try {
      // Both files, not just the .data the prototype cached: the .wasm was
      // left to the ordinary HTTP cache and so was re-fetched whenever that
      // cache was evicted.
      await cache.put(voiceModelFileUrl(FILES[0].name), deps.createResponse(dataBytes));
      await cache.put(voiceModelFileUrl(FILES[1].name), deps.createResponse(wasmBytes));
    } catch (error) {
      // Leave no half-written package behind: it would be re-validated as
      // missing next time anyway, and it occupies the very disk space that
      // just ran out.
      await deleteVoiceModelPackage(deps);
      if (isQuotaError(error)) {
        throw new VoiceModelPrepareError('storage-full', 'voice_model_cache_quota_exceeded');
      }
      throw new VoiceModelPrepareError('network', 'voice_model_cache_write_failed');
    }
  }

  return { dataBytes, wasmBytes, fromCache: false };
}

export function browserVoiceModelCacheDeps(): VoiceModelCacheDeps {
  const cacheStorage = typeof window !== 'undefined' && 'caches' in window
    ? (window.caches as unknown as CacheStorageLike)
    : null;
  return {
    caches: cacheStorage,
    fetch: (url, init) => fetch(url, {
      signal: init.signal as unknown as AbortSignal,
      cache: 'default',
    }) as unknown as Promise<ResponseLike>,
    createResponse: (bytes) => new Response(bytes, {
      headers: {
        // Cache Storage preserves these; the length is what revalidates a
        // cached entry without reading 83 MB back off disk.
        'content-length': String(bytes.byteLength),
        'content-type': 'application/octet-stream',
      },
    }) as unknown as ResponseLike,
    createAbortController: () => new AbortController() as unknown as AbortControllerLike,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    now: () => Date.now(),
  };
}
