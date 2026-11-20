/**
 * Run: npx tsx src/lib/aiMessageFormat.cases.test.ts
 * The rule (owner's decision, 20.11.2026): the words of a reply are never decided by code. The browser used to carry a copy of the
 * server's word filter (display and saved messages): «Чёрт, я сбилась» lost its first word, and ordinary words that start like a
 * listed one lost their beginning at the start of a paragraph («Черты характера» became «ы характера»). It is gone: the person sees
 * the reply as the model wrote it.
 */

import { prepareAiDisplayText } from './aiMessageFormat.tsx';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const REPLIES = [
  'Чёрт, я сбилась. Давай заново.',
  'Блин, я перепутала даты.',
  'Чёрт!',
  'Oh shit, I was wrong.',
  'Черты характера у тебя сильные.',
  'Это важно.\n\nЧертовски устала, да?',
  'Чертёж плана готов.',
];

for (const reply of REPLIES) {
  assert(prepareAiDisplayText(reply) === reply, `the reply is shown as it is: ${JSON.stringify(reply)}`);
}

console.log('All aiMessageFormat cases passed.');
