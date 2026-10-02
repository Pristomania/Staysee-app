import {
  canStartVoiceDictation,
  shouldApplyVoicePreview,
  shouldStopVoiceDictation,
} from './chatVoiceIntegration';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  canStartVoiceDictation({ sending: false, phase: 'idle' }),
  'idle chat can start or show unsupported copy',
);
assert(
  canStartVoiceDictation({ sending: false, phase: 'error' }),
  'a new attempt clears the previous safe error',
);
assert(
  !canStartVoiceDictation({ sending: true, phase: 'idle' }),
  'sending blocks dictation',
);
assert(
  !canStartVoiceDictation({ sending: false, phase: 'starting' }),
  'second start is unavailable',
);
assert(
  shouldStopVoiceDictation('listening'),
  'send path stops active dictation',
);
assert(
  shouldStopVoiceDictation('starting'),
  'navigation stops a starting dictation',
);
assert(
  !shouldStopVoiceDictation('idle'),
  'idle path is unchanged',
);
assert(
  shouldApplyVoicePreview({ phase: 'idle', finalText: 'последнее', interimText: '' }),
  'final transcript is applied even when end arrives in the same render batch',
);
assert(
  !shouldApplyVoicePreview({ phase: 'idle', finalText: '', interimText: '' }),
  'initial idle snapshot cannot erase an existing draft',
);

console.log('chatVoiceIntegration.cases.test.ts — all passed');
