/**
 * Run: npx tsx supabase/functions/_shared/memoryPrefixCleanup.cases.test.ts
 */

import {
  isBrokenCrossMemoryFragment,
  isPromotableToCrossMemory,
  normalizeCrossMemoryContent,
  stripCrossMemoryDisplayPrefixes,
} from "./crossMemoryPolicy.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("=== prefix cleanup ===\n");

const doubledLife =
  "В жизни пользователя значимы: В жизни пользователя значимы: У пользователя есть сын";
const cleanedLife = normalizeCrossMemoryContent(doubledLife);
assert(
  cleanedLife === "У пользователя есть сын.",
  `life prefix: got "${cleanedLife}"`
);
assert(isPromotableToCrossMemory("life_context", cleanedLife), "life promotable");
console.log("PASS: doubled life prefix → clean son fact");

const doubledComm =
  "В общении важно: В общении важно: Пользователь предпочитает прямоту";
const cleanedComm = normalizeCrossMemoryContent(doubledComm);
assert(
  cleanedComm.includes("прямот"),
  `comm prefix: got "${cleanedComm}"`
);
console.log("PASS: doubled communication prefix → clean");

const broken = stripCrossMemoryDisplayPrefixes(
  "В жизни пользователя значимы люди: настя.."
);
assert(
  isBrokenCrossMemoryFragment(broken) ||
    !isPromotableToCrossMemory("life_context", broken),
  "broken fragment rejected"
);
console.log("PASS: broken fragment rejected");

console.log("\n=== memoryPrefixCleanup.cases.test.ts OK ===\n");
