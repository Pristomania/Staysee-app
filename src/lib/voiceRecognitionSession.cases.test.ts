import {
  createVoiceRecognitionSession,
  FALLBACK_SAMPLE_RATE,
  type VoiceRecognizerLike,
  type VoiceRecognizerStreamLike,
} from './voiceRecognitionSession';

function assertEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    const msg = message ? `${message}: ` : '';
    throw new Error(`${msg}${String(actual)} !== ${String(expected)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const msg = message ? `${message}: ` : '';
    throw new Error(`${msg}${JSON.stringify(actual)}`);
  }
}

async function runCase(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  console.log(`PASS: ${name}`);
}

function createFakeRecognizer(options: { readyPerFeed?: number } = {}) {
  const readyPerFeed = options.readyPerFeed ?? 1;
  const accepted: Array<{ sampleRate: number; length: number }> = [];
  let readyLeft = 0;
  let decodeCalls = 0;
  let inputFinishedCalls = 0;
  let freeCalls = 0;
  let resultText = '';

  const stream: VoiceRecognizerStreamLike = {
    acceptWaveform(sampleRate, samples) {
      accepted.push({ sampleRate, length: samples.length });
      readyLeft += readyPerFeed;
    },
    inputFinished() { inputFinishedCalls += 1; },
    free() { freeCalls += 1; },
  };

  const value: VoiceRecognizerLike = {
    createStream: () => stream,
    isReady: () => readyLeft > 0,
    decode() { readyLeft -= 1; decodeCalls += 1; },
    getResult: () => ({ text: resultText }),
  };

  return {
    value,
    accepted,
    get decodeCalls() { return decodeCalls; },
    get inputFinishedCalls() { return inputFinishedCalls; },
    get freeCalls() { return freeCalls; },
    setResult(text: string) { resultText = text; },
  };
}

await runCase('feed decodes until the recognizer is no longer ready and returns the text', () => {
  const recognizer = createFakeRecognizer({ readyPerFeed: 3 });
  recognizer.setResult('привет');
  const session = createVoiceRecognitionSession(recognizer.value);
  assertEqual(session.feed(48_000, new Float32Array(4096)), 'привет');
  assertEqual(recognizer.decodeCalls, 3, 'drained every ready frame');
  assertDeepEqual(recognizer.accepted, [{ sampleRate: 48_000, length: 4096 }]);
});

await runCase('finish pads the final block at the rate of the last fed audio', () => {
  // The prototype hardcoded 16000 here. On a 48 kHz AudioContext that
  // padded a third of a second instead of a second of silence, and the
  // tail of the last phrase was lost or garbled.
  const recognizer = createFakeRecognizer();
  const session = createVoiceRecognitionSession(recognizer.value);
  session.feed(48_000, new Float32Array(4096));
  session.finish();
  const last = recognizer.accepted[recognizer.accepted.length - 1];
  assertEqual(last.sampleRate, 48_000, 'the silence block uses the real capture rate');
  assertEqual(last.length, 48_000, 'one second of silence at that rate');
});

await runCase('finish with no audio at all falls back to the model rate', () => {
  const recognizer = createFakeRecognizer();
  const session = createVoiceRecognitionSession(recognizer.value);
  session.finish();
  assertDeepEqual(recognizer.accepted, [
    { sampleRate: FALLBACK_SAMPLE_RATE, length: FALLBACK_SAMPLE_RATE },
  ]);
});

await runCase('finish is idempotent and frees the stream exactly once', () => {
  const recognizer = createFakeRecognizer();
  recognizer.setResult('итог');
  const session = createVoiceRecognitionSession(recognizer.value);
  session.feed(16_000, new Float32Array(1600));
  assertEqual(session.finish(), 'итог');
  assertEqual(session.finish(), 'итог', 'a repeated finish returns the same text');
  assertEqual(recognizer.freeCalls, 1, 'the stream is freed once');
  assertEqual(recognizer.inputFinishedCalls, 1, 'input is closed once');
  assertEqual(session.done, true);
});

await runCase('feed after finish is ignored instead of touching a freed stream', () => {
  const recognizer = createFakeRecognizer();
  recognizer.setResult('итог');
  const session = createVoiceRecognitionSession(recognizer.value);
  session.finish();
  const acceptedAfterFinish = recognizer.accepted.length;
  assertEqual(session.feed(48_000, new Float32Array(4096)), 'итог');
  assertEqual(recognizer.accepted.length, acceptedAfterFinish, 'no waveform reached the freed stream');
});

console.log('voiceRecognitionSession.cases.test.ts — all passed');
