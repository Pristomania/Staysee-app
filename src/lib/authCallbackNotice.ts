/**
 * What the sign-in screen says after the link in the confirmation email. The link confirms the address; whether it also
 * lets the person in depends on the phone and the mail app that opened it (04.11.2026: it confirmed the address and left
 * the person on the first screen with no word about it). So the page notes what the link was, and if nobody ends up
 * signed in, the person is taken to the sign-in screen with one calm line. A person who is let in never sees it.
 */

export type AuthCallbackNotice = 'confirmed' | 'link_error';

export const AUTH_NOTICE_COPY: Record<AuthCallbackNotice, string> = {
  confirmed: 'Почта подтверждена. Теперь войдите: введите email и пароль.',
  link_error:
    'Эта ссылка уже использована или устарела. Если почта уже подтверждена, просто войдите. Если вы меняли пароль, нажмите «Забыли пароль?» и откройте новое письмо.',
};

const STORAGE_KEY = 'staysee:auth-callback-notice';

/** What the address bar says about the link: a confirmed sign-up, a dead link, or nothing (a normal visit). */
export function readAuthCallbackNotice(hash: string, search: string): AuthCallbackNotice | null {
  const parts = `${hash}&${search}`;
  if (/(?:^|[?&#])(?:error|error_code)=/i.test(parts)) return 'link_error';
  if (/(?:^|[?&#])type=signup(?:&|$)/i.test(parts)) return 'confirmed';
  return null;
}

/** Notes the notice for the sign-in screen (the address bar is cleaned soon after the page opens). */
export function rememberAuthCallbackNotice(hash: string, search: string): void {
  const notice = readAuthCallbackNotice(hash, search);
  if (!notice) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, notice);
  } catch {
    // ignore: the notice is a courtesy
  }
}

function stored(): AuthCallbackNotice | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return value === 'confirmed' || value === 'link_error' ? value : null;
  } catch {
    return null;
  }
}

export function hasAuthCallbackNotice(): boolean {
  return stored() !== null;
}

export function forgetAuthCallbackNotice(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** The notice waiting for the sign-in screen, without using it up (a screen may read it twice while it is built). */
export function peekAuthCallbackNotice(): AuthCallbackNotice | null {
  return stored();
}
