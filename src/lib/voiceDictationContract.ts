export type VoiceDictationPhase =
  | 'idle'
  | 'starting'
  | 'preparing'
  | 'listening'
  | 'stopping'
  | 'error';

export type VoiceDictationErrorCode =
  | 'permission-denied'
  | 'unsupported'
  | 'no-speech'
  | 'recognition-failed'
  | 'connection-blocked'
  | 'prepare-failed';

export interface VoiceRecognitionEvent {
  finalText: string;
  interimText: string;
}

/** Byte progress of the one-time on-device voice package download. */
export interface VoiceDictationPrepareProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface VoiceDictationSnapshot {
  supported: boolean;
  phase: VoiceDictationPhase;
  previewDraft: string;
  finalText: string;
  interimText: string;
  elapsedMs: number;
  level: number;
  /**
   * Filled only while `phase === 'preparing'`. `null` during preparation
   * means "working, but with no byte progress to show" -- the engine is
   * opening an already-downloaded model, which has no progress of its own.
   */
  prepareProgress: VoiceDictationPrepareProgress | null;
  errorCode: VoiceDictationErrorCode | null;
}

export interface VoiceDictationSession {
  stop(): void;
  dispose(): void;
}

export interface VoiceDictationAdapter {
  readonly supported: boolean;
  start(callbacks: {
    onStart(): void;
    onPrepareProgress?(progress: VoiceDictationPrepareProgress | null): void;
    onTranscript(event: VoiceRecognitionEvent): void;
    onLevel(level: number): void;
    onError(code: VoiceDictationErrorCode): void;
    onEnd(): void;
  }): Promise<VoiceDictationSession>;
}

export function appendDictationToDraft(draft: string, speech: string): string {
  const left = draft.trimEnd();
  const right = speech.trim();
  if (!right) return left;
  return left ? `${left} ${right}` : right;
}

export function formatDictationDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function normalizeVoiceLevel(level: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
}

/**
 * RMS level of one captured PCM block. Lives beside `normalizeVoiceLevel`
 * because the on-device adapter measures amplitude from the very same
 * Float32 block it hands to the recognizer -- there is no second
 * `getUserMedia()` and no AnalyserNode.
 */
export function voiceLevelFromSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const normalized = Number.isFinite(sample) ? sample : 0;
    sumSquares += normalized * normalized;
  }
  return normalizeVoiceLevel(Math.sqrt(sumSquares / samples.length));
}

export function voiceDictationErrorCopy(code: VoiceDictationErrorCode): string {
  if (code === 'permission-denied') {
    return 'Разреши доступ к микрофону в настройках браузера';
  }
  if (code === 'unsupported') {
    return 'В этом браузере голосовой ввод пока недоступен';
  }
  if (code === 'no-speech') {
    return 'Не удалось расслышать. Попробуй ещё раз';
  }
  if (code === 'prepare-failed') {
    // One code, one string, as the design requires -- but the string names
    // the two causes a person can actually act on, the same way the
    // `connection-blocked` copy above names its likely causes.
    return 'Не удалось подготовить голосовой ввод. Проверь, есть ли свободное место на устройстве и стабильный интернет, и попробуй ещё раз';
  }
  if (code === 'connection-blocked') {
    // The on-device adapter never emits this code -- there is no recognition
    // service to be blocked from. It is kept because the copy function is
    // total over the error union, and the one way something like it could
    // still happen is a blocker or VPN cutting off the package download.
    return 'Не получилось скачать голосовой пакет. Проверь блокировщики рекламы и приватности, VPN — и попробуй ещё раз';
  }
  // Recognition now happens inside this browser, on this device. The old
  // advice to try Microsoft Edge pointed at a different cloud provider,
  // which no longer exists anywhere in this path.
  return 'Голосовой ввод сорвался на этом устройстве. Попробуй ещё раз или набери текст руками';
}
