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
import { classifyInitialRoute } from "./replyRecovery.ts";

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

const EMOJI_ACCEPT = [
  "Я рядом 🌿",
  "Ох, понимаю 😅",
  "Давай чуть выдохнем 💫",
  "Это звучит тяжело ❤️",
  "Понимаю тебя 😔",
  "Можно чуть мягче к себе сегодня 🌱",
];

for (const text of EMOJI_ACCEPT) {
  assert(endsAtSentenceBoundary(text), `emoji boundary: ${text}`);
  assert(!hasBrokenEnding(text), `emoji not broken: ${text}`);
  assert(isPublishableReply(text), `emoji publishable: ${text}`);
  assert(
    classifyInitialRoute(text, "stop") === "normal_publishable",
    `emoji no stop_not_publishable_repair: ${text}`
  );
  console.log(`✓ emoji accept: ${text}`);
}

const EMOJI_REJECT = ["🌿", "😅", "Похоже, это 😅", "Ты сегодня смогла 😅", "это 💫"];

for (const text of EMOJI_REJECT) {
  assert(!isPublishableReply(text), `emoji reject publishable: ${text}`);
  assert(
    classifyInitialRoute(text, "stop") === "stop_not_publishable_repair",
    `emoji reject repair route: ${text}`
  );
  console.log(`✓ emoji reject: ${text}`);
}

console.log("\nAll replyEnding cases passed.");
