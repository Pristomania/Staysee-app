/**
 * Run: npx tsx src/lib/roomLimits.cases.test.ts
 */

import {
  DEFAULT_MAX_ROOMS,
  canCreateRoom,
  getConversationFetchLimit,
  getMaxRooms,
  hasUnlimitedRooms,
} from './roomLimits.ts';

const FOUNDER = 'cff5913e-10d2-4168-82de-ec0c0ff48929';
const OTHER = '00000000-0000-4000-8000-000000000001';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(!hasUnlimitedRooms(undefined), 'undefined not unlimited');
assert(!hasUnlimitedRooms(OTHER), 'random user not unlimited');
assert(hasUnlimitedRooms(FOUNDER), 'founder unlimited');

assert(getMaxRooms(OTHER) === DEFAULT_MAX_ROOMS, 'default max rooms');
assert(getMaxRooms(FOUNDER) === Infinity, 'founder infinite max');

assert(getConversationFetchLimit(OTHER) === DEFAULT_MAX_ROOMS + 1, 'default fetch cap');
assert(getConversationFetchLimit(FOUNDER) === 100, 'founder fetch cap');

assert(!canCreateRoom(OTHER, DEFAULT_MAX_ROOMS), 'default at cap');
assert(canCreateRoom(OTHER, DEFAULT_MAX_ROOMS - 1), 'default below cap');
assert(canCreateRoom(FOUNDER, 99), 'founder always can create');

console.log('All roomLimits cases passed.');
