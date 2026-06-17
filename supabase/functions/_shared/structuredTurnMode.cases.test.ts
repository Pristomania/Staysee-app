/**
 * Structured turn mode — unit cases.
 * Run: npx tsx supabase/functions/_shared/structuredTurnMode.cases.test.ts
 */

import {
  getStructuredTurnMode,
  parseStructuredTurnMode,
} from "./structuredTurnMode.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(parseStructuredTurnMode(undefined) === "off", "missing env → off");
assert(getStructuredTurnMode(() => undefined) === "off", "getter missing → off");

assert(parseStructuredTurnMode("") === "off", "empty string → off");
assert(getStructuredTurnMode(() => "") === "off", "getter empty → off");

assert(parseStructuredTurnMode("   ") === "off", "whitespace → off");

assert(parseStructuredTurnMode("invalid") === "off", "invalid value → off");
assert(parseStructuredTurnMode("on") === "off", "on → off");
assert(parseStructuredTurnMode("SHADOW") === "off", "case mismatch → off");
assert(getStructuredTurnMode(() => "bogus") === "off", "getter invalid → off");

assert(parseStructuredTurnMode("shadow") === "shadow", "shadow → shadow");
assert(getStructuredTurnMode(() => "shadow") === "shadow", "getter shadow → shadow");

assert(parseStructuredTurnMode("response") === "response", "response → response");
assert(getStructuredTurnMode(() => "response") === "response", "getter response → response");

console.log("✓ env missing → off");
console.log("✓ invalid value → off");
console.log("✓ empty string → off");
console.log("✓ shadow → shadow");
console.log("✓ response → response");
console.log("\nAll structuredTurnMode cases passed.");
