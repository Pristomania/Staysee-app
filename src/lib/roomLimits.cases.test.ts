/**
 * Run: npx tsx src/lib/roomLimits.cases.test.ts
 * How many conversations a person may have comes from the plan (src/lib/plans.ts), or from the number the database
 * gives them by hand (max_conversations_override: the owner's accounts, the technical user). The app keeps no list
 * of people: the database is the one place, and it enforces the same number (migration 087).
 */

import {
  canCreateRoom,
  getConversationFetchLimit,
  getMaxRooms,
  roomLimitNotice,
} from './roomLimits.ts';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// one, three, six
assert(getMaxRooms('free') === 1, 'free: 1');
assert(getMaxRooms('basic') === 3, 'basic: 3');
assert(getMaxRooms('premium') === 6, 'premium: 6');
assert(getMaxRooms('something-else') === 1, 'an unknown plan is the strictest');
assert(getMaxRooms(undefined) === 1, 'no plan is the strictest');

// a number given by hand wins over the plan, and nonsense is ignored
assert(getMaxRooms('free', 100) === 100, 'an override of 100 opens 100 places');
assert(getMaxRooms('premium', 3) === 3, 'an override can also be lower');
assert(getMaxRooms('basic', null) === 3, 'no override: the plan');
assert(getMaxRooms('basic', 0) === 3, 'zero is not a number of places');
assert(getMaxRooms('basic', -4) === 3, 'a negative number is ignored');
assert(getMaxRooms('basic', Number.NaN) === 3, 'NaN is ignored');
assert(getMaxRooms('basic', 7.9) === 7, 'a fraction is cut');

// the list holds the most any plan gives, and more when the person was given more
assert(getConversationFetchLimit(1) >= 10, 'the list holds at least what premium gives, with a margin');
assert(getConversationFetchLimit(100) === 101, 'a person with 100 places sees all of them');

assert(!canCreateRoom(1, 1), 'free at the cap');
assert(canCreateRoom(0, 1), 'free with none: can create');
assert(canCreateRoom(2, 3), 'basic below the cap');
assert(!canCreateRoom(3, 3), 'basic at the cap');
assert(!canCreateRoom(4, 3), 'a person above the cap after moving to a lower plan cannot add');
assert(canCreateRoom(99, 100), 'a person with 100 places can add the 100th');

// what the person reads when the place is taken
const free = roomLimitNotice('free');
assert(/одна беседа/.test(free) && /удалит/.test(free), 'free notice says there is one conversation and how to open a place');
assert(/три беседы/.test(roomLimitNotice('basic')), 'basic notice says three');
assert(/шесть бесед/.test(roomLimitNotice('premium')), 'premium notice says six');
assert(/удалит/.test(roomLimitNotice('basic')), 'every notice tells how to open a place');
assert(!/пять/.test(`${free}${roomLimitNotice('basic')}${roomLimitNotice('premium')}`), 'the old "five" is gone');

console.log('All roomLimits cases passed.');
