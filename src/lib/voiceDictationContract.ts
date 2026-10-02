export type VoiceDictationPhase = 'idle' | 'starting' | 'listening' | 'stopping' | 'error';

export type VoiceDictationErrorCode =
  | 'permission-denied'
  | 'unsupported'
  | 'no-speech'
  | 'recognition-failed'
  | 'connection-blocked';

export interface VoiceRecognitionEvent {
  finalText: string;
  interimText: string;
}

export interface VoiceDictationSnapshot {
  supported: boolean;
  phase: VoiceDictationPhase;
  previewDraft: string;
  finalText: string;
  interimText: string;
  elapsedMs: number;
  level: number;
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
  if (code === 'connection-blocked') {
    return 'Браузер не может подключиться к сервису распознавания речи. Проверь блокировщики рекламы/приватности и VPN, или попробуй Microsoft Edge';
  }
  return 'Не удалось распознать голос в этом браузере. Попробуй Microsoft Edge';
}
