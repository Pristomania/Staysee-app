/**
 * Pure voice-dictation contract cases.
 * Run: npx tsx src/lib/voiceDictationContract.cases.test.ts
 */

import {
  appendDictationToDraft,
  formatDictationDuration,
  normalizeVoiceLevel,
  voiceDictationErrorCopy,
} from './voiceDictationContract';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(appendDictationToDraft('', 'Привет') === 'Привет', 'empty draft accepts speech');
assert(
  appendDictationToDraft('Мне трудно', 'говорить') === 'Мне трудно говорить',
  'one separator is added',
);
assert(
  appendDictationToDraft('Уже есть ', ' текст ') === 'Уже есть текст',
  'boundary whitespace is normalized',
);
assert(
  appendDictationToDraft('Черновик', '') === 'Черновик',
  'empty speech preserves draft',
);
assert(formatDictationDuration(0) === '0:00', 'zero duration');
assert(formatDictationDuration(65_000) === '1:05', 'minute duration');
assert(normalizeVoiceLevel(-1) === 0, 'level clamps low');
assert(normalizeVoiceLevel(0.4) === 0.4, 'level preserves range');
assert(normalizeVoiceLevel(2) === 1, 'level clamps high');
assert(
  voiceDictationErrorCopy('permission-denied').includes('Разреши доступ'),
  'safe permission copy',
);
assert(
  !voiceDictationErrorCopy('recognition-failed').includes('NotAllowedError'),
  'raw errors never leak',
);
assert(
  voiceDictationErrorCopy('recognition-failed').includes('Microsoft Edge'),
  'failed browser points to the verified fallback',
);
assert(
  voiceDictationErrorCopy('connection-blocked').includes('блокировщики'),
  'repeated connection failures point at the likely environmental cause',
);

console.log('voiceDictationContract.cases.test.ts — all passed');
