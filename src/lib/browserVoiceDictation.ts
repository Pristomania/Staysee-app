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

// Chrome occasionally aborts a freshly started recognition within
// milliseconds for reasons outside page code's visibility or control (seen
// directly: a bare `new webkitSpeechRecognition(); r.start();` typed into
// DevTools, with none of this file's code involved at all, still ended in
// `onerror('aborted')`). Good dictation UIs treat this the way they treat
// Chrome's well-documented habit of ending `continuous: true` recognition
// after a pause: silently start a fresh attempt instead of surfacing a
// failure the user did nothing to cause. RETRYABLE_ERRORS deliberately
// excludes codes that mean something real happened (`not-allowed` needs the
// user to grant permission, `no-speech` means they should just try again
// knowing nothing was heard) -- only truly inexplicable aborts get retried.
const RETRYABLE_ERRORS = new Set(['aborted', 'network']);
const MAX_AUTO_RESTARTS = 3;
const RESTART_DELAY_MS = 250;

export function createBrowserVoiceDictationAdapter(
  platform: BrowserVoicePlatform = browserPlatform(),
): VoiceDictationAdapter {
  return {
    supported: platform.createRecognition !== null,
    async start(callbacks) {
      if (!platform.createRecognition) throw new Error('voice_dictation_unsupported');

      let recognition: SpeechRecognitionLike | null = null;
      let active = true;
      let stopRequested = false;
      let restartsLeft = MAX_AUTO_RESTARTS;
      let stream: MediaStreamLike | null = null;
      let audioContext: AudioContextLike | null = null;
      let frameId: number | null = null;
      let startTimeoutId: number | null = null;
      let stopTimeoutId: number | null = null;
      let restartTimeoutId: number | null = null;

      const detachRecognition = () => {
        if (!recognition) return;
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
      };

      const releaseWaveform = () => {
        if (frameId !== null) platform.cancelAnimationFrame(frameId);
        frameId = null;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
        if (audioContext) void audioContext.close().catch(() => undefined);
        audioContext = null;
      };

      const cleanup = (abortRecognition: boolean) => {
        if (!active) return;
        active = false;
        const current = recognition;
        detachRecognition();
        if (abortRecognition) current?.abort();
        if (startTimeoutId !== null) platform.clearTimeout(startTimeoutId);
        startTimeoutId = null;
        if (stopTimeoutId !== null) platform.clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
        if (restartTimeoutId !== null) platform.clearTimeout(restartTimeoutId);
        restartTimeoutId = null;
        releaseWaveform();
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

      // Declared with `function` (not const) so attemptStart can reference
      // itself for a retry before its own initializer has finished running.
      function attemptStart(): void {
        const next = platform.createRecognition!();
        recognition = next;
        next.lang = 'ru-RU';
        next.continuous = true;
        next.interimResults = true;
        next.onstart = () => {
          if (!active || recognition !== next) return;
          restartsLeft = MAX_AUTO_RESTARTS;
          if (startTimeoutId !== null) platform.clearTimeout(startTimeoutId);
          startTimeoutId = null;
          callbacks.onStart();
          // Only request the waveform's own microphone stream once
          // recognition has actually started. Requesting it in parallel
          // raced the browser's own internal microphone capture for
          // recognition -- in Chrome specifically, the two tried to use
          // the device at once and recognition's own capture lost,
          // surfacing as "cannot record now as Chrome is recording" and
          // no transcript.
          void startWaveform();
        };
        next.onresult = (event) => {
          if (active && recognition === next) callbacks.onTranscript(readRecognitionEvent(event));
        };
        next.onerror = (event) => {
          if (!active || recognition !== next) return;
          // Once onerror has fired, this attempt's own "never started"
          // watchdog is moot either way -- clear it before branching, or
          // it can fire later on its original 5s schedule and report a
          // failure behind whatever happens next (a retry, or onend).
          if (startTimeoutId !== null) platform.clearTimeout(startTimeoutId);
          startTimeoutId = null;
          if (RETRYABLE_ERRORS.has(event.error)) {
            if (restartsLeft > 0) {
              restartsLeft -= 1;
              releaseWaveform();
              restartTimeoutId = platform.setTimeout(() => {
                restartTimeoutId = null;
                if (active) attemptStart();
              }, RESTART_DELAY_MS);
              return;
            }
            // Several fresh attempts in a row all failed to even connect --
            // this isn't recognition rejecting the audio, it's recognition
            // never reaching Chrome's cloud speech service at all. A code
            // fix can't do anything further here; the most useful thing
            // left is telling the person what in their own environment
            // (an extension, a VPN) is the likely blocker.
            callbacks.onError('connection-blocked');
            return;
          }
          // Matches the original behavior: report the error but don't tear
          // the session down here -- the browser always fires onend right
          // after onerror, and that's what actually ends the session.
          callbacks.onError(mapRecognitionError(event.error));
        };
        next.onend = () => {
          if (!active || recognition !== next) return;
          // A retry is already queued from onerror above -- let it run
          // rather than reporting the session over.
          if (restartTimeoutId !== null) return;
          cleanup(false);
          callbacks.onEnd();
        };

        if (startTimeoutId !== null) platform.clearTimeout(startTimeoutId);
        startTimeoutId = platform.setTimeout(() => {
          if (!active || recognition !== next) return;
          // Unlike a quick onerror('aborted'), recognition sitting silent
          // for a full 5 seconds without even onstart firing isn't the
          // kind of momentary blip auto-restart is for -- report it
          // straightaway rather than making the user wait through retries
          // for something a restart is unlikely to fix.
          cleanup(true);
          callbacks.onError('recognition-failed');
        }, 5_000);
        try {
          next.start();
        } catch {
          // A retry runs from inside a bare setTimeout callback with no
          // promise or caller to catch a throw -- it would simply vanish as
          // an unhandled exception, leaving the session marked inactive
          // internally (so a later Stop becomes a silent no-op) while the
          // controller is never told anything ended. Reporting through the
          // callback instead works uniformly for the first attempt too: by
          // the time this runs synchronously inside start(), the caller
          // already holds the callbacks object regardless of whether its
          // own promise has resolved yet.
          cleanup(false);
          callbacks.onError('recognition-failed');
        }
      }

      attemptStart();

      return {
        stop() {
          if (!active || stopRequested) return;
          stopRequested = true;
          if (restartTimeoutId !== null) {
            // A restart was queued but the user stopped first -- end the
            // session instead of starting a new attempt they didn't ask for.
            platform.clearTimeout(restartTimeoutId);
            restartTimeoutId = null;
            cleanup(true);
            callbacks.onEnd();
            return;
          }
          recognition?.stop();
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
