/**
 * Run: npx tsx supabase/functions/_shared/openLoopNormalize.cases.test.ts
 */

import { normalizeOpenLoopItem } from "./openLoopNormalize.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("=== open loop normalization ===\n");

const scene = normalizeOpenLoopItem("Поможешь идти путь к сцене и признанию?");
assert(scene !== null && scene !== "Поможешь идти путь к сцене и признанию?", "scene normalized");
assert(!scene!.includes("?"), "scene no question mark");
console.log(`PASS: scene → "${scene}"`);

const how = normalizeOpenLoopItem("А как ты поняла, что я буду говорить о тебе?)");
assert(how === null, "meta question rejected");
console.log("PASS: meta question → rejected");

const critic = normalizeOpenLoopItem("может что то можно сделать с внутренним критиком?");
assert(
  critic !== null && /внутренн.*критик/i.test(critic),
  "critic normalized"
);
console.log(`PASS: critic → "${critic}"`);

console.log("\n=== openLoopNormalize.cases.test.ts OK ===\n");
