/**
 * PR7a protocol signal parser tests.
 * Run: npx tsx supabase/functions/_shared/protocolSignalParser.cases.test.ts
 */

import {
  parseAndStripProtocolSignals,
  parseProtocolSignals,
  stripProtocolSignals,
} from "./protocolSignalParser.ts";

let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

const visible = "Слышу тебя. Это важно.";

const FORBIDDEN_LEAK_RE =
  /STAYSEE_SIGNAL|\[STAYSEE|crisis_detected|role_attack_detected|boundary_pressure_detected/i;

function assertNoLeak(text: string, msg: string) {
  assert(!FORBIDDEN_LEAK_RE.test(text), msg);
}

console.log("=== protocolSignalParser ===\n");

{
  const text = `${visible}\n[STAYSEE_SIGNAL: crisis_detected]`;
  const parsed = parseProtocolSignals(text);
  assert(parsed.signals.length === 1 && parsed.signals[0] === "crisis_detected", "single tag parsed");
  const stripped = stripProtocolSignals(text);
  assert(stripped === visible, "single tag stripped");
  assert(!/STAYSEE_SIGNAL/i.test(stripped), "no STAYSEE_SIGNAL in output");
}

{
  const text = `${visible}\n[STAYSEE_SIGNAL: crisis_detected]\n[STAYSEE_SIGNAL: boundary_pressure_detected]`;
  const parsed = parseProtocolSignals(text);
  assert(parsed.signals.length === 2, "multiple tags parsed");
  assert(parsed.signals[0] === "crisis_detected", "order preserved first");
}

{
  const text = `${visible}\n[STAYSEE_SIGNAL: crisis_detected]\n[STAYSEE_SIGNAL: crisis_detected]`;
  const parsed = parseProtocolSignals(text);
  assert(parsed.signals.length === 1, "duplicate tags deduped");
}

{
  const text = `${visible}\n[STAYSEE_SIGNAL: unknown_thing]`;
  const out = parseAndStripProtocolSignals(text);
  assert(!/STAYSEE/i.test(out.text), "unknown tag sanitized from client text");
}

{
  const text = `${visible}\n[STAYSEE partial broken`;
  const out = parseAndStripProtocolSignals(text);
  assert(!/\[STAYSEE/i.test(out.text), "partial STAYSEE fragment removed");
}

{
  const out = parseAndStripProtocolSignals("");
  assert(out.text === "", "empty-after-strip handled");
  assert(out.signals.length === 0, "empty has no signals");
}

console.log("\n=== bare signal line leaks ===\n");

for (const signal of [
  "crisis_detected",
  "role_attack_detected",
  "boundary_pressure_detected",
] as const) {
  const text = `${visible}\n${signal}`;
  const out = parseAndStripProtocolSignals(text);
  assert(out.text === visible, `bare ${signal} line stripped`);
  assert(out.leakageSanitized === true, `bare ${signal} sets leakageSanitized`);
  assertNoLeak(out.text, `no ${signal} in client text`);
}

{
  const out = parseAndStripProtocolSignals(
    "В коде мы обсуждали crisis_detected как внутренний флаг."
  );
  assert(
    /crisis_detected/.test(out.text),
    "inline prose with signal substring preserved"
  );
  assert(out.leakageSanitized === false, "inline prose does not set leakageSanitized");
}

console.log(`\n=== ${failed === 0 ? "All passed" : `${failed} failed`} ===`);
if (failed > 0) process.exit(1);
