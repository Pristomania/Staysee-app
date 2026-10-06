import {
  createVoiceRecognitionSession,
  type VoiceRecognitionSession,
  type VoiceRecognizerLike,
} from './voiceRecognitionSession';
import { createVoiceRecognitionQueue } from './voiceRecognitionQueue';

export interface VoiceWorkerLoadRequest {
  id: number;
  type: 'load';
  dataBytes: ArrayBuffer;
  wasmBytes: ArrayBuffer;
  modelBaseUrl: string;
  /** Loaded in order: the ASR wrapper first, then the Emscripten runtime. */
  engineScriptUrls: string[];
}
export interface VoiceWorkerStartRequest { id: number; type: 'start' }
export interface VoiceWorkerFinishRequest { id: number; type: 'finish' }
export interface VoiceWorkerAudioRequest {
  type: 'audio';
  sampleRate: number;
  samples: Float32Array;
}
export type VoiceWorkerRequest =
  | VoiceWorkerLoadRequest
  | VoiceWorkerStartRequest
  | VoiceWorkerFinishRequest
  | VoiceWorkerAudioRequest;

export interface VoiceWorkerReply {
  id: number;
  ok: boolean;
  /** Engine diagnostics. For this module's own logs only; never shown. */
  error?: string;
  text?: string;
}
export interface VoiceWorkerPartial {
  type: 'partial';
  text: string;
}
export type VoiceWorkerMessage = VoiceWorkerReply | VoiceWorkerPartial;

/**
 * Exactly the configuration the working prototype used. Changing any value
 * here requires re-running recognition on the same audio before and after
 * and comparing the transcripts, per the design document.
 */
export const VOICE_RECOGNIZER_CONFIG = {
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: '/encoder.onnx',
      decoder: '/decoder.onnx',
      joiner: '/joiner.onnx',
    },
    tokens: '/tokens.txt',
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    modelType: 'zipformer2',
  },
  decodingMethod: 'modified_beam_search',
  maxActivePaths: 10,
  enableEndpoint: 0,
} as const;

type EmscriptenModule = Record<string, unknown>;

interface EngineScope {
  Module?: EmscriptenModule;
  createOnlineRecognizer?: (
    module: EmscriptenModule,
    config: unknown,
  ) => VoiceRecognizerLike & { handle?: unknown };
  postMessage(message: VoiceWorkerMessage): void;
  onmessage: ((event: { data: VoiceWorkerRequest }) => void) | null;
  fetch(url: string): Promise<{ ok: boolean; text(): Promise<string> }>;
}

const scope = self as unknown as EngineScope;

const queue = createVoiceRecognitionQueue();
let recognizer: (VoiceRecognizerLike & { handle?: unknown }) | null = null;
let session: VoiceRecognitionSession | null = null;
let diagnostics: string[] = [];
let draining = false;

/**
 * This is a module worker, so `importScripts` does not exist -- it has to be
 * a module worker because Vite's dev server always instantiates workers
 * created from `new URL(..., import.meta.url)` as modules, and the ES
 * imports above would be a syntax error in a classic one. Indirect eval is
 * the exact equivalent: unlike `new Function`, it evaluates in global
 * scope, so the engine's own top-level `var` and `function` declarations
 * land on `self` just as importScripts would put them there.
 */
async function loadEngineScript(url: string): Promise<void> {
  const response = await scope.fetch(url);
  if (!response.ok) throw new Error('engine_script_unavailable');
  const source = await response.text();
  const indirectEval = eval;
  indirectEval(`${source}\n//# sourceURL=${url}`);
}

async function load(request: VoiceWorkerLoadRequest): Promise<void> {
  const dataBytes = request.dataBytes;
  await new Promise<void>((resolve, reject) => {
    scope.Module = {
      // Both large files come in already downloaded and verified by
      // voiceModelCache.ts, so the engine performs no network access of its
      // own -- this is also what makes caching the .wasm effective, which
      // the prototype never did.
      wasmBinary: request.wasmBytes,
      getPreloadedPackage: () => dataBytes,
      locateFile: (path: string) => `${request.modelBaseUrl}${path}`,
      print: () => undefined,
      printErr: (line: unknown) => {
        diagnostics.push(String(line));
        diagnostics = diagnostics.slice(-8);
      },
      onAbort: (reason: unknown) => reject(new Error(String(reason))),
      onRuntimeInitialized: () => resolve(),
    };
    void (async () => {
      try {
        for (const url of request.engineScriptUrls) await loadEngineScript(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  const factory = scope.createOnlineRecognizer;
  if (!factory) throw new Error('engine_factory_missing');
  // The Emscripten glue reuses the `Module` object placed above, so this is
  // the initialised runtime. `createOnlineRecognizer` is used rather than
  // `new OnlineRecognizer(...)` because it is a top-level function
  // declaration and therefore reachable after an indirect eval, whereas the
  // class is a lexical binding and would not be.
  const next = factory(scope.Module as EmscriptenModule, VOICE_RECOGNIZER_CONFIG);
  if (!next.handle) throw new Error('model_not_opened');
  recognizer = next;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      if (!session) break;
      const chunk = queue.shift();
      if (!chunk) break;
      scope.postMessage({ type: 'partial', text: session.feed(chunk.sampleRate, chunk.samples) });
      // Yield a whole macrotask so that queued `audio` messages actually
      // reach onmessage and the bounded queue. Decoding synchronously
      // inside onmessage -- as the prototype did -- let the backlog pile up
      // in the worker's own message queue, which nothing can cap.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
  } finally {
    draining = false;
  }
}

/**
 * Feed whatever is left synchronously. Nothing needs to yield now: the
 * session is ending, and a drain that is mid-yield will find the queue empty
 * and then no-op against a finished session.
 */
function feedRemaining(): void {
  if (!session) return;
  for (;;) {
    const chunk = queue.shift();
    if (!chunk) break;
    session.feed(chunk.sampleRate, chunk.samples);
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'audio') {
    queue.push({ sampleRate: request.sampleRate, samples: request.samples });
    void drainQueue();
    return;
  }

  void (async () => {
    try {
      if (request.type === 'load') {
        await load(request);
      } else if (request.type === 'start') {
        if (!recognizer) throw new Error('engine_not_loaded');
        queue.clear();
        if (session && !session.done) session.finish();
        session = createVoiceRecognitionSession(recognizer);
      } else {
        if (!session) throw new Error('session_not_started');
        feedRemaining();
        scope.postMessage({ id: request.id, ok: true, text: session.finish() });
        return;
      }
      scope.postMessage({ id: request.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scope.postMessage({
        id: request.id,
        ok: false,
        // The adapter never forwards this string anywhere a person can see
        // it; it exists so a developer reading a console has something.
        error: diagnostics.length ? `${message} | ${diagnostics.join(' | ')}` : message,
      });
    }
  })();
};
