/**
 * Keeping an open page from running an old version. A page that stays open, or a phone that comes back to the browser,
 * runs the version it loaded, however often the site has been updated since (04.11.2026: the screens of an older version
 * were still being used a day after the fix). The app asks the server which version is current; when it differs, it
 * reloads itself if that costs the person nothing, and otherwise says so quietly. These are the rules; the browser side
 * is in appUpdateWatcher.ts.
 */

/** Away from the page for this long: coming back, it is safe to swap the version (nothing is being read or typed). */
export const AUTO_RELOAD_AFTER_HIDDEN_MS = 2 * 60 * 1000;
/** While the page is in front of the person the server is asked this often. */
export const CHECK_EVERY_MS = 10 * 60 * 1000;
/** Never ask twice within this time (focus, visibility and the timer can all fire together). */
export const MIN_GAP_BETWEEN_CHECKS_MS = 30 * 1000;

export const UPDATE_NOTICE_COPY = {
  text: 'Вышла новая версия StaySee.',
  button: 'Обновить',
} as const;

/** The version of a page is the name of its main script (it carries a hash that changes with every build). */
export function entryFromHtml(html: string): string | null {
  const match = /<script[^>]*\ssrc="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(html);
  return match ? match[1] : null;
}

/** Only when both are known and differ: an unknown is never taken for "new". */
export function isNewVersion(current: string | null, latest: string | null): boolean {
  return current !== null && latest !== null && current !== latest;
}

export type UpdateAction = 'none' | 'reload' | 'notice';

/**
 * - reload: the person was away long enough, nothing is on its way and nothing typed is unsent;
 * - notice: a quiet line with a button (they are looking at the page, or typing, or a message is going);
 * - never a second reload for the same version: a stale copy somewhere would loop forever.
 */
export function decideUpdateAction(input: {
  newVersion: boolean;
  /** How long the page was hidden before the person came back; null when it was in front of them the whole time. */
  hiddenForMs: number | null;
  busy: boolean;
  hasUnsentText: boolean;
  alreadyReloadedFor: string | null;
  latest: string | null;
}): UpdateAction {
  if (!input.newVersion) return 'none';
  if (input.alreadyReloadedFor !== null && input.alreadyReloadedFor === input.latest) return 'notice';
  if (input.busy || input.hasUnsentText) return 'notice';
  if (input.hiddenForMs !== null && input.hiddenForMs >= AUTO_RELOAD_AFTER_HIDDEN_MS) return 'reload';
  return 'notice';
}
