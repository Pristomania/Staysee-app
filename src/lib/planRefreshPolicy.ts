/**
 * When the app asks the server again about the person's plan and access.
 *
 * Returning to the tab, a page being shown again and coming back online read the plan QUIETLY: the screens stay as they are while the
 * answer comes, and if the answer says the rights changed, the screens follow. (The strict re-read, which marks the plan unverified
 * for the length of the request, is for a real jump of the device clock; the snapshot controller watches that itself.)
 *
 * An open, visible tab also asks every PLAN_RECHECK_MS, so a right taken away on the server does not stay on a screen until the person
 * happens to leave and come back.
 */

/** Short enough that a revoked right does not linger, long enough to be a trivial load (one small request). */
export const PLAN_RECHECK_MS = 30_000;

/** Only a tab the person can see asks on the timer. */
export function shouldRecheckOnTick(visibilityState: string): boolean {
  return visibilityState === 'visible';
}
