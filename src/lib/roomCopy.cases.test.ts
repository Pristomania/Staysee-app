/**
 * Run: npx tsx src/lib/roomCopy.cases.test.ts
 * What a person is told when they press "delete the data of the account" or "delete all memory": what goes, and that
 * the plan, the messages left and the bought messages stay. No money, no numbers.
 */

import { mapSignUpError } from './authErrors.ts';
import { ROOM_COPY } from './roomCopy.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const goes = ROOM_COPY.deleteDataConfirmGoes.join(' | ').toLowerCase();
assert(goes.includes('беседы') && goes.includes('сообщения'), 'the data deletion names the conversations and their messages');
assert(goes.includes('записки'), 'it names the notes');
assert(goes.includes('сквозная') && goes.includes('внутри бесед'), 'it names both memories: between conversations and inside them');
assert(goes.includes('поправки'), 'it names the saved corrections');

const stays = ROOM_COPY.deleteDataConfirmStays.toLowerCase();
assert(stays.includes('аккаунт') && stays.includes('тариф') && stays.includes('докупленные сообщения'), 'it says the account, the plan and the bought messages stay');
assert(stays.includes('никуда не пропадут') && stays.includes('нельзя'), 'it says they do not disappear and that the deletion cannot be undone');

const memory = ROOM_COPY.deleteMemoryConfirmGoes.join(' | ').toLowerCase();
assert(memory.includes('сквозная') && memory.includes('внутри бесед') && memory.includes('поправки'), 'the memory deletion names the three kinds');
const memoryStays = ROOM_COPY.deleteMemoryConfirmStays.toLowerCase();
assert(memoryStays.includes('беседы') && memoryStays.includes('записки') && memoryStays.includes('докупленные сообщения'), 'the memory deletion says the conversations, notes and bought messages stay');

for (const text of [goes, stays, memory, memoryStays]) {
  assert(!/₽|\$|руб|потол|себестоим/i.test(text), 'no money in these texts');
}

// A deleted room keeps its sign-in record for 14 days, so the same address is "taken" for that long. The hint must not
// send someone who deleted the room to sign in or reset the password (that cannot bring it back).
const taken = ROOM_COPY.roomExistsEmail.toLowerCase();
assert(taken.includes('удал') && taken.includes('14'), 'the "address is taken" text covers a room deleted within 14 days');
assert(taken.includes('забыли пароль'), 'it still helps whoever has a live room');
assert(mapSignUpError('User already registered') === ROOM_COPY.roomExistsEmail, 'the sign-up error uses the same text');
assert(mapSignUpError('Email address has already been registered') === ROOM_COPY.roomExistsEmail, 'also the other wording of the same error');

const deletedLogin = ROOM_COPY.roomDeletedLogin.toLowerCase();
assert(deletedLogin.includes('удалена') && deletedLogin.includes('нельзя'), 'signing in to a deleted room says it is gone for good');
assert(deletedLogin.includes('14'), 'and when the address becomes free again');

console.log('All roomCopy cases passed.');
