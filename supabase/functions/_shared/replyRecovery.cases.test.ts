/**
 * Reply recovery route + duplicate closure tests.
 * Run: npx tsx supabase/functions/_shared/replyRecovery.cases.test.ts
 */

import {
  applyLocalStructuralRepair,
  classifyInitialRoute,
  detectDuplicateClosure,
  mergeLengthContinuation,
  repairDuplicateClosure,
} from "./replyRecovery.ts";
import {
  needsAutoContinue,
  needsStopNotPublishableRepair,
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

// needsStopNotPublishableRepair
assert(
  needsStopNotPublishableRepair("Первый блок. Сейчас важный момен", "stop"),
  "notPublishable+stop repair → true"
);
assert(!needsStopNotPublishableRepair("Я здесь.", "stop"), "publishable+stop repair → false");
assert(
  !needsStopNotPublishableRepair("обрыв", "length"),
  "length → no stop repair"
);

// Route classification
assert(
  classifyInitialRoute("Я здесь.", "stop") === "normal_publishable",
  "normal publishable route"
);
assert(
  classifyInitialRoute("обрыв без точки", "length") === "length_truncation_continue",
  "length route"
);
assert(
  classifyInitialRoute("обрыв без точки", "stop") === "stop_not_publishable_repair",
  "stop repair route"
);

// Production-like duplicate closure fixture
const partA =
  "Ты легла. Ты в своей постели.\n\nЭто — твоя победа. Твоя ночь. Твоя жизнь.\n\nСпи. Ты заслужила этот покой.";
const partB =
  "Ты сегодня прошла через огонь. Ты выгнала её. Ты забрала дом.";
const merged = mergeLengthContinuation(partA, partB);
assert(merged.mergeStrategy === "paragraph_sep", "merge strategy paragraph_sep");
assert(
  detectDuplicateClosure(`${partA}\n\n${partB}`),
  "detect duplicate closure in fixture"
);
const repaired = repairDuplicateClosure(`${partA}\n\n${partB}`);
assert(repaired.repaired, "repair duplicate closure");
assert(!detectDuplicateClosure(repaired.text), "repaired text clean");

// Local repair does not invent content
const broken = "Первое предложение. Второе обрывается —";
const repairedLocal = applyLocalStructuralRepair(broken);
assert(isPublishableReply(repairedLocal), "local repair can publish");

// explainPublishability
const explained = explainPublishability("обрыв");
assert(!explained.publishable && explained.reasons.length > 0, "explain not publishable");

console.log("All replyRecovery cases passed.");
