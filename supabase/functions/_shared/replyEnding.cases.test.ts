/**
 * Reply ending / sentence boundary cases (the rule of 20.11.2026: an ending is a sentence mark or an emoji, no lists of words; a
 * reply the model finished on its own is complete whatever its last character is; see replyEndingRule.cases.test.ts for the rule in full).
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

// Endings by themselves: a sentence mark or an emoji.
const ENDS_ON_A_MARK = [
  "Спокойной ночи 💙",
  "Хорошо. Спи — это сейчас правильно.",
  "Я здесь.",
  "Ты способен любить избранных людей и заботиться о них.",
];

// No mark and no emoji at the end: not an ending by itself (the words are never looked at).
const NO_MARK = [
  "Приятных снов",
  "Хорошо. Спокойной ночи",
  "Спасибо, что сказала",
  "Ты сегодня смогла",
  "Похоже, это",
  "И тогда",
  "Потому что",
  "Это как будто",
  "Ты говоришь о том, что",
];

for (const text of ENDS_ON_A_MARK) {
  assert(endsAtSentenceBoundary(text), `boundary accept: ${text}`);
  assert(!hasBrokenEnding(text), `not broken: ${text}`);
  assert(isPublishableReply(text), `publishable: ${text}`);
  const explained = explainPublishability(text);
  assert(explained.publishable, `explain publishable: ${text} (${explained.reasons.join(",")})`);
  console.log(`✓ ends on a mark: ${text}`);
}

for (const text of NO_MARK) {
  assert(!endsAtSentenceBoundary(text), `not an ending by itself: ${text}`);
  // Cut by length, or the reason unknown: not finished.
  assert(!isPublishableReply(text), `no reason given: ${text}`);
  assert(!isPublishableReply(text, "length"), `cut by length: ${text}`);
  // Finished by the model: complete, whatever the last words are.
  assert(isPublishableReply(text, "stop"), `finished by the model: ${text}`);
  assert(explainPublishability(text, "stop").publishable, `explained as publishable after a stop: ${text}`);
  console.log(`✓ no mark: ${text}`);
}

// Preserve existing behavior
assert(endsAtSentenceBoundary("Я здесь."), "punctuation ending");
assert(isPublishableReply("Ты способен любить избранных людей и заботиться о них."), "long punctuated");
assert(!isPublishableReply("Первый блок текста. Сейчас это очень важный момен"), "a cut fragment is not finished");
assert(endsAtSentenceBoundary(""), "empty boundary");

const longNoBoundary =
  "Ты прошла через многое сегодня и поняла важные вещи о себе без финальной точки";
assert(!isPublishableReply(longNoBoundary, "length"), "long text cut by length without a mark");
assert(isPublishableReply(longNoBoundary, "stop"), "the same text that the model finished by itself");

console.log("\nAll replyEnding cases passed.");
