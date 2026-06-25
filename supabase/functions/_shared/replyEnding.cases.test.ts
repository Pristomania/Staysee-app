/**
 * Reply ending / sentence boundary cases.
 * Run: npx tsx supabase/functions/_shared/replyEnding.cases.test.ts
 */

import {
  endsAtSentenceBoundary,
  hasBrokenEnding,
} from "./replyEnding.ts";
import { isPublishableReply } from "./completeReply.ts";
import { explainPublishability } from "./replyPublishability.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const ACCEPT = [
  "Спокойной ночи 💙",
  "Приятных снов",
  "Хорошо. Спи — это сейчас правильно.",
  "Хорошо. Спокойной ночи",
  "Спасибо, что сказала",
];

const REJECT = [
  "Ты сегодня смогла",
  "Похоже, это",
  "И тогда",
  "Потому что",
  "Это как будто",
  "Ты говоришь о том, что",
];

for (const text of ACCEPT) {
  assert(endsAtSentenceBoundary(text), `boundary accept: ${text}`);
  assert(!hasBrokenEnding(text), `not broken: ${text}`);
  assert(isPublishableReply(text), `publishable: ${text}`);
  const explained = explainPublishability(text);
  assert(explained.publishable, `explain publishable: ${text} (${explained.reasons.join(",")})`);
  console.log(`✓ accept: ${text}`);
}

for (const text of REJECT) {
  assert(!isPublishableReply(text), `reject publishable: ${text}`);
  console.log(`✓ reject: ${text}`);
}

// Preserve existing behavior
assert(endsAtSentenceBoundary("Я здесь."), "punctuation ending");
assert(isPublishableReply("Ты способен любить избранных людей и заботиться о них."), "long punctuated");
assert(!isPublishableReply("Первый блок текста. Сейчас это очень важный момен"), "long broken fragment");
assert(endsAtSentenceBoundary(""), "empty boundary");

const longNoBoundary =
  "Ты прошла через многое сегодня и поняла важные вещи о себе без финальной точки";
assert(!isPublishableReply(longNoBoundary), "long substantive without boundary");

console.log("\nAll replyEnding cases passed.");
