/**
 * Faithful port of the proven prototype's `Session` class, with the
 * already-found sample-rate bug fixed. Deliberately knows nothing about
 * Workers, WASM or any browser API: the recognizer is injected, so every
 * line here is exercised by voiceRecognitionSession.cases.test.ts.
 */

export interface VoiceRecognizerStreamLike {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  inputFinished(): void;
  free(): void;
}

export interface VoiceRecognizerLike {
  createStream(): VoiceRecognizerStreamLike;
  isReady(stream: VoiceRecognizerStreamLike): boolean;
  decode(stream: VoiceRecognizerStreamLike): void;
  getResult(stream: VoiceRecognizerStreamLike): { text: string };
}

export interface VoiceRecognitionSession {
  readonly done: boolean;
  readonly text: string;
  feed(sampleRate: number, samples: Float32Array): string;
  finish(): string;
}

/** The model's own feature rate; used only when nothing was ever fed. */
export const FALLBACK_SAMPLE_RATE = 16_000;

export function createVoiceRecognitionSession(
  recognizer: VoiceRecognizerLike,
): VoiceRecognitionSession {
  const stream = recognizer.createStream();
  let text = '';
  let done = false;
  let lastSampleRate = 0;

  const drain = (): string => {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    text = recognizer.getResult(stream).text;
    return text;
  };

  return {
    get done() { return done; },
    get text() { return text; },
    feed(sampleRate, samples) {
      if (done) return text;
      lastSampleRate = sampleRate;
      stream.acceptWaveform(sampleRate, samples);
      return drain();
    },
    finish() {
      if (done) return text;
      // One second of silence flushes the streaming decoder's tail. It has
      // to be a second of silence *at the rate the audio was actually
      // captured* -- a hardcoded 16000 here against a 48 kHz capture fed a
      // third of a second and cut the end of the last phrase.
      const sampleRate = lastSampleRate || FALLBACK_SAMPLE_RATE;
      stream.acceptWaveform(sampleRate, new Float32Array(sampleRate));
      stream.inputFinished();
      drain();
      done = true;
      stream.free();
      return text;
    },
  };
}
