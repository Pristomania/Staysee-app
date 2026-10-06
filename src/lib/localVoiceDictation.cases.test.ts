import type {
  VoiceDictationErrorCode,
  VoiceDictationPrepareProgress,
  VoiceRecognitionEvent,
} from './voiceDictationContract';
import { VOICE_MODEL_BASE_URL, VOICE_MODEL_TOTAL_BYTES, type VoiceModelPackage } from './voiceModelCache';
import {
  createLocalVoiceDictationAdapter,
  WORKER_INIT_TIMEOUT_MS,
  type LocalVoicePlatform,
  type MessagePortLike,
  type VoiceCaptureGraph,
} from './localVoiceDictation';

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

interface Recorded {
  levels: number[];
  transcripts: VoiceRecognitionEvent[];
  prepare: Array<VoiceDictationPrepareProgress | null>;
  errors: VoiceDictationErrorCode[];
  starts: number;
  ends: number;
  order: string[];
}

function recorder() {
  const log: Recorded = {
    levels: [], transcripts: [], prepare: [], errors: [], starts: 0, ends: 0, order: [],
  };
  return {
    log,
    callbacks: {
      onStart() { log.starts += 1; log.order.push('start'); },
      onPrepareProgress(progress: VoiceDictationPrepareProgress | null) { log.prepare.push(progress); },
      onTranscript(event: VoiceRecognitionEvent) { log.transcripts.push(event); },
      onLevel(level: number) { log.levels.push(level); log.order.push('level'); },
      onError(code: VoiceDictationErrorCode) { log.errors.push(code); },
      onEnd() { log.ends += 1; },
    },
  };
}

