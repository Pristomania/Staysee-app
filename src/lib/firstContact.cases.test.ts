/**
 * Run: npx tsx src/lib/firstContact.cases.test.ts
 * The introduction of the first conversation: the approved text, and only for an account with no conversation yet.
 */

import { FIRST_CONTACT_MESSAGE, isFirstConversation } from './firstContact';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(FIRST_CONTACT_MESSAGE.startsWith('Привет. Я Стэйси.'), 'she says who she is, warmly, first');
assert(/слушаю, замечаю и помогаю услышать себя/.test(FIRST_CONTACT_MESSAGE), 'and says what she does');
assert(/скажи, как тебя зовут и как к тебе обращаться/.test(FIRST_CONTACT_MESSAGE), 'she offers to get acquainted: the name and the way to address');
assert(/Или предпочитаешь остаться инкогнито\?$/.test(FIRST_CONTACT_MESSAGE), 'and to stay incognito, without conditions');
assert(!/врач|психолог|диагноз|тяжело/i.test(FIRST_CONTACT_MESSAGE), 'nothing that makes a person who came with something hard feel smaller');
assert(!/StaySee/i.test(FIRST_CONTACT_MESSAGE), 'no name of the product in a place the person reads as hers');

assert(isFirstConversation(0), 'a person with no conversation gets the introduction');
assert(!isFirstConversation(1) && !isFirstConversation(7), 'any later conversation does not');

console.log('All firstContact cases passed.');
