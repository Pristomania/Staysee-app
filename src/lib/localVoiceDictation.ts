import {
  voiceLevelFromSamples,
  type VoiceDictationAdapter,
  type VoiceDictationErrorCode,
  type VoiceDictationPrepareProgress,
} from './voiceDictationContract';
import {
  browserVoiceModelCacheDeps,
  isVoiceModelCached,
  loadVoiceModelPackage,
  VOICE_MODEL_BASE_URL,
  VOICE_MODEL_TOTAL_BYTES,
  type AbortControllerLike,
  type AbortSignalLike,
  type VoiceModelPackage,
} from './voiceModelCache';
// Type-only: erased by esbuild under isolatedModules, so none of the
// worker's code is pulled into the main bundle. Must stay `import type`.
import type {
  VoiceWorkerMessage,
  VoiceWorkerPartial,
  VoiceWorkerReply,
} from './voiceRecognitionWorker';

export interface MessagePortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/**
 * The whole microphone -> worklet -> destination graph behind one handle.
 * Collapsing it this way keeps every `new AudioWorkletNode`, `connect` and
 * `disconnect` call inside the browser factory below, where it is one
 * mechanical block, and leaves the ordering decisions this module makes
 * (measure before transfer, stop tracks before asking for the tail)
 * testable against a trivial fake.
 */
export interface VoiceCaptureGraph {
  readonly port: MessagePortLike;
  disconnect(): void;
}

export interface MediaStreamTrackLike { stop(): void }
export interface MediaStreamLike { getTracks(): MediaStreamTrackLike[] }

export interface LocalAudioContextLike {
  readonly sampleRate: number;
  addWorkletModule(url: string): Promise<void>;
  createCaptureGraph(stream: MediaStreamLike, processorName: string): VoiceCaptureGraph;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  terminate(): void;
}

export interface LocalVoiceModelAccess {
  isCached(): Promise<boolean>;
  load(options: {
    onProgress(progress: VoiceDictationPrepareProgress): void;
    signal: AbortSignalLike;
  }): Promise<VoiceModelPackage>;
}

export interface LocalVoicePlatform {
  createWorker: (() => VoiceWorkerLike) | null;
  createAudioContext: (() => LocalAudioContextLike) | null;
  getUserMedia: (() => Promise<MediaStreamLike>) | null;
  model: LocalVoiceModelAccess | null;
  createAbortController(): AbortControllerLike;
  captureProcessorUrl: string;
  engineScriptUrls: string[];
  modelBaseUrl: string;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const CAPTURE_PROCESSOR_NAME = 'voice-capture';

/** Product rule: one recording is hard-capped at ten minutes. */
export const MAX_RECORDING_MS = 600_000;

/**
 * Opening an 11 MB WASM module plus a 68 MB model is CPU-bound and can take
 * tens of seconds on a weak phone, so this watchdog is generous. It is
 * deliberately separate from the download, which has no deadline at all and
 * is governed only by whether bytes are still arriving.
 */
export const WORKER_INIT_TIMEOUT_MS = 60_000;

/** Acknowledging `start` is bookkeeping; 5 s matches the browser adapter. */
export const WORKER_CONTROL_TIMEOUT_MS = 5_000;

/**
 * `finish` drains the queue and then decodes one second of padding. The
 * queue caps the backlog at about two seconds of audio, so even a device
 * decoding at a quarter of real time finishes well inside this.
 */
export const WORKER_FINISH_TIMEOUT_MS = 30_000;

type StageName = 'preparing' | 'listening' | 'finishing';

interface PendingRequest {
  resolve(reply: VoiceWorkerReply): void;
  reject(error: Error): void;
  timeoutId: number;
}

interface StageError extends Error { voiceCode: VoiceDictationErrorCode }

function stageError(code: VoiceDictationErrorCode): StageError {
  const error = new Error(`local_voice_${code}`) as StageError;
  error.voiceCode = code;
  return error;
}

function codeFromError(error: unknown): VoiceDictationErrorCode {
  if (typeof error === 'object' && error !== null && 'voiceCode' in error) {
    return (error as StageError).voiceCode;
  }
  return 'prepare-failed';
}

function isPartial(message: VoiceWorkerMessage): message is VoiceWorkerPartial {
  return 'type' in message && message.type === 'partial';
}

function browserLocalVoicePlatform(): LocalVoicePlatform {
  const engineScriptUrls = [
    // Order matters: the wrapper defines createOnlineRecognizer, the glue
    // then initialises the runtime using the Module object already set up.
    '/voice-engine/sherpa-onnx-asr.js',
    '/voice-engine/sherpa-onnx-wasm-main-asr.js',
  ];

  if (typeof window === 'undefined') {
    return {
      createWorker: null,
      createAudioContext: null,
      getUserMedia: null,
      model: null,
      createAbortController: () => new AbortController() as unknown as AbortControllerLike,
      captureProcessorUrl: '',
      engineScriptUrls,
      modelBaseUrl: VOICE_MODEL_BASE_URL,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    };
  }

  const capable = typeof Worker !== 'undefined'
    && typeof AudioWorkletNode !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof window.AudioContext !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);