function createFakePlatform(options: {
  capable?: boolean;
  cached?: boolean;
  loadRejects?: boolean;
  getUserMediaRejects?: boolean;
  workletRejects?: boolean;
} = {}) {
  let workerCalls = 0;
  let getUserMediaCalls = 0;
  let abortCalls = 0;
  let graphDisconnects = 0;
  let contextCloses = 0;
  let terminateCalls = 0;
  let addedModuleUrl: string | null = null;
  let graphProcessorName: string | null = null;
  const posted: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const track = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  const stream = { getTracks: () => [track] };
  let progressSink: ((progress: VoiceDictationPrepareProgress) => void) | null = null;
  let releaseLoad: ((pkg: VoiceModelPackage) => void) | null = null;
  let rejectLoad: ((error: Error) => void) | null = null;
  let capturePort: MessagePortLike | null = null;
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; ms: number }>();

  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message?: string }) => void) | null,
    postMessage(message: unknown) {
      const record = message as Record<string, unknown>;
      posted.push(record);
      order.push(record.type === 'audio' ? 'post' : `post:${String(record.type)}`);
    },
    terminate() { terminateCalls += 1; },
  };

  const graph: VoiceCaptureGraph = {
    port: { onmessage: null, close() { /* nothing to close in the fake */ } },
    disconnect() { graphDisconnects += 1; },
  };

  const value: LocalVoicePlatform = {
    createWorker: options.capable === false ? null : () => { workerCalls += 1; return worker; },
    createAudioContext: options.capable === false ? null : () => ({
      sampleRate: 48_000,
      async addWorkletModule(url: string) {
        if (options.workletRejects) throw new Error('RAW_WORKLET_SENTINEL');
        addedModuleUrl = url;
      },
      createCaptureGraph(_stream, processorName) {
        graphProcessorName = processorName;
        capturePort = graph.port;
        return graph;
      },
      async resume() { /* already running in the fake */ },
      async close() { contextCloses += 1; },
    }),
    getUserMedia: options.capable === false ? null : async () => {
      getUserMediaCalls += 1;
      if (options.getUserMediaRejects) throw new Error('RAW_MEDIA_SENTINEL');
      return stream;
    },
    model: options.capable === false ? null : {
      isCached: async () => options.cached === true,
      load: (loadOptions) => {
        progressSink = loadOptions.onProgress;
        return new Promise<VoiceModelPackage>((resolve, reject) => {
          releaseLoad = resolve;
          rejectLoad = reject;
          if (options.loadRejects) reject(new Error('RAW_DOWNLOAD_SENTINEL'));
        });
      },
    },
    createAbortController: () => {
      const listeners: Array<() => void> = [];
      let aborted = false;
      return {
        signal: {
          get aborted() { return aborted; },
          addEventListener(_type: 'abort', listener: () => void) { listeners.push(listener); },
          removeEventListener() { /* nothing to detach in the fake */ },
        },
        abort() { abortCalls += 1; aborted = true; for (const listener of listeners) listener(); },
      };
    },
    captureProcessorUrl: 'blob:worklet',
    engineScriptUrls: [
      '/voice-engine/sherpa-onnx-asr.js',
      '/voice-engine/sherpa-onnx-wasm-main-asr.js',
    ],
    modelBaseUrl: VOICE_MODEL_BASE_URL,
    setTimeout(callback, ms) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  return {
    value,
    posted,
    order,
    track,
    get workerCalls() { return workerCalls; },
    get getUserMediaCalls() { return getUserMediaCalls; },
    get abortCalls() { return abortCalls; },
    get graphDisconnects() { return graphDisconnects; },
    get contextCloses() { return contextCloses; },
    get terminateCalls() { return terminateCalls; },
    get addedModuleUrl() { return addedModuleUrl; },
    get graphProcessorName() { return graphProcessorName; },
    emitProgress(loadedBytes: number) {
      progressSink?.({ loadedBytes, totalBytes: VOICE_MODEL_TOTAL_BYTES });
    },
    finishLoad() {
      releaseLoad?.({
        dataBytes: new ArrayBuffer(8),
        wasmBytes: new ArrayBuffer(4),
        fromCache: options.cached === true,
      });
    },
    failLoad() { rejectLoad?.(new Error('RAW_DOWNLOAD_SENTINEL')); },
    reply(reply: { id: number; ok: boolean; error?: string; text?: string }) {
      worker.onmessage?.({ data: reply });
    },
    emitPartial(text: string) { worker.onmessage?.({ data: { type: 'partial', text } }); },
    emitWorkerError() { worker.onerror?.({ message: 'RAW_WORKER_SENTINEL' }); },
    emitAudio(samples: Float32Array) { capturePort?.onmessage?.({ data: samples }); },
    lastRequestId(type: string) {
      const match = [...posted].reverse().find((message) => message.type === type);
      assert(match, `no ${type} request was posted`);
      return match.id as number;
    },
    fireTimersOfDuration(ms: number) {
      const matched = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id] of matched) timers.delete(id);
      for (const [, timer] of matched) timer.callback();
    },
    get pendingTimerDurations() { return [...timers.values()].map((timer) => timer.ms); },
  };
}

