import type { VoiceDictationPhase } from './voiceDictationContract';

export function canStartVoiceDictation(input: {
  sending: boolean;
  phase: VoiceDictationPhase;
}): boolean {
  return !input.sending && (input.phase === 'idle' || input.phase === 'error');
}

export function shouldStopVoiceDictation(phase: VoiceDictationPhase): boolean {
  return (
    phase === 'starting'
    || phase === 'preparing'
    || phase === 'listening'
    || phase === 'stopping'
  );
}

/**
 * Which of the three things the composer row is right now.
 *
 * Deliberately not derived from `shouldStopVoiceDictation`: that predicate
 * answers "is there a session to stop", which is true during the package
 * download too. The composer needs a different answer there, because the
 * recording bar would claim to be listening while nothing is recorded.
 */
export type VoiceComposerMode = 'compose' | 'preparing' | 'recording';

export function voiceComposerMode(phase: VoiceDictationPhase): VoiceComposerMode {
  if (phase === 'preparing') return 'preparing';
  if (phase === 'starting' || phase === 'listening' || phase === 'stopping') {
    return 'recording';
  }
  return 'compose';
}

export function shouldApplyVoicePreview(input: {
  phase: VoiceDictationPhase;
  finalText: string;
  interimText: string;
}): boolean {
  return input.phase !== 'idle' || input.finalText.length > 0 || input.interimText.length > 0;
}

export function shouldApplyVoiceSnapshot(input: {
  previous: {
    phase: VoiceDictationPhase;
    finalText: string;
    interimText: string;
  } | null;
  current: {
    phase: VoiceDictationPhase;
    finalText: string;
    interimText: string;
  };
}): boolean {
  return input.previous !== input.current && shouldApplyVoicePreview(input.current);
}
