/**
 * continuationGuards + finalize guard cases.
 * Run: npx tsx supabase/functions/_shared/continuationGuards.cases.test.ts
 */

import { isDuplicateContinuation } from "./continuationGuards.ts";
import {
  isClearlyTruncatedForFinalize,
  shouldRunFinalize,
} from "./completeReply.ts";
import { mergeContinuationWithoutOverlap } from "./mergeContinuation.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// 1. exact duplicate continuation → discarded
assert(
  isDuplicateContinuation(
    "Ты устала, и это важно услышать. Иногда тело говорит раньше слов.",
    "Ты устала, и это важно услышать. Иногда тело говорит раньше слов, и это нормально."
  ),
  "exact/near duplicate"
);
console.log("PASS: exact duplicate continuation → duplicate");

// 2. repeated first sentence → discarded
assert(
  isDuplicateContinuation(
    "Мне важно понять, что с тобой происходит. Это может занять время.",
    "Мне важно понять, что с тобой происходит. И ещё одна мысль здесь."
  ),
  "repeated first sentence"
);
console.log("PASS: repeated first sentence → duplicate");

// 3. legitimate continuation → not duplicate, merges
const legit = mergeContinuationWithoutOverlap(
  "Мне важно понять",
  "Что ты чувствуешь сейчас?"
);
assert(!isDuplicateContinuation("Мне важно понять", "Что ты чувствуешь сейчас?"), "legit not duplicate");
assert(legit.text.includes("понять"), "legit merge keeps head");
console.log("PASS: legitimate continuation → merged");

// 4. tail overlap → merged normally
const tail = mergeContinuationWithoutOverlap(
  "Это важный момент, потому что",
  "потому что ты уже давно несёшь это одна."
);
assert(tail.strategy === "word_overlap" || tail.text.includes("потому что"), "tail overlap merge");
assert(
  !isDuplicateContinuation(
    "Это важный момент, потому что",
    "потому что ты уже давно несёшь это одна."
  ),
  "tail overlap not full duplicate"
);
console.log("PASS: tail overlap → merged normally");

// 5. finalize skipped after auto-continue when text ends with punctuation
assert(
  !shouldRunFinalize("Ты устала, и это важно услышать.", true),
  "finalize skip after period"
);
console.log("PASS: finalize skipped after auto-continue with period");

// 6. finalize allowed after auto-continue when text ends with comma
assert(
  shouldRunFinalize("Ты устала, и это важно понять,", true),
  "finalize after comma"
);
assert(isClearlyTruncatedForFinalize("Ты устала, и это важно понять,"), "comma truncated");
console.log("PASS: finalize allowed after comma");

// 7. finalize allowed after auto-continue when text ends with dash
assert(
  shouldRunFinalize("Я слышу, как тебе тяжело —", true),
  "finalize after dash"
);
console.log("PASS: finalize allowed after dash");

// 8. finalize allowed after auto-continue when clearly truncated
assert(
  shouldRunFinalize("Похоже, внутри сейчас очень важный момен", true),
  "finalize after mid-word"
);
console.log("PASS: finalize allowed when clearly truncated");

// deep budget audit (source constant — avoids npm: import chain via responseBudget.ts)
const budgetSrc = readFileSync(join(__dir, "responseBudget.ts"), "utf8");
assert(/deep:\s*1600/.test(budgetSrc), "deep maxTokens target must be 1600");
assert(/brief:\s*380/.test(budgetSrc), "brief maxTokens unchanged");
assert(/medium:\s*900/.test(budgetSrc), "medium maxTokens unchanged");
console.log("PASS: deep maxTokens=1600 (brief/medium unchanged)");

console.log("\nAll continuationGuards cases passed.");
