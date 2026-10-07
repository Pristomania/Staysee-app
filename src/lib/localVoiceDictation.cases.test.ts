import type {
  VoiceDictationAdapter,
  VoiceDictationErrorCode,
  VoiceDictationPrepareProgress,
  VoiceRecognitionEvent,
} from './voiceDictationContract';
import { VOICE_MODEL_BASE_URL, VOICE_MODEL_TOTAL_BYTES, type VoiceModelPackage } from './voiceModelCache';
import {
  createLocalVoiceDictationAdapter,
  CAPTURE_PROCESSOR_NAME,
  MAX_RECORDING_MS,
  WORKER_CONTROL_TIMEOUT_MS,
  WORKER_FINISH_TIMEOUT_MS,
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

// Set by the most recently created fake platform (below), so that
// `recorder()` — created with no knowledge of which platform it is paired
// with — can still record `onLevel` calls onto that platform's own
// `order` log. This is what lets a case assert the real call order between
// a callback (onLevel) and a platform effect (postMessage) across the two
// otherwise-separate fakes, without changing either fake's public shape.
let currentCaptureOrder: string[] | null = null;

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
      onLevel(level: number) {
        log.levels.push(level);
        log.order.push('level');
        currentCaptureOrder?.push('level');
      },
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
  let isCachedCalls = 0;
  let loadCalls = 0;
  let getUserMediaCalls = 0;
  let abortCalls = 0;
  let graphDisconnects = 0;
  let contextCloses = 0;
  let terminateCalls = 0;
  let addedModuleUrl: string | null = null;
  let graphProcessorName: string | null = null;
  const posted: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  // See `currentCaptureOrder` above: this platform's `order` becomes the
  // shared timeline that `recorder()`'s `onLevel` also writes into.
  currentCaptureOrder = order;
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
      isCached: async () => { isCachedCalls += 1; return options.cached === true; },
      load: (loadOptions) => {
        loadCalls += 1;
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
    get isCachedCalls() { return isCachedCalls; },
    get loadCalls() { return loadCalls; },
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

/** Drives a fake session all the way to listening. */
async function startListening(
  platform: ReturnType<typeof createFakePlatform>,
  sink: ReturnType<typeof recorder>,
  adapter: VoiceDictationAdapter = createLocalVoiceDictationAdapter(platform.value),
) {
  const session = await adapter.start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  platform.reply({ id: platform.lastRequestId('start'), ok: true });
  await settle();
  return session;
}

await runCase('loads the worklet module and reports listening once capture is wired', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  assertEqual(platform.getUserMediaCalls, 1, 'one microphone stream for recognition and the level alike');
  assertEqual(platform.addedModuleUrl, 'blob:worklet', 'the AudioWorklet module is registered');
  assertEqual(platform.graphProcessorName, CAPTURE_PROCESSOR_NAME);
  assertEqual(sink.log.starts, 1, 'listening is announced only after capture is live');
  session.dispose();
});

await runCase('microphone refusal reports permission-denied without leaking the raw error', async () => {
  const platform = createFakePlatform({ getUserMediaRejects: true });
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  assertDeepEqual(sink.log.errors, ['permission-denied']);
  assert(!JSON.stringify(sink.log).includes('RAW_MEDIA_SENTINEL'));
});

await runCase('a context without AudioWorklet reports unsupported', async () => {
  const platform = createFakePlatform({ workletRejects: true });
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  assertDeepEqual(sink.log.errors, ['unsupported']);
  assert(!JSON.stringify(sink.log).includes('RAW_WORKLET_SENTINEL'));
  assertEqual(platform.contextCloses, 1, 'the audio context is released');
});

await runCase('captured audio is measured before its buffer is transferred to the worker', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.order.length = 0;
  platform.emitAudio(new Float32Array([1, -1, 1, -1]));
  assertDeepEqual(platform.order, ['level', 'post'], 'postMessage detaches the view, so level comes first');
  assertEqual(sink.log.levels[sink.log.levels.length - 1], 1, 'the level is real, from the recognition stream');
  const audio = platform.posted[platform.posted.length - 1];
  assertEqual(audio.type, 'audio');
  assertEqual(audio.sampleRate, 48_000, 'the context rate travels with the samples');
  session.dispose();
});

await runCase('partial text is interim and the finish reply becomes the final text', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('привет');
  platform.emitPartial('привет как дела');
  assertDeepEqual(sink.log.transcripts, [
    { finalText: '', interimText: 'привет' },
    { finalText: '', interimText: 'привет как дела' },
  ], 'cumulative partial text never duplicates');
  session.stop();
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'привет как дела' });
  await settle();
  assertDeepEqual(
    sink.log.transcripts[sink.log.transcripts.length - 1],
    { finalText: 'привет как дела', interimText: '' },
  );
  assertEqual(sink.log.ends, 1);
});

