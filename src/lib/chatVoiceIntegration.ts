import type { VoiceDictationPhase } from './voiceDictationContract';

export function canStartVoiceDictation(input: {
  sending: boolean;
  phase: VoiceDictationPhase;
}): boolean {
  return !input.sending && (input.phase === 'idle' || input.phase === 'error');
}

export function shouldStopVoiceDictation(phase: VoiceDictationPhase): boolean {
  return phase === 'starting' || phase === 'listening' || phase === 'stopping';
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