/** Lets the adapter's own awaited microtasks run between assertions. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

await runCase('reports unsupported without creating a worker or touching the microphone', () => {
  const platform = createFakePlatform({ capable: false });
  const adapter = createLocalVoiceDictationAdapter(platform.value);
  assertEqual(adapter.supported, false);
  assertEqual(platform.workerCalls, 0);
  assertEqual(platform.getUserMediaCalls, 0);
});

await runCase('enters preparing at once and reports byte progress while downloading', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  assertDeepEqual(sink.log.prepare[0], null, 'preparation is announced before anything is known');
  await settle();
  assertDeepEqual(
    sink.log.prepare[1],
    { loadedBytes: 0, totalBytes: VOICE_MODEL_TOTAL_BYTES },
    'a bar can appear immediately for a first download',
  );
  platform.emitProgress(1_000_000);
  assertDeepEqual(sink.log.prepare[2], { loadedBytes: 1_000_000, totalBytes: VOICE_MODEL_TOTAL_BYTES });
  assertEqual(sink.log.starts, 0, 'preparation is not listening');
  session.dispose();
});

await runCase('a cached package never claims a byte bar', async () => {
  const platform = createFakePlatform({ cached: true });
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  assert(
    sink.log.prepare.every((entry) => entry === null),
    'opening an already-downloaded model has no progress to show',
  );
  session.dispose();
});

await runCase('sends the model bytes, base URL and exact engine script URLs to the worker', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  const load = platform.posted.find((message) => message.type === 'load');
  assert(load, 'a load request was posted');
  assertEqual((load.dataBytes as ArrayBuffer).byteLength, 8);
  assertEqual((load.wasmBytes as ArrayBuffer).byteLength, 4);
  assertEqual(load.modelBaseUrl, 'https://staysee.ru/voice-model/83bbf6f-large-int8/');
  assertDeepEqual(load.engineScriptUrls, [
    '/voice-engine/sherpa-onnx-asr.js',
    '/voice-engine/sherpa-onnx-wasm-main-asr.js',
  ], 'the wrapper loads before the Emscripten runtime');
  assertDeepEqual(sink.log.prepare[sink.log.prepare.length - 1], null, 'the bar gives way to engine init');
  session.dispose();
});

await runCase('a download failure reports prepare-failed and never leaks the raw error', async () => {
  const platform = createFakePlatform({ loadRejects: true });
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  assertDeepEqual(sink.log.errors, ['prepare-failed']);
  assert(!JSON.stringify(sink.log).includes('RAW_DOWNLOAD_SENTINEL'), 'raw errors stay inside the module');
  assertEqual(platform.terminateCalls, 1, 'the worker is released');
});

await runCase('a worker that never acknowledges load fails after the init watchdog', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  assert(
    platform.pendingTimerDurations.includes(WORKER_INIT_TIMEOUT_MS),
    'engine init gets its own generous watchdog, separate from the download',
  );
  platform.fireTimersOfDuration(WORKER_INIT_TIMEOUT_MS);
  await settle();
  assertDeepEqual(sink.log.errors, ['prepare-failed']);
});

await runCase('a worker failure reply during preparation reports prepare-failed', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: false, error: 'RAW_WORKER_SENTINEL' });
  await settle();
  assertDeepEqual(sink.log.errors, ['prepare-failed']);
  assert(!JSON.stringify(sink.log).includes('RAW_WORKER_SENTINEL'), 'engine diagnostics never surface');
});

await runCase('stop during preparing aborts the download and ends without an error', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.emitProgress(5_000_000);
  session.stop();
  assertEqual(platform.abortCalls, 1, 'the in-flight fetch is aborted, not left to finish');
  assertEqual(sink.log.ends, 1, 'cancelling is not a failure');
  assertDeepEqual(sink.log.errors, []);
  assertEqual(platform.terminateCalls, 1);
  platform.finishLoad();
  await settle();
  assertEqual(sink.log.starts, 0, 'a late download completion cannot start a cancelled session');
});

await runCase('dispose during preparing releases everything and ignores late replies', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  session.dispose();
  session.dispose();
  assertEqual(platform.abortCalls, 1, 'dispose is idempotent');
  assertEqual(platform.terminateCalls, 1);
  platform.finishLoad();
  platform.emitPartial('поздно');
  platform.reply({ id: 1, ok: true });
  await settle();
  assertDeepEqual(sink.log.transcripts, [], 'late worker messages are ignored');
  assertEqual(sink.log.ends, 0, 'a disposed session reports nothing');
});

await runCase('one adapter start creates exactly one worker', async () => {
  // Review Focus 2, in-tab half: nothing here may create a second engine.
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.emitProgress(1);
  platform.emitProgress(2);
  assertEqual(platform.workerCalls, 1);
  session.dispose();
});

console.log('localVoiceDictation.cases.test.ts — all passed');
