import type {
  VoiceDictationErrorCode,
  VoiceRecognitionEvent,
} from './voiceDictationContract';
import {
  createBrowserVoiceDictationAdapter,
  type BrowserVoicePlatform,
  type SpeechRecognitionLike,
} from './browserVoiceDictation';

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

function callbacks(overrides: Partial<{
  onStart(): void;
  onTranscript(event: VoiceRecognitionEvent): void;
  onLevel(level: number): void;
  onError(code: VoiceDictationErrorCode): void;
  onEnd(): void;
}> = {}) {
  return {
    onStart() {},
    onTranscript() {},
    onLevel() {},
    onError() {},
    onEnd() {},
    ...overrides,
  };
}

function createFakePlatform(options: {
  recognition?: boolean;
  getUserMediaRejects?: boolean;
} = {}) {
  let getUserMediaCalls = 0;
  let cancelAnimationFrameCalls = 0;
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const track = { stopCalls: 0, stop() { this.stopCalls += 1; } };
  const stream = { getTracks: () => [track] };
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 4,
    getByteTimeDomainData(array: Uint8Array) {
      array.set([128, 192, 128, 64]);
    },
  };
  const source = { connectCalls: 0, connect() { this.connectCalls += 1; } };
  const audioContext = {
    closeCalls: 0,
    createAnalyser: () => analyser,
    createMediaStreamSource: () => source,
    async close() { this.closeCalls += 1; },
  };
  const recognition: SpeechRecognitionLike & {
    startCalls: number;
    stopCalls: number;
    abortCalls: number;
  } = {
    lang: '',
    continuous: false,
    interimResults: false,
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    startCalls: 0,
    stopCalls: 0,
    abortCalls: 0,
    start() { this.startCalls += 1; },
    stop() { this.stopCalls += 1; },
    abort() { this.abortCalls += 1; },
  };

  const value: BrowserVoicePlatform = {
    createRecognition: options.recognition === false ? null : () => recognition,
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      if (options.getUserMediaRejects) throw new Error('RAW_MEDIA_SENTINEL');
      return stream;
    },
    createAudioContext: () => audioContext,
    requestAnimationFrame(callback) {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelAnimationFrameCalls += 1;
      frames.delete(id);
    },
  };

  return {
    value,
    recognition,
    track,
    audioContext,
    get getUserMediaCalls() { return getUserMediaCalls; },
    get cancelAnimationFrameCalls() { return cancelAnimationFrameCalls; },
    emitStart() { recognition.onstart?.(); },
    emitResults(parts: Array<{ text: string; final: boolean }>) {
      recognition.onresult?.({
        resultIndex: 0,
        results: parts.map((part) => ({
          0: { transcript: part.text },
          length: 1,
          isFinal: part.final,
        })),
      });
    },
    emitError(error: string) { recognition.onerror?.({ error }); },
    emitEnd() { recognition.onend?.(); },
    runFrame() {
      const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) return;
      frames.delete(entry[0]);
      entry[1](0);
    },
  };
}

await runCase('reports unsupported without touching media devices', () => {
  const platform = createFakePlatform({ recognition: false });
  const adapter = createBrowserVoiceDictationAdapter(platform.value);
  assertEqual(adapter.supported, false);
  assertEqual(platform.getUserMediaCalls, 0);
});

await runCase('starts one Russian recognition and emits final and interim text', async () => {
  const platform = createFakePlatform();
  const events: VoiceRecognitionEvent[] = [];
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onTranscript: (event) => events.push(event),
  }));
  assertEqual(platform.recognition.lang, 'ru-RU');
  assertEqual(platform.recognition.continuous, true);
  assertEqual(platform.recognition.interimResults, true);
  assertEqual(platform.recognition.startCalls, 1);
  platform.emitResults([
    { text: 'Привет', final: true },
    { text: ' как дела', final: false },
  ]);
  assertDeepEqual(events[events.length - 1], { finalText: 'Привет', interimText: ' как дела' });
  session.dispose();
});

await runCase('waveform failure does not stop recognition', async () => {
  const platform = createFakePlatform({ getUserMediaRejects: true });
  const errors: VoiceDictationErrorCode[] = [];
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onError: (code) => errors.push(code),
  }));
  await Promise.resolve();
  assertEqual(platform.recognition.startCalls, 1);
  assertDeepEqual(errors, []);
  session.dispose();
});

await runCase('emits normalized waveform levels', async () => {
  const platform = createFakePlatform();
  const levels: number[] = [];
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onLevel: (level) => levels.push(level),
  }));
  await Promise.resolve();
  platform.runFrame();
  assertEqual(levels.length, 1);
  assert(levels[0] > 0 && levels[0] <= 1, 'level is normalized');
  session.dispose();
});

await runCase('maps browser errors to safe allowlisted codes', async () => {
  const platform = createFakePlatform();
  const errors: VoiceDictationErrorCode[] = [];
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onError: (code) => errors.push(code),
  }));
  platform.emitError('not-allowed');
  platform.emitError('RAW_ERROR_SENTINEL');
  assertDeepEqual(errors, ['permission-denied', 'recognition-failed']);
  assert(!JSON.stringify(errors).includes('RAW_ERROR_SENTINEL'), 'raw error is absent');
  session.dispose();
});

await runCase('dispose releases resources and ignores late browser events', async () => {
  const platform = createFakePlatform();
  let transcriptCalls = 0;
  let endCalls = 0;
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onTranscript: () => { transcriptCalls += 1; },
    onEnd: () => { endCalls += 1; },
  }));
  await Promise.resolve();
  platform.runFrame();
  session.dispose();
  session.dispose();
  platform.emitResults([{ text: 'поздно', final: true }]);
  platform.emitEnd();
  assertEqual(transcriptCalls, 0);
  assertEqual(endCalls, 0);
  assertEqual(platform.track.stopCalls, 1);
  assertEqual(platform.audioContext.closeCalls, 1);
  assertEqual(platform.cancelAnimationFrameCalls, 1);
  assertEqual(platform.recognition.abortCalls, 1);
});

await runCase('manual stop is idempotent and natural end is reported once', async () => {
  const platform = createFakePlatform();
  let endCalls = 0;
  const session = await createBrowserVoiceDictationAdapter(platform.value).start(callbacks({
    onEnd: () => { endCalls += 1; },
  }));
  session.stop();
  session.stop();
  assertEqual(platform.recognition.stopCalls, 1);
  platform.emitEnd();
  platform.emitEnd();
  assertEqual(endCalls, 1);
  session.dispose();
});

console.log('browserVoiceDictation.cases.test.ts — all passed');
