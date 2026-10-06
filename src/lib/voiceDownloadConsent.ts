/**
 * Whether this browser has already agreed to download the on-device voice
 * package, and whether pressing the microphone should ask first.
 *
 * Product rule 7: nothing downloads until the person has said yes. The
 * stored flag is a convenience -- it exists so somebody who already agreed
 * is not asked again on every visit. It is never a security boundary: the
 * only thing that actually prevents a download is that `controller.start()`
 * is not called until `voiceDownloadDecision` says `start`.
 *
 * Storage is injected rather than reached for, the same way
 * `createLocalVoiceDictationAdapter(platform)` takes its platform, so every
 * case in the test file runs against a plain Map with nothing global
 * touched.
 */

export const VOICE_DOWNLOAD_CONSENT_KEY = 'staysee-voice-download-consent';

export interface VoiceConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type VoiceDownloadDecision = 'start' | 'ask';

export function browserVoiceConsentStorage(): VoiceConsentStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Some hardened privacy modes throw on the property access itself, not
    // just on the call.
    return null;
  }
}

export function hasVoiceDownloadConsent(storage: VoiceConsentStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(VOICE_DOWNLOAD_CONSENT_KEY) === '1';
  } catch {
    // Unreadable storage means we have no evidence of an agreement, and no
    // evidence is a no.
    return false;
  }
}

export function rememberVoiceDownloadConsent(storage: VoiceConsentStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(VOICE_DOWNLOAD_CONSENT_KEY, '1');
  } catch {
    // Full or blocked storage just means the person is asked again next
    // visit, which is the safe direction to fail in.
  }
}

export function forgetVoiceDownloadConsent(storage: VoiceConsentStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(VOICE_DOWNLOAD_CONSENT_KEY);
  } catch {
    // Same reasoning in the other direction: the worst case is one extra
    // confirmation, never a silent 83 MB download.
  }
}

/**
 * `ask` means show the consent card and call nothing. `start` means call
 * `controller.start()` directly.
 */
export function voiceDownloadDecision(input: {
  supported: boolean;
  /** `null` while the Cache Storage probe has not answered yet. */
  packageCached: boolean | null;
  consentRemembered: boolean;
}): VoiceDownloadDecision {
  // A device that cannot run the engine must not be invited to download it.
  // `controller.start()` checks `adapter.supported` before anything else and
  // publishes the honest `unsupported` error without touching the network.
  if (!input.supported) return 'start';
  // Nothing is going to download, so there is nothing to agree to.
  if (input.packageCached === true) return 'start';
  if (input.consentRemembered) return 'start';
  // Everything else -- not cached, or not yet known -- asks.
  return 'ask';
}
