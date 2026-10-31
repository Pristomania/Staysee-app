// What a person has typed on the registration screen while they read a document (the offer, the policy, the consent).
// The screen is closed while a document is open, so without this the address, both passwords and the three
// checkboxes were lost. Kept in memory only, never written to storage; given back once, and dropped after a while
// if the person never comes back.

export interface RegisterDraft {
  email: string;
  password: string;
  confirmPassword: string;
  confirmedAge18: boolean;
  acceptedTerms: boolean;
  acceptedPd: boolean;
}

export const REGISTER_DRAFT_TTL_MS = 15 * 60 * 1000;

let saved: { draft: RegisterDraft; savedAt: number } | null = null;

export function saveRegisterDraft(draft: RegisterDraft, now: number = Date.now()): void {
  saved = { draft: { ...draft }, savedAt: now };
}

/** The saved draft, once: a later visit to the registration starts with an empty form. */
export function takeRegisterDraft(now: number = Date.now()): RegisterDraft | null {
  const found = saved;
  saved = null;
  if (!found || now - found.savedAt > REGISTER_DRAFT_TTL_MS) return null;
  return found.draft;
}

export function clearRegisterDraft(): void {
  saved = null;
}
