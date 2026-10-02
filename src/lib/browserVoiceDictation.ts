import {
  normalizeVoiceLevel,
  type VoiceDictationAdapter,
  type VoiceDictationErrorCode,
  type VoiceRecognitionEvent,
} from './voiceDictationContract';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface MediaStreamTrackLike {
  stop(): void;
}

interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}

interface AnalyserNodeLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  getByteTimeDomainData(array: Uint8Array): void;
}

interface MediaStreamSourceLike {
  connect(destination: AnalyserNodeLike): void;
}

interface AudioContextLike {
  createAnalyser(): AnalyserNodeLike;
  createMediaStreamSource(stream: MediaStreamLike): MediaStreamSourceLike;
  close(): Promise<void>;
}

export interface BrowserVoicePlatform {
  createRecognition: (() => SpeechRecognitionLike) | null;
  getUserMedia: (() => Promise<MediaStreamLike>) | null;
  createAudioContext: (() => AudioContextLike) | null;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

interface RecognitionConstructor {
  new (): SpeechRecognitionLike;
}
type AudioContextConstructor = new () => AudioContextLike;

function browserPlatform(): BrowserVoicePlatform {
  if (typeof window === 'undefined') {
    return {
      createRecognition: null,
      getUserMedia: null,
      createAudioContext: null,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    };
  }

  const speechWindow = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  const AudioContextValue = window.AudioContext as unknown as AudioContextConstructor | undefined
    ?? speechWindow.webkitAudioContext;

  return {
    createRecognition: Recognition ? () => new Recognition() : null,
    getUserMedia: navigator.mediaDevices?.getUserMedia
      ? async () => navigator.mediaDevices.getUserMedia({ audio: true })
      : null,
    createAudioContext: AudioContextValue ? () => new AudioContextValue() : null,
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

function mapRecognitionError(error: string): VoiceDictationErrorCode {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'permission-denied';
  if (error === 'no-speech') return 'no-speech';
  return 'recognition-failed';
}

function readRecognitionEvent(event: SpeechRecognitionResultEventLike): VoiceRecognitionEvent {
  let finalText = '';
  let interimText = '';
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript ?? '';
    if (result?.isFinal) finalText += transcript;
    else interimText += transcript;
  }
  return { finalText, interimText };
}

export function createBrowserVoiceDictationAdapter(
  platform: BrowserVoicePlatform = browserPlatform(),
): VoiceDictationAdapter {
  return {
    supported: platform.createRecognition !== null,
    async start(callbacks) {
      if (!platform.createRecognition) throw new Error('voice_dictation_unsupported');

      const recognition = platform.createRecognition();
      let active = true;
      let stopRequested = false;
      let stream: MediaStreamLike | null = null;
      let audioContext: AudioContextLike | null = null;
      let frameId: number | null = null;
      let startTimeoutId: number | null = null;
      let stopTimeoutId: number | null = null;

      const cleanup = (abortRecognition: boolean) => {
        if (!active) return;
        active = false;
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        if (abortRecognition) recognition.abort();
        if (frameId !== null) platform.cancelAnimationFrame(frameId);
        frameId = null;
        if (startTimeoutId !== null) platform.clearTimeout(startTimeoutId);
        startTimeoutId = null;
        if (stopTimeoutId !== null) platform.clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
        if (audioContext) void audioContext.close().catch(() => undefined);
        audioContext = null;
      };

      const startWaveform = async () => {
        if (!platform.getUserMedia || !platform.createAudioContext) return;
        try {
          const nextStream = await platform.getUserMedia();
          if (!active) {
            for (const track of nextStream.getTracks()) track.stop();
            return;
          }
          const nextAudioContext = platform.createAudioContext();
          const analyser = nextAudioContext.createAnalyser();
          analyser.fftSize = 256;
          nextAudioContext.createMediaStreamSource(nextStream).connect(analyser);
          const samples = new Uint8Array(analyser.frequencyBinCount);
          stream = nextStream;
          audioContext = nextAudioContext;

          const measure = () => {
            if (!active) return;
            analyser.getByteTimeDomainData(samples);
            let sumSquares = 0;
            for (const sample of samples) {
              const normalized = (sample - 128) / 128;
              sumSquares += normalized * normalized;
            }
            callbacks.onLevel(normalizeVoiceLevel(Math.sqrt(sumSquares / samples.length)));
            frameId = platform.requestAnimationFrame(measure);
          };
          frameId = platform.requestAnimationFrame(measure);
        } catch {
          // A decorative waveform must never block or interrupt recognition.
        }
      };

      recognition.lang = 'ru-RU';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        if (!active) return;
        if (startTimeoutId !== null) platform.clearTimeout(startTimeoutId);
        startTimeoutId = null;
        callbacks.onStart();
      };
      recognition.onresult = (event) => {
        if (active) callbacks.onTranscript(readRecognitionEvent(event));
      };
      recognition.onerror = (event) => {
        if (active) callbacks.onError(mapRecognitionError(event.error));
      };
      recognition.onend = () => {
        if (!active) return;
        cleanup(false);
        callbacks.onEnd();
      };

      startTimeoutId = platform.setTimeout(() => {
        if (!active) return;
        cleanup(true);
        callbacks.onError('recognition-failed');
      }, 5_000);
      try {
        recognition.start();
      } catch {
        cleanup(false);
        throw new Error('voice_dictation_start_failed');
      }
      void startWaveform();

      return {
        stop() {
          if (!active || stopRequested) return;
          stopRequested = true;
          recognition.stop();
          stopTimeoutId = platform.setTimeout(() => {
            if (!active) return;
            cleanup(true);
            callbacks.onEnd();
          }, 1_000);
        },
        dispose() {
          cleanup(true);
        },
      };
    },
  };
}
