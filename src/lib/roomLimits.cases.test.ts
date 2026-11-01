/**
 * Run: npx tsx src/lib/roomLimits.cases.test.ts
 * How many conversations a person may have comes from the plan (src/lib/plans.ts), except for the founders' accounts.
 */

import {
  canCreateRoom,
  getConversationFetchLimit,
  getMaxRooms,
  hasUnlimitedRooms,
  roomLimitNotice,
} from './roomLimits.ts';

const FOUNDER = 'cff5913e-10d2-4168-82de-ec0c0ff48929';
const OTHER = '00000000-0000-4000-8000-000000000001';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(!hasUnlimitedRooms(undefined), 'undefined not unlimited');
assert(!hasUnlimitedRooms(OTHER), 'random user not unlimited');
assert(hasUnlimitedRooms(FOUNDER), 'founder unlimited');

// one, three, six
assert(getMaxRooms(OTHER, 'free') === 1, 'free: 1');
assert(getMaxRooms(OTHER, 'basic') === 3, 'basic: 3');
assert(getMaxRooms(OTHER, 'premium') === 6, 'premium: 6');
assert(getMaxRooms(OTHER, 'something-else') === 1, 'an unknown plan is the strictest');
assert(getMaxRooms(OTHER, undefined) === 1, 'no plan is the strictest');
assert(getMaxRooms(FOUNDER, 'free') === Infinity, 'founder infinite max');

assert(getConversationFetchLimit(OTHER) >= 6, 'the list holds the most any plan gives');
assert(getConversationFetchLimit(FOUNDER) === 100, 'founder fetch cap');

assert(!canCreateRoom(OTHER, 1, 'free'), 'free at the cap');
assert(canCreateRoom(OTHER, 0, 'free'), 'free with none: can create');
assert(canCreateRoom(OTHER, 2, 'basic'), 'basic below the cap');
assert(!canCreateRoom(OTHER, 3, 'basic'), 'basic at the cap');
assert(canCreateRoom(OTHER, 5, 'premium'), 'premium below the cap');
assert(!canCreateRoom(OTHER, 6, 'premium'), 'premium at the cap');
assert(!canCreateRoom(OTHER, 4, 'basic'), 'a person above the cap after moving to a lower plan cannot add');
assert(canCreateRoom(FOUNDER, 99, 'free'), 'founder always can create');

// what the person reads when the place is taken
const free = roomLimitNotice('free');
assert(/одна беседа/.test(free) && /удалит/.test(free), 'free notice says there is one conversation and how to open a place');
assert(/три беседы/.test(roomLimitNotice('basic')), 'basic notice says three');
assert(/шесть бесед/.test(roomLimitNotice('premium')), 'premium notice says six');
assert(/удалит/.test(roomLimitNotice('basic')), 'every notice tells how to open a place');
assert(!/пять/.test(`${free}${roomLimitNotice('basic')}${roomLimitNotice('premium')}`), 'the old "five" is gone');

console.log('All roomLimits cases passed.');
