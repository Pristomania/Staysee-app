/**
 * Run: npx tsx src/lib/roomDeletedNotice.cases.test.ts
 * Signing in to a deleted room used to end on the first screen with no word (03–04.11.2026, the live journey and again
 * on a phone): the sign-in lets the person in for a moment, the app moves on to the main screen, and only then learns
 * the room is deleted, by which time the sign-in screen that was to show the message is gone. So the app notes the
 * message (with the day the address opens again) and brings the person back to the sign-in screen to read it.
 */

import {
  forgetRoomDeletedNotice,
  hasRoomDeletedNotice,
  peekRoomDeletedNotice,
  rememberRoomDeletedNotice,
} from './roomDeletedNotice.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// A browser's sessionStorage, as a small stand-in.
const memory = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

assert(!hasRoomDeletedNotice() && peekRoomDeletedNotice() === null, 'nothing noted at the start');

rememberRoomDeletedNotice('2027-02-05T00:00:00+00:00');
assert(hasRoomDeletedNotice(), 'noted');
assert(peekRoomDeletedNotice()?.availableFrom === '2027-02-05T00:00:00+00:00', 'with the day the address opens again');
assert(peekRoomDeletedNotice() !== null, 'reading it does not use it up (a screen may be built twice)');

forgetRoomDeletedNotice();
assert(!hasRoomDeletedNotice() && peekRoomDeletedNotice() === null, 'forgotten');

// Without a day it is still noted (the plain words are shown).
rememberRoomDeletedNotice(null);
assert(hasRoomDeletedNotice() && peekRoomDeletedNotice()?.availableFrom === null, 'noted without a day');
forgetRoomDeletedNotice();
rememberRoomDeletedNotice(undefined);
assert(hasRoomDeletedNotice() && peekRoomDeletedNotice()?.availableFrom === null, 'an unknown day is none');
forgetRoomDeletedNotice();

// Whatever is in the storage is not trusted.
memory.set('staysee:room-deleted-notice', 'not json');
assert(peekRoomDeletedNotice() === null && !hasRoomDeletedNotice(), 'a broken value is nothing');
memory.set('staysee:room-deleted-notice', JSON.stringify({ availableFrom: 42 }));
assert(peekRoomDeletedNotice()?.availableFrom === null, 'a day that is not text is none');
memory.clear();

// Storage that does not work (private mode): nothing breaks.
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};
rememberRoomDeletedNotice('2027-02-05T00:00:00+00:00');
assert(!hasRoomDeletedNotice() && peekRoomDeletedNotice() === null, 'blocked storage: nothing noted, nothing thrown');
forgetRoomDeletedNotice();

console.log('All roomDeletedNotice cases passed.');
