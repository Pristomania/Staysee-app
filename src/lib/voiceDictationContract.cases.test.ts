/**
 * Pure voice-dictation contract cases.
 * Run: npx tsx src/lib/voiceDictationContract.cases.test.ts
 */

import {
  appendDictationToDraft,
  formatDictationDuration,
  formatVoicePackageSize,
  normalizeVoiceLevel,
  voiceDictationErrorCopy,
  voiceLevelFromSamples,
  voicePrepareDisplay,
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
  !voiceDictationErrorCopy('recognition-failed').includes('Microsoft Edge'),
  'an on-device engine failure never advises another browser',
);
assert(
  voiceDictationErrorCopy('recognition-failed').includes('на этом устройстве'),
  'an on-device failure names the device, not a remote service',
);
assert(
  !voiceDictationErrorCopy('connection-blocked').includes('Microsoft Edge'),
  'a blocked package download never advises another browser',
);
assert(
  !voiceDictationErrorCopy('connection-blocked').includes('сервису распознавания'),
  'there is no recognition service to be blocked from any more',
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

// 83_239_825 is VOICE_MODEL_TOTAL_BYTES. It is written out rather than
// imported because the contract module must not depend on the cache module.
assert(formatVoicePackageSize(83_239_825) === '83 МБ', 'the package reads as the promised 83 MB');
assert(formatVoicePackageSize(0) === '0 МБ', 'zero is zero, not an empty string');
assert(formatVoicePackageSize(-5) === '0 МБ', 'a nonsense size never renders as negative');

const indeterminate = voicePrepareDisplay(null);
assert(indeterminate.percent === null, 'no bytes to report means no bar to claim');
assert(indeterminate.detail === '', 'no bytes to report means no byte counter');
assert(
  indeterminate.label === 'Готовлю голосовой движок',
  'the indeterminate stage says what is happening instead of claiming a download',
);

const started = voicePrepareDisplay({ loadedBytes: 0, totalBytes: 83_239_825 });
assert(started.label === 'Скачиваю голосовой пакет', 'the download stage names the download');
assert(started.detail === '0 из 83 МБ', 'the counter is visible from the very first frame');
assert(started.percent === 0, 'a download that has not started is at zero, not at null');

assert(
  voicePrepareDisplay({ loadedBytes: 50, totalBytes: 200 }).percent === 25,
  'a quarter is twenty-five percent',
);
assert(
  voicePrepareDisplay({ loadedBytes: 199, totalBytes: 200 }).percent === 99,
  'almost finished never rounds up to a finished-looking hundred',
);
assert(
  voicePrepareDisplay({ loadedBytes: 90_000_000, totalBytes: 83_239_825 }).percent === 100,
  'a body longer than expected is clamped, never above a hundred',
);
assert(
  voicePrepareDisplay({ loadedBytes: 90_000_000, totalBytes: 83_239_825 }).detail === '83 из 83 МБ',
  'the counter is clamped to the total too',
);
assert(
  voicePrepareDisplay({ loadedBytes: 10, totalBytes: 0 }).percent === null,
  'a zero total is indeterminate, never a division by zero',
);
assert(
  voicePrepareDisplay({ loadedBytes: Number.NaN, totalBytes: 200 }).percent === 0,
  'a NaN byte count reads as nothing downloaded, not as NaN percent',
);
assert(
  voicePrepareDisplay({ loadedBytes: 41_000_000, totalBytes: 83_239_825 }).detail === '41 из 83 МБ',
  'real download numbers read in whole megabytes',
);

console.log('voiceDictationContract.cases.test.ts — all passed');
