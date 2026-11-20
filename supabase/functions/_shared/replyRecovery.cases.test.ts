/**
 * Reply recovery route + merge tests (the rule of 20.11.2026: nothing is removed by phrases, a stopped reply is not repaired).
 * Run: npx tsx supabase/functions/_shared/replyRecovery.cases.test.ts
 */

import {
  classifyInitialRoute,
  mergeLengthContinuation,
} from "./replyRecovery.ts";
import * as replyRecovery from "./replyRecovery.ts";
import {
  needsAutoContinue,
  isPublishableReply,
} from "./completeReply.ts";
import { explainPublishability } from "./replyPublishability.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// needsAutoContinue — length only
assert(needsAutoContinue("x".repeat(20), "length"), "length → true");
assert(needsAutoContinue("Я здесь.", "length"), "publishable+length → true");
assert(!needsAutoContinue("Я здесь.", "stop"), "publishable+stop → false");
assert(
  !needsAutoContinue("Первый блок. Сейчас важный момен", "stop"),
  "notPublishable+stop → false"
);

// Whether a reply is complete depends on how the model stopped
assert(!isPublishableReply("обрыв", "length") && isPublishableReply("обрыв", "stop"), "publishable depends on how the model stopped");

// Route classification
assert(classifyInitialRoute("Я здесь.", "stop") === "normal_publishable", "normal publishable route");
assert(classifyInitialRoute("обрыв без точки", "length") === "length_truncation_continue", "length route");
assert(classifyInitialRoute("обрыв без точки", "stop") === "normal_publishable", "a stop without a mark is left alone (no repair route)");
assert(classifyInitialRoute("Я здесь.", "length") === "normal_publishable", "cut by length but already on a mark: nothing to continue");

// The helpers that repaired a stopped reply, or removed paragraphs by phrases, are gone (guard against bringing them back)
for (const gone of ["applyLocalStructuralRepair", "detectDuplicateClosure", "repairDuplicateClosure"]) {
  assert(!(gone in replyRecovery), `${gone} must not exist`);
}

// A continuation is joined to the text; nothing is dropped after a goodbye
const partA =
  "Ты легла. Ты в своей постели.\n\nЭто — твоя победа. Твоя ночь. Твоя жизнь.\n\nСпи. Ты заслужила этот покой.";
const partB = "Ты сегодня прошла через огонь. Ты выгнала её. Ты забрала дом.";
const merged = mergeLengthContinuation(partA, partB);
assert(merged.mergeStrategy === "paragraph_sep", "merge strategy paragraph_sep");
assert(
  merged.content.includes("Ты заслужила этот покой.") && merged.content.includes("Ты сегодня прошла через огонь."),
  "both parts stay"
);

// explainPublishability
const explained = explainPublishability("обрыв");
assert(!explained.publishable && explained.reasons.length > 0, "explain not publishable without a reason");
assert(explainPublishability("обрыв", "stop").publishable, "explained as publishable after a stop");

console.log("All replyRecovery cases passed.");
