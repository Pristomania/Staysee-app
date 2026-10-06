import {
  appendDictationToDraft,
  normalizeVoiceLevel,
  type VoiceDictationAdapter,
  type VoiceDictationSnapshot,
  type VoiceDictationSession,
} from './voiceDictationContract';

interface VoiceDictationClock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
}

export interface VoiceDictationController {
  getSnapshot(): VoiceDictationSnapshot;
  subscribe(listener: () => void): () => void;
  start(baseDraft: string): Promise<void>;
  stop(): void;
  clearError(): void;
  dispose(): void;
}

const defaultClock: VoiceDictationClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (id) => clearInterval(id),
};

export function createVoiceDictationController(options: {
  adapter: VoiceDictationAdapter;
  clock?: VoiceDictationClock;
}): VoiceDictationController {
  const { adapter, clock = defaultClock } = options;
  const listeners = new Set<() => void>();
  let snapshot: VoiceDictationSnapshot = {
    supported: adapter.supported,
    phase: 'idle',
    previewDraft: '',
    finalText: '',
    interimText: '',
    elapsedMs: 0,
    level: 0,
    prepareProgress: null,
    errorCode: null,
  };
  let baseDraft = '';
  let session: VoiceDictationSession | null = null;
  let startPromise: Promise<void> | null = null;
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sessionToken = 0;
  let stopRequested = false;
  let disposed = false;

  const publish = (patch: Partial<VoiceDictationSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const clearTimer = () => {
    if (timer === null) return;
    clock.clearInterval(timer);
    timer = null;
  };

  const finish = (token: number) => {
    if (disposed || token !== sessionToken) return;
    sessionToken += 1;
    clearTimer();
    session = null;
    startPromise = null;
    stopRequested = false;
    publish({ phase: 'idle', level: 0, interimText: '', errorCode: null });
  };

  const fail = (token: number, errorCode: VoiceDictationSnapshot['errorCode']) => {
    if (disposed || token !== sessionToken || errorCode === null) return;
    sessionToken += 1;
    clearTimer();
    session?.dispose();
    session = null;
    startPromise = null;
    stopRequested = false;
    publish({ phase: 'error', level: 0, interimText: '', errorCode });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(nextBaseDraft) {
      if (disposed) return Promise.resolve();
      if (snapshot.phase === 'starting' || snapshot.phase === 'listening' || snapshot.phase === 'stopping') {
        return startPromise ?? Promise.resolve();
      }

      baseDraft = nextBaseDraft;
      if (!adapter.supported) {
        publish({
          phase: 'error',
          previewDraft: baseDraft,
          finalText: '',
          interimText: '',
          elapsedMs: 0,
          level: 0,
          errorCode: 'unsupported',
        });
        return Promise.resolve();
      }

      sessionToken += 1;
      const token = sessionToken;
      stopRequested = false;
      publish({
        phase: 'starting',
        previewDraft: baseDraft,
        finalText: '',
        interimText: '',
        elapsedMs: 0,
        level: 0,
        errorCode: null,
      });

      startPromise = adapter.start({
        onStart() {
          if (disposed || token !== sessionToken || snapshot.phase !== 'starting') return;
          startedAt = clock.now();
          publish({ phase: 'listening' });
          timer = clock.setInterval(() => {
            if (token === sessionToken) publish({ elapsedMs: clock.now() - startedAt });
          }, 250);
        },
        onTranscript(event) {
          if (disposed || token !== sessionToken) return;
          publish({
            finalText: event.finalText,
            interimText: event.interimText,
            previewDraft: appendDictationToDraft(baseDraft, `${event.finalText}${event.interimText}`),
          });
        },
        onLevel(level) {
          if (disposed || token !== sessionToken || snapshot.phase !== 'listening') return;
          publish({ level: normalizeVoiceLevel(level) });
        },
        onError(errorCode) {
          fail(token, errorCode);
        },
        onEnd() {
          finish(token);
        },
      }).then((nextSession) => {
        if (disposed || token !== sessionToken) {
          nextSession.dispose();
          return;
        }
        session = nextSession;
        if (stopRequested) session.stop();
      }).catch(() => {
        fail(token, 'recognition-failed');
      });

      return startPromise;
    },
    stop() {
      if (disposed || (snapshot.phase !== 'starting' && snapshot.phase !== 'listening')) return;
      stopRequested = true;
      publish({ phase: 'stopping', level: 0 });
      session?.stop();
    },
    clearError() {
      if (disposed || snapshot.phase !== 'error') return;
      publish({ phase: 'idle', errorCode: null });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sessionToken += 1;
      clearTimer();
      session?.dispose();
      session = null;
      startPromise = null;
      listeners.clear();
    },
  };
}
