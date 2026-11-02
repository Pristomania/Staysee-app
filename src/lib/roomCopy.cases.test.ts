/**
 * Run: npx tsx src/lib/roomCopy.cases.test.ts
 * What a person is told when they press "delete the data of the account" or "delete all memory": what goes, and that
 * the plan, the messages left and the bought messages stay. No money, no numbers.
 */

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

console.log('All roomCopy cases passed.');
