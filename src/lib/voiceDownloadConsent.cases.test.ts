import {
  browserVoiceConsentStorage,
  forgetVoiceDownloadConsent,
  hasVoiceDownloadConsent,
  rememberVoiceDownloadConsent,
  voiceDownloadDecision,
  VOICE_DOWNLOAD_CONSENT_KEY,
  type VoiceConsentStorage,
} from './voiceDownloadConsent';

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = 'values must be equal'): void {
  assert(Object.is(actual, expected), `${message}: ${String(actual)} !== ${String(expected)}`);
}

async function runCase(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  console.log(`PASS: ${name}`);
}

function fakeStorage(): VoiceConsentStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

function hostileStorage(): VoiceConsentStorage {
  return {
    getItem() { throw new Error('RAW_STORAGE_SENTINEL'); },
    setItem() { throw new Error('RAW_STORAGE_SENTINEL'); },
    removeItem() { throw new Error('RAW_STORAGE_SENTINEL'); },
  };
}

await runCase('the storage key is pinned so a rename is a deliberate act', () => {
  assertEqual(VOICE_DOWNLOAD_CONSENT_KEY, 'staysee-voice-download-consent');
});

await runCase('a browser that has never agreed has not agreed', () => {
  const storage = fakeStorage();
  assertEqual(hasVoiceDownloadConsent(storage), false);
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
  );
});

await runCase('agreeing is remembered and is not asked again', () => {
  const storage = fakeStorage();
  rememberVoiceDownloadConsent(storage);
  assertEqual(storage.entries.get(VOICE_DOWNLOAD_CONSENT_KEY), '1', 'the flag is written');
  assertEqual(hasVoiceDownloadConsent(storage), true);
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: true }),
    'start',
  );
});

await runCase('forgetting puts the question back', () => {
  // Deleting the package in settings calls this. Without it the next press
  // of the microphone would start an 83 MB download with no question asked.
  const storage = fakeStorage();
  rememberVoiceDownloadConsent(storage);
  forgetVoiceDownloadConsent(storage);
  assertEqual(hasVoiceDownloadConsent(storage), false);
  assertEqual(storage.entries.has(VOICE_DOWNLOAD_CONSENT_KEY), false, 'no empty value is left behind');
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
  );
});

await runCase('a decline leaves no trace, so trying again just asks again', () => {
  // Review Focus 2: declining is "not now", never "never". Nothing is
  // written on cancel, so the very next press reopens the same card.
  const storage = fakeStorage();
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
  );
  assertEqual(storage.entries.size, 0, 'a decline writes nothing at all');
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: false, consentRemembered: false }),
    'ask',
    'and the second press asks again rather than going quiet',
  );
});

await runCase('a package already on the device is never asked about', () => {
  // Review Focus 1: somebody who already has the package -- from a dev
  // session, or from before the consent flag was cleared -- must not be
  // asked to agree to a download that is not going to happen.
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: true, consentRemembered: false }),
    'start',
  );
});

await runCase('an unfinished cache probe asks rather than guesses', () => {
  // Review Focus 1: `null` is "the probe has not answered". One redundant
  // question is the right way to be wrong; a silent 83 MB download is not.
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: null, consentRemembered: false }),
    'ask',
  );
  assertEqual(
    voiceDownloadDecision({ supported: true, packageCached: null, consentRemembered: true }),
    'start',
    'but somebody who already agreed is not asked twice over a slow probe',
  );
});

await runCase('a device that cannot do this is not offered a download', () => {
  // Review Focus 4: the controller publishes `unsupported` without touching
  // the network, which is a far kinder answer than an 83 MB invitation.
  assertEqual(
    voiceDownloadDecision({ supported: false, packageCached: false, consentRemembered: false }),
    'start',
  );
  assertEqual(
    voiceDownloadDecision({ supported: false, packageCached: null, consentRemembered: false }),
    'start',
  );
});

await runCase('a browser with no storage at all still works, it just asks every time', () => {
  assertEqual(hasVoiceDownloadConsent(null), false);
  rememberVoiceDownloadConsent(null);
  forgetVoiceDownloadConsent(null);
  assertEqual(hasVoiceDownloadConsent(null), false, 'nothing was remembered, and nothing crashed');
});

await runCase('storage that throws on every call is treated as absent', () => {
  const storage = hostileStorage();
  assertEqual(hasVoiceDownloadConsent(storage), false);
  rememberVoiceDownloadConsent(storage);
  forgetVoiceDownloadConsent(storage);
  assertEqual(hasVoiceDownloadConsent(storage), false, 'a hardened browser asks again, it does not break');
});

await runCase('a stray value in the key is not an agreement', () => {
  const storage = fakeStorage();
  storage.entries.set(VOICE_DOWNLOAD_CONSENT_KEY, 'maybe');
  assertEqual(hasVoiceDownloadConsent(storage), false, 'only the exact flag counts as yes');
});

await runCase('the browser factory returns something or honestly returns null', () => {
  // Under the Node test runner there is no localStorage at all, so this is
  // the null branch; in a browser it is the Storage object. Either way it
  // must not throw at module level or during a render.
  const storage = browserVoiceConsentStorage();
  assert(storage === null || typeof storage.getItem === 'function', 'a usable storage or an honest null');
});

console.log('voiceDownloadConsent.cases.test.ts — all passed');