await runCase('stop releases the microphone before waiting for the tail, and ends once', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('текст');
  session.stop();
  session.stop();
  assertEqual(platform.track.stopCalls, 1, 'the recording indicator goes out immediately');
  assertEqual(platform.graphDisconnects, 1, 'the capture graph is torn down once');
  const finishRequests = platform.posted.filter((message) => message.type === 'finish');
  assertEqual(finishRequests.length, 1, 'a second stop is a no-op');
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'текст' });
  await settle();
  assertEqual(sink.log.ends, 1);
});

await runCase('a ten-minute recording stops itself at the hard cap', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await startListening(platform, sink);
  platform.emitPartial('долгая речь');
  assert(platform.pendingTimerDurations.includes(MAX_RECORDING_MS), 'the cap is armed when listening starts');
  assertEqual(MAX_RECORDING_MS, 600_000, 'ten minutes exactly');
  platform.fireTimersOfDuration(MAX_RECORDING_MS);
  await settle();
  assertEqual(platform.track.stopCalls, 1, 'the microphone is released automatically');
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'долгая речь' });
  await settle();
  assertEqual(sink.log.ends, 1);
  assertDeepEqual(sink.log.errors, []);
});

await runCase('a finish the worker never answers keeps the partial text instead of losing it', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('почти всё');
  session.stop();
  await settle();
  assert(platform.pendingTimerDurations.includes(WORKER_FINISH_TIMEOUT_MS), 'finish has its own watchdog');
  platform.fireTimersOfDuration(WORKER_FINISH_TIMEOUT_MS);
  await settle();
  assertDeepEqual(
    sink.log.transcripts[sink.log.transcripts.length - 1],
    { finalText: 'почти всё', interimText: '' },
    'the dictation the person already saw is kept',
  );
  assertEqual(sink.log.ends, 1);
  assertDeepEqual(sink.log.errors, []);
});

await runCase('a worker crash while finishing keeps the partial text instead of losing it', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  platform.emitPartial('почти всё');
  session.stop();
  await settle();
  platform.emitWorkerError();
  await settle();
  assertDeepEqual(
    sink.log.transcripts[sink.log.transcripts.length - 1],
    { finalText: 'почти всё', interimText: '' },
    'a crash during tail-decode keeps the dictation the person already saw',
  );
  assertEqual(sink.log.ends, 1);
  assertDeepEqual(sink.log.errors, [], 'the fallback to partial text must not also report recognition-failed');
});

await runCase('silence reports no-speech and never advises another browser', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  session.stop();
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: '' });
  await settle();
  assertDeepEqual(sink.log.errors, ['no-speech']);
  assert(
    !sink.log.errors.includes('connection-blocked'),
    'on-device recognition has no cloud service to be blocked from',
  );
});

await runCase('a worker that never acknowledges start reports recognition-failed', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
  await settle();
  platform.finishLoad();
  await settle();
  platform.reply({ id: platform.lastRequestId('load'), ok: true });
  await settle();
  assert(
    platform.pendingTimerDurations.includes(WORKER_CONTROL_TIMEOUT_MS),
    'a control message gets a short watchdog, not the download-sized one',
  );
  platform.fireTimersOfDuration(WORKER_CONTROL_TIMEOUT_MS);
  await settle();
  assertDeepEqual(sink.log.errors, ['recognition-failed']);
  assertEqual(sink.log.starts, 0);
});

await runCase('a worker crash while listening reports recognition-failed without diagnostics', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  await startListening(platform, sink);
  platform.emitWorkerError();
  assertDeepEqual(sink.log.errors, ['recognition-failed']);
  assert(!JSON.stringify(sink.log).includes('RAW_WORKER_SENTINEL'));
  assertEqual(platform.track.stopCalls, 1, 'the microphone is released on a crash');
  assertEqual(platform.terminateCalls, 1);
});

await runCase('dispose while listening releases graph, tracks, context and worker', async () => {
  const platform = createFakePlatform();
  const sink = recorder();
  const session = await startListening(platform, sink);
  session.dispose();
  assertEqual(platform.graphDisconnects, 1);
  assertEqual(platform.track.stopCalls, 1);
  assertEqual(platform.contextCloses, 1);
  assertEqual(platform.terminateCalls, 1);
  platform.emitAudio(new Float32Array([1, 1]));
  platform.emitPartial('поздно');
  assertEqual(sink.log.ends, 0, 'a disposed session reports nothing');
  assert(
    !sink.log.transcripts.some((event) => event.interimText === 'поздно'),
    'late capture and worker events are ignored',
  );
});

