/**
 * The extra addresses the same app is served from (28.11.2026: staysee.ru does not open on some Russian networks). Opened at one of them,
 * the app talks to that same address; opened at staysee.ru (or anywhere else) it behaves as before.
 */
export const EXTRA_APP_HOSTS: ReadonlySet<string> = new Set(['staysee.online', 'app.stayseeai.online']);

export function ownOriginBase(
  location: { protocol: string; hostname: string; origin: string } | undefined,
  path: string,
  fallback: string,
): string {
  return location && location.protocol === 'https:' && EXTRA_APP_HOSTS.has(location.hostname) ? `${location.origin}${path}` : fallback;
}
