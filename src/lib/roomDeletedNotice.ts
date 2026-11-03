/**
 * The message for someone who signs in to a deleted room. The sign-in lets the person in for a moment; the app moves
 * on to the main screen and only then reads the profile and learns the room is deleted, so the sign-in screen that was
 * to show the message is already gone (seen in the live journey and on a phone, 03–04.11.2026: back on the first screen
 * with no word). The app therefore notes the message, with the day the address opens again, signs the person out and
 * brings them back to the sign-in screen, which shows it once.
 */

const STORAGE_KEY = 'staysee:room-deleted-notice';

export interface RoomDeletedNotice {
  /** The day the address opens again (the profile's room_purge_after), or null when it is not known. */
  availableFrom: string | null;
}

export function rememberRoomDeletedNotice(availableFrom: string | null | undefined): void {
  try {
    const value: RoomDeletedNotice = { availableFrom: typeof availableFrom === 'string' ? availableFrom : null };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore: the message is a courtesy, the person is signed out either way
  }
}

/** The waiting message, without using it up (a screen may read it twice while it is built). */
export function peekRoomDeletedNotice(): RoomDeletedNotice | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const day = (parsed as { availableFrom?: unknown }).availableFrom;
    return { availableFrom: typeof day === 'string' ? day : null };
  } catch {
    return null;
  }
}

export function hasRoomDeletedNotice(): boolean {
  return peekRoomDeletedNotice() !== null;
}

export function forgetRoomDeletedNotice(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