await runCase('the adapter only ever emits allowlisted, on-device-appropriate codes', async () => {
  const seen = new Set<VoiceDictationErrorCode>();
  for (const build of [
    () => createFakePlatform({ loadRejects: true }),
    () => createFakePlatform({ getUserMediaRejects: true }),
    () => createFakePlatform({ workletRejects: true }),
  ]) {
    const platform = build();
    const sink = recorder();
    await createLocalVoiceDictationAdapter(platform.value).start(sink.callbacks);
    await settle();
    platform.finishLoad();
    await settle();
    platform.reply({ id: 1, ok: true });
    await settle();
    for (const code of sink.log.errors) seen.add(code);
  }
  for (const code of seen) {
    assert(
      ['prepare-failed', 'permission-denied', 'unsupported', 'no-speech', 'recognition-failed'].includes(code),
      `unexpected error code from the on-device adapter: ${code}`,
    );
  }
  assert(!seen.has('connection-blocked'), 'there is no recognition service to be blocked from');
});

await runCase('a second recording in the same page session reuses the already-loaded engine', async () => {
  // Terminating and recreating the worker on every single recording meant
  // re-running the ~5s WASM compile + model load each time, even though the
  // downloaded bytes were already cached -- this is exactly the delay a
  // real person reported hitting on every microphone press, not just the
  // first. Starting a second time after a clean stop must skip both the
  // cache probe and the worker 'load' message entirely.
  const platform = createFakePlatform();
  const sink = recorder();
  const adapter = createLocalVoiceDictationAdapter(platform.value);

  const first = await startListening(platform, sink, adapter);
  assertEqual(platform.workerCalls, 1);
  assertEqual(platform.isCachedCalls, 1);
  assertEqual(platform.loadCalls, 1);
  first.stop();
  await settle();
  platform.reply({ id: platform.lastRequestId('finish'), ok: true, text: 'первая фраза' });
  await settle();
  assertEqual(sink.log.ends, 1);
  assertEqual(platform.terminateCalls, 0, 'a clean stop keeps the engine warm instead of tearing it down');

  const second = await adapter.start(sink.callbacks);
  await settle();
  assertEqual(platform.workerCalls, 1, 'no second worker was created');
  assertEqual(platform.isCachedCalls, 1, 'the cache was never probed again');
  assertEqual(platform.loadCalls, 1, 'the engine was never reloaded');
  assertDeepEqual(
    sink.log.prepare.slice(-2),
    [null, null],
    'reuse has nothing to report progress on, so preparing stays indeterminate-and-brief rather than claiming a byte bar',
  );
  const startRequests = platform.posted.filter((message) => message.type === 'start');
  assertEqual(startRequests.length, 2, 'the worker gets a fresh start message for the new session');
  platform.reply({ id: platform.lastRequestId('start'), ok: true });
  await settle();
  assertEqual(sink.log.starts, 2, 'listening began a second time on the same warm engine');
  second.dispose();
});

await runCase('a worker crash means the next recording starts the engine fresh', async () => {
  // A crashed worker cannot be trusted to still hold a working recognizer --
  // reuse must never apply to a session that ended abnormally.
  const platform = createFakePlatform();
  const sink = recorder();
  const adapter = createLocalVoiceDictationAdapter(platform.value);

  await startListening(platform, sink);
  assertEqual(platform.workerCalls, 1);
  platform.emitWorkerError();
  assertDeepEqual(sink.log.errors, ['recognition-failed']);
  assertEqual(platform.terminateCalls, 1, 'the crashed worker is torn down, not kept for reuse');

  const second = await adapter.start(sink.callbacks);
  await settle();
  assertEqual(platform.workerCalls, 2, 'a fresh worker replaces the crashed one');
  assertEqual(platform.isCachedCalls, 2, 'the cache is probed again rather than trusting stale state');
  second.dispose();
});

await runCase('dispose while listening tears the engine down instead of keeping it warm', async () => {
  // Disposal means the component is genuinely going away (leaving the chat
  // screen entirely) -- unlike a plain stop between recordings, this is the
  // one signal that really does mean "done with voice dictation for now",
  // so it still fully releases the worker.
  const platform = createFakePlatform();
  const sink = recorder();
  const adapter = createLocalVoiceDictationAdapter(platform.value);

  const session = await startListening(platform, sink);
  session.dispose();
  assertEqual(platform.terminateCalls, 1, 'dispose always tears the engine down, unlike a clean stop');

  const second = await adapter.start(sink.callbacks);
  await settle();
  assertEqual(platform.workerCalls, 2, 'a fresh worker is created after disposal');
  assertEqual(platform.isCachedCalls, 2);
  second.dispose();
});

console.log('localVoiceDictation.cases.test.ts — all passed');