  const cacheDeps = browserVoiceModelCacheDeps();

  return {
    createWorker: capable
      ? () => {
        const real = new Worker(new URL('./voiceRecognitionWorker.ts', import.meta.url), {
          type: 'module',
        });
        const like: VoiceWorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage: (message, transfer) => real.postMessage(
            message,
            (transfer ?? []) as Transferable[],
          ),
          terminate: () => real.terminate(),
        };
        real.onmessage = (event) => like.onmessage?.({ data: event.data });
        real.onerror = (event) => like.onerror?.({ message: event.message });
        return like;
      }
      : null,
    createAudioContext: capable
      ? () => {
        const context = new AudioContext();
        const like: LocalAudioContextLike = {
          get sampleRate() { return context.sampleRate; },
          addWorkletModule: (url) => context.audioWorklet.addModule(url),
          createCaptureGraph(stream, processorName) {
            const node = new AudioWorkletNode(context, processorName);
            const source = context.createMediaStreamSource(stream as unknown as MediaStream);
            source.connect(node);
            // A worklet only runs while it is reachable from the
            // destination. This node never writes to its output buffer, so
            // the connection is silent and causes no echo.
            node.connect(context.destination);
            const port: MessagePortLike = {
              onmessage: null,
              close: () => node.port.close(),
            };
            node.port.onmessage = (event) => port.onmessage?.({ data: event.data });
            return {
              port,
              disconnect() {
                node.port.onmessage = null;
                source.disconnect();
                node.disconnect();
              },
            };
          },
          resume: () => context.resume(),
          close: () => context.close(),
        };
        return like;
      }
      : null,
    getUserMedia: capable
      ? async () => navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      }) as unknown as Promise<MediaStreamLike>
      : null,
    model: capable
      ? {
        isCached: () => isVoiceModelCached(cacheDeps),
        load: (options) => loadVoiceModelPackage(cacheDeps, options),
      }
      : null,
    createAbortController: () => new AbortController() as unknown as AbortControllerLike,
    // Vite's asset-import-meta-url plugin rewrites this to the emitted
    // asset URL in build and to the dev-server URL in dev; it is evaluated
    // only here, inside the real factory, so the Node test runner (which
    // always injects a fake platform) never touches it.
    captureProcessorUrl: new URL('./voiceCaptureProcessor.js', import.meta.url).href,
    engineScriptUrls,
    modelBaseUrl: VOICE_MODEL_BASE_URL,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

