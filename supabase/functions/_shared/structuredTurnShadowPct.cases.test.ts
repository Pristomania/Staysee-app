/**
 * Structured shadow percentage gate — unit cases.
 * Run: npx tsx supabase/functions/_shared/structuredTurnShadowPct.cases.test.ts
 */

import {
  parseStructuredShadowPct,
  shouldAttemptShadowByPct,
} from "./structuredTurnShadowPct.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expectFalse(name: string, value: string | undefined) {
  assert(
    shouldAttemptShadowByPct(value) === false,
    `${name}: expected false for ${JSON.stringify(value)}`
  );
  console.log(`✓ ${name} → false`);
}

expectFalse("undefined", undefined);
expectFalse('""', "");
expectFalse('"   "', "   ");
expectFalse('"abc"', "abc");
expectFalse('"NaN"', "NaN");
expectFalse('"-1"', "-1");
expectFalse('"0"', "0");
expectFalse('"101"', "101");
expectFalse('"100.1"', "100.1");

assert(
  shouldAttemptShadowByPct("100") === true,
  '"100" should always pass'
);
console.log('✓ "100" → true');

assert(
  shouldAttemptShadowByPct("5", () => 0.049) === true,
  '"5" at 0.049 should pass'
);
assert(
  shouldAttemptShadowByPct("5", () => 0.05) === false,
  '"5" at 0.05 should fail'
);
console.log('✓ "5" boundary 0.049 true / 0.05 false');

assert(
  shouldAttemptShadowByPct("50", () => 0.499) === true,
  '"50" at 0.499 should pass'
);
assert(
  shouldAttemptShadowByPct("50", () => 0.5) === false,
  '"50" at 0.5 should fail'
);
console.log('✓ "50" boundary 0.499 true / 0.5 false');

assert(
  shouldAttemptShadowByPct("0.5", () => 0.004) === true,
  '"0.5" at 0.004 should pass'
);
assert(
  shouldAttemptShadowByPct("0.5", () => 0.005) === false,
  '"0.5" at 0.005 should fail'
);
console.log('✓ "0.5" decimal boundary 0.004 true / 0.005 false');

assert(parseStructuredShadowPct(undefined) === null, "parse undefined");
assert(parseStructuredShadowPct("5") === 5, "parse 5");
assert(parseStructuredShadowPct("0.5") === 0.5, "parse 0.5");
console.log("✓ parseStructuredShadowPct");

console.log("\nAll structuredTurnShadowPct cases passed.");
