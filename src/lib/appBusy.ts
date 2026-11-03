/**
 * Marks set by the screens that must not be interrupted by an automatic update (a message on its way, a voice being
 * recorded). The update check reads them; it never reloads the page while any mark is set.
 */

const marks = new Set<string>();

export function setAppBusy(key: string, on: boolean): void {
  if (on) marks.add(key);
  else marks.delete(key);
}

export function isAppBusy(): boolean {
  return marks.size > 0;
}