export function createLocalVoiceDictationAdapter(
  platform: LocalVoicePlatform = browserLocalVoicePlatform(),
): VoiceDictationAdapter {
  const { createWorker, createAudioContext, getUserMedia, model } = platform;

  return {
    supported: createWorker !== null
      && createAudioContext !== null
      && getUserMedia !== null
      && model !== null,

    async start(callbacks) {
      if (!createWorker || !createAudioContext || !getUserMedia || !model) {
        throw new Error('voice_dictation_unsupported');
      }

      let active = true;
      let stopRequested = false;
      let stage: StageName = 'preparing';
      let worker: VoiceWorkerLike | null = null;
      let audioContext: LocalAudioContextLike | null = null;
      let stream: MediaStreamLike | null = null;
      let graph: VoiceCaptureGraph | null = null;
      let limitTimeoutId: number | null = null;
      let latestText = '';
      let requestSeq = 0;
      const pending = new Map<number, PendingRequest>();
      const download = platform.createAbortController();

      const settleAll = (error: Error) => {
        const entries = [...pending.values()];
        pending.clear();
        for (const entry of entries) {
          platform.clearTimeout(entry.timeoutId);
          entry.reject(error);
        }
      };

      const releaseCapture = () => {
        if (graph) {
          graph.port.onmessage = null;
          graph.disconnect();
        }
        graph = null;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
      };

      const cleanup = () => {
        if (!active) return;
        active = false;
        // An 83 MB fetch for a session nobody is waiting for is pure waste
        // of the person's bandwidth and battery.
        download.abort();
        if (limitTimeoutId !== null) platform.clearTimeout(limitTimeoutId);
        limitTimeoutId = null;
        settleAll(new Error('session_disposed'));
        releaseCapture();
        if (audioContext) void audioContext.close().catch(() => undefined);
        audioContext = null;
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
        }
        worker = null;
      };

      // cleanup() flips `active` first, so both of these are self-guarding
      // and report exactly once. A failure reports only onError: the
      // controller's own failure path disposes the session and supersedes
      // it, so a trailing onEnd would be ignored anyway.
      const stopWithError = (code: VoiceDictationErrorCode) => {
        if (!active) return;
        cleanup();
        callbacks.onError(code);
      };
      const endSession = () => {
        if (!active) return;
        cleanup();
        callbacks.onEnd();
      };

      const request = (
        message: Record<string, unknown>,
        timeoutMs: number,
        transfer?: unknown[],
      ): Promise<VoiceWorkerReply> => new Promise((resolve, reject) => {
        const current = worker;
        if (!current) { reject(new Error('worker_missing')); return; }
        requestSeq += 1;
        const id = requestSeq;
        const timeoutId = platform.setTimeout(() => {
          pending.delete(id);
          reject(new Error('worker_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeoutId });
        current.postMessage({ ...message, id }, transfer);
      });

      const startCapture = async () => {
        let nextStream: MediaStreamLike;
        try {
          nextStream = await getUserMedia();
        } catch {
          throw stageError('permission-denied');
        }
        if (!active) {
          for (const track of nextStream.getTracks()) track.stop();
          return;
        }
        stream = nextStream;

        let nextContext: LocalAudioContextLike;
        try {
          nextContext = createAudioContext();
          await nextContext.resume();
          await nextContext.addWorkletModule(platform.captureProcessorUrl);
        } catch {
          // A browser without AudioWorklet is out of scope by design; the
          // text chat is unaffected.
          throw stageError('unsupported');
        }
        if (!active) {
          void nextContext.close().catch(() => undefined);
          return;
        }
        audioContext = nextContext;

        try {
          await request({ type: 'start' }, WORKER_CONTROL_TIMEOUT_MS);
        } catch {
          throw stageError('recognition-failed');
        }
        if (!active) return;

        stage = 'listening';
        const nextGraph = nextContext.createCaptureGraph(nextStream, CAPTURE_PROCESSOR_NAME);
        graph = nextGraph;
        nextGraph.port.onmessage = (event) => {
          if (!active || graph !== nextGraph || stage !== 'listening') return;
          const samples = event.data as Float32Array;
          // Measure before posting: postMessage transfers the buffer and
          // leaves this view detached, so the level must be read first.
          callbacks.onLevel(voiceLevelFromSamples(samples));
          worker?.postMessage(
            { type: 'audio', sampleRate: nextContext.sampleRate, samples },
            [samples.buffer],
          );
        };

        limitTimeoutId = platform.setTimeout(() => {
          limitTimeoutId = null;
          void stopSession();
        }, MAX_RECORDING_MS);

        callbacks.onStart();
      };

      const prepare = async () => {
        try {
          let pkg: VoiceModelPackage;
          try {
            const cached = await model.isCached();
            if (!active) return;
            if (!cached) {
              // Opening at zero lets a progress bar appear immediately
              // rather than after the first body chunk.
              callbacks.onPrepareProgress?.({ loadedBytes: 0, totalBytes: VOICE_MODEL_TOTAL_BYTES });
            }
            pkg = await model.load({
              onProgress: (progress) => { if (active) callbacks.onPrepareProgress?.(progress); },
              signal: download.signal,
            });
          } catch {
            if (!active) return;
            throw stageError('prepare-failed');
          }
          if (!active) return;

          // Bytes are done; the engine still has to open the model, and that
          // has no progress of its own.
          callbacks.onPrepareProgress?.(null);
          try {
            await request(
              {
                type: 'load',
                dataBytes: pkg.dataBytes,
                wasmBytes: pkg.wasmBytes,
                modelBaseUrl: platform.modelBaseUrl,
                engineScriptUrls: platform.engineScriptUrls,
              },
              WORKER_INIT_TIMEOUT_MS,
              [pkg.dataBytes, pkg.wasmBytes],
            );
          } catch {
            if (!active) return;
            throw stageError('prepare-failed');
          }
          if (!active) return;

          await startCapture();
        } catch (error) {
          if (!active) return;
          stopWithError(codeFromError(error));
        }
      };

      async function stopSession(): Promise<void> {
        if (!active || stopRequested) return;
        stopRequested = true;

        if (stage === 'preparing') {
          // Nothing was recorded; abandon the download instead of letting it
          // run to completion for a session the person already cancelled.
          endSession();
          return;
        }

        stage = 'finishing';
        if (limitTimeoutId !== null) platform.clearTimeout(limitTimeoutId);
        limitTimeoutId = null;
        // Release the microphone before waiting on the tail: the recording
        // indicator should go out the moment Stop is pressed.
        releaseCapture();

        let text = latestText;
        try {
          const reply = await request({ type: 'finish' }, WORKER_FINISH_TIMEOUT_MS);
          if (typeof reply.text === 'string') text = reply.text;
        } catch {
          if (!active) return;
          // The engine never confirmed the tail. Keep the partial text the
          // person already watched appear rather than discarding it.
          text = latestText;
        }
        if (!active) return;

        if (!text) {
          stopWithError('no-speech');
          return;
        }
        callbacks.onTranscript({ finalText: text, interimText: '' });
        endSession();
      }

      const next = createWorker();
      worker = next;
      next.onmessage = (event) => {
        if (!active || worker !== next) return;
        const data = event.data as VoiceWorkerMessage;
        if (isPartial(data)) {
          latestText = data.text;
          // The worker's partial text is always the whole transcript so far,
          // so it goes out as interim and nothing is ever duplicated.
          callbacks.onTranscript({ finalText: '', interimText: data.text });
          return;
        }
        const entry = pending.get(data.id);
        if (!entry) return;
        platform.clearTimeout(entry.timeoutId);
        pending.delete(data.id);
        if (data.ok) entry.resolve(data);
        // data.error carries engine diagnostics and stays inside this
        // module; the caller only ever sees an allowlisted code.
        else entry.reject(new Error('worker_failed'));
      };
      next.onerror = () => {
        if (!active || worker !== next) return;
        settleAll(new Error('worker_crashed'));
        stopWithError(stage === 'preparing' ? 'prepare-failed' : 'recognition-failed');
      };

      callbacks.onPrepareProgress?.(null);
      void prepare();

      return {
        stop() { void stopSession(); },
        dispose() { cleanup(); },
      };
    },
  };
}
