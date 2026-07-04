/**
 * PR7a protocol events row builder tests.
 * Run: npx tsx supabase/functions/_shared/protocolEvents.cases.test.ts
 */

import { buildProtocolEventRow } from "./protocolEvents.ts";

let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

const row = buildProtocolEventRow({
  userId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  requestId: "req-1",
  eventType: "crisis_hard_stop",
  severity: "tier_3",
  protocol: "regex_crisis_explicit",
  actionTaken: "hard_stop",
  confidence: "high",
  matchedPattern: "want_die",
  promptVersion: "staysee-core-v1",
});

assert(row.event_type === "crisis_hard_stop", "event_type mapped");
assert(row.matched_pattern === "want_die", "matched_pattern mapped");
assert(row.prompt_version === "staysee-core-v1", "prompt_version mapped");
assert(!("user_message" in row), "no user_message field");
assert(!("assistant_message" in row), "no assistant_message field");

console.log(`\n=== ${failed === 0 ? "All passed" : `${failed} failed`} ===`);
if (failed > 0) process.exit(1);
