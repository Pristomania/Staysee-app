/**
 * Run: npx tsx src/lib/roomCopy.cases.test.ts
 * What a person is told when they press "delete the data of the account" or "delete all memory": what goes, and that
 * the plan, the messages left and the bought messages stay. No money, no numbers.
 */

import { mapSignUpError } from './authErrors.ts';
import { ROOM_COPY, roomDeletedLoginText } from './roomCopy.ts';

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

// A deleted room keeps its sign-in record for 3 months (so the 50 free messages cannot be had again by signing up anew),
// so the same address is "taken" for that long. The hint must not send someone who deleted the room to sign in or
// reset the password as if that could bring it back.
const taken = ROOM_COPY.roomExistsEmail.toLowerCase();
assert(taken.includes('удал') && taken.includes('3 месяц'), 'the "address is taken" text covers a room deleted within 3 months');
assert(taken.includes('забыли пароль'), 'it still helps whoever has a live room');
assert(taken.includes('точную дату покажет вход'), 'it says where to see the exact date');
assert(mapSignUpError('User already registered') === ROOM_COPY.roomExistsEmail, 'the sign-up error uses the same text');
assert(mapSignUpError('Email address has already been registered') === ROOM_COPY.roomExistsEmail, 'also the other wording of the same error');

const deletedLogin = ROOM_COPY.roomDeletedLogin.toLowerCase();
assert(deletedLogin.includes('удалена') && deletedLogin.includes('нельзя'), 'signing in to a deleted room says it is gone for good');
assert(deletedLogin.includes('3 месяц'), 'and when the address becomes free again, in months if the date is not known');

// With the date the database holds, the person sees the day, not "in 3 months": they may come back and look in a month.
const now = new Date('2026-11-04T10:00:00Z');
assert(/Новую комнату на этот email можно будет создать с (3|4) февраля 2027\.$/.test(roomDeletedLoginText('2027-02-04T00:00:00Z', now)), roomDeletedLoginText('2027-02-04T00:00:00Z', now));
assert(roomDeletedLoginText('2027-02-04T00:00:00Z', now).startsWith('Эта комната удалена, восстановить её нельзя.'), 'it still says it cannot be restored');
assert(/ноября$|ноября\./.test(roomDeletedLoginText('2026-11-20T00:00:00Z', now)) && !/2026/.test(roomDeletedLoginText('2026-11-20T00:00:00Z', now)), 'the year is written only when it is not the current one');
assert(roomDeletedLoginText(null, now) === ROOM_COPY.roomDeletedLogin, 'no date: the plain text');
assert(roomDeletedLoginText('not a date', now) === ROOM_COPY.roomDeletedLogin, 'a broken date: the plain text');

// What the person is told before deleting the room: the sign-in record stays 3 months, and why.
const hint = ROOM_COPY.deleteRoomHint.toLowerCase();
assert(hint.includes('3 месяц') && !hint.includes('14 дней'), 'the hint names the 3 months, not 14 days');
assert(hint.includes('бесплатные сообщения'), 'it says why the record stays');
assert(ROOM_COPY.deleteRoomDone.includes('3 месяц') && !ROOM_COPY.deleteRoomDone.includes('14'), 'the done text names 3 months');

console.log('All roomCopy cases passed.');
