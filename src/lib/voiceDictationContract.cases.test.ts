/**
 * Pure voice-dictation contract cases.
 * Run: npx tsx src/lib/voiceDictationContract.cases.test.ts
 */

import {
  appendDictationToDraft,
  formatDictationDuration,
  normalizeVoiceLevel,
  voiceDictationErrorCopy,
  voiceLevelFromSamples,
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
assert(
  voiceDictationErrorCopy('prepare-failed').includes('место'),
  'prepare failure names the disk-space cause',
);
assert(
  voiceDictationErrorCopy('prepare-failed').includes('интернет'),
  'prepare failure names the network cause',
);
assert(
  !voiceDictationErrorCopy('prepare-failed').includes('Microsoft Edge'),
  'on-device preparation never advises another browser',
);
assert(
  !voiceDictationErrorCopy('prepare-failed').includes('QuotaExceededError'),
  'raw storage errors never leak',
);
assert(voiceLevelFromSamples([]) === 0, 'an empty block is silent');
assert(voiceLevelFromSamples([0, 0, 0, 0]) === 0, 'digital silence is silent');
assert(voiceLevelFromSamples([1, -1, 1, -1]) === 1, 'full scale is one');
assert(voiceLevelFromSamples([Number.NaN, 0, 0, 0]) === 0, 'a NaN sample is treated as silence');
assert(voiceLevelFromSamples([4, -4]) === 1, 'an out-of-range block is clamped, never above one');

console.log('voiceDictationContract.cases.test.ts — all passed');
