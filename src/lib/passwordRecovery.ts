const STORAGE_KEY = 'staysee:password-recovery';
const OWNER_KEY = 'staysee:password-recovery-owner';

/** Auth redirect types in Supabase email / OAuth links (hash or query). */
export type AuthCallbackType =
  | 'recovery'
  | 'signup'
  | 'magiclink'
  | 'invite'
  | 'email_change'
  | 'email';

export function markPasswordRecoveryPending(ownerId?: string | null): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, '1');
    if (ownerId) sessionStorage.setItem(OWNER_KEY, ownerId);
  } catch {
    // ignore
  }
}

export function clearPasswordRecoveryPending(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(OWNER_KEY);
  } catch {
    // ignore
  }
}

/** A recovery episode belongs to one account, including after a clean-URL reload. */
export function getPasswordRecoveryOwner(): string | null {
  try { return sessionStorage.getItem(OWNER_KEY); } catch { return null; }
}

export function isPasswordRecoveryPending(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readAuthCallbackType(raw: string): AuthCallbackType | null {
  const match = raw.match(/(?:^|[?&#])type=([a-z_]+)/i);
  if (!match) return null;
  const t = match[1].toLowerCase();
  switch (t) {
    case 'recovery':
    case 'signup':
    case 'magiclink':
    case 'invite':
    case 'email_change':
    case 'email':
      return t;
    default:
      return null;
  }
}

/** Parsed `type=` from the current URL (signup confirmation, recovery, magic link, …). */
export function getAuthCallbackTypeFromUrl(): AuthCallbackType | null {
  if (typeof window === 'undefined') return null;
  return (
    readAuthCallbackType(window.location.hash)
    ?? readAuthCallbackType(window.location.search)
  );
}

/** True only for password-reset links (`type=recovery`), not signup confirmation. */
export function hasRecoveryCallbackInUrl(): boolean {
  return getAuthCallbackTypeFromUrl() === 'recovery';
}

/** True while Supabase auth tokens are still in the address bar. */
export function hasAuthCallbackInUrl(): boolean {
  if (typeof window === 'undefined') return false;
  if (getAuthCallbackTypeFromUrl()) return true;
  const hash = window.location.hash;
  return hash.includes('access_token') || hash.includes('error=');
}

/** Remove auth tokens from the address bar after the client consumed the session. */
export function clearAuthCallbackFromUrl(): void {
  if (typeof window === 'undefined') return;
  if (!hasAuthCallbackInUrl()) return;
  const clean = window.location.pathname + window.location.search;
  window.history.replaceState(null, '', clean);
}

/** @deprecated Use clearAuthCallbackFromUrl — kept for existing imports. */
export function clearRecoveryCallbackFromUrl(): void {
  clearAuthCallbackFromUrl();
}

/** Initial flag: only recovery links / stale recovery session, never signup confirm. */
export function shouldStartInPasswordRecovery(): boolean {
  const callbackType = getAuthCallbackTypeFromUrl();
  if (callbackType && callbackType !== 'recovery') {
    clearPasswordRecoveryPending();
    return false;
  }
  if (callbackType === 'recovery') {
    return true;
  }
  return isPasswordRecoveryPending();
}
