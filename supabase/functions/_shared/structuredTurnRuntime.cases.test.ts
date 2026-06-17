/**
 * Structured turn runtime audit — unit cases.
 * Run: npx tsx supabase/functions/_shared/structuredTurnRuntime.cases.test.ts
 */

import { resolveStructuredTurnRuntime } from "./structuredTurnRuntime.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const off = resolveStructuredTurnRuntime("off");
assert(off.usePlainPipeline === true, "off uses plain pipeline");
assert(off.audit.structured_turn_mode === "off", "off mode");
assert(off.audit.structured_turn_enabled === false, "off not enabled");
assert(off.audit.structured_parse_ok === null, "off parse_ok null");
assert(off.audit.structured_fallback_reason === null, "off no fallback");
console.log("✓ off → plain pipeline, audit disabled");

const shadow = resolveStructuredTurnRuntime("shadow");
assert(shadow.usePlainPipeline === true, "shadow still plain pipeline in PR3b-2");
assert(shadow.audit.structured_turn_enabled === true, "shadow enabled");
assert(shadow.audit.structured_parse_ok === false, "shadow parse not ok");
assert(
  shadow.audit.structured_fallback_reason === "structured_call_not_wired",
  "shadow not wired"
);
console.log("✓ shadow → plain pipeline, not wired audit");

const response = resolveStructuredTurnRuntime("response");
assert(response.usePlainPipeline === true, "response still plain pipeline");
assert(response.audit.structured_turn_mode === "response", "response mode");
console.log("✓ response → plain pipeline, not wired audit");

console.log("\nAll structuredTurnRuntime cases passed.");
