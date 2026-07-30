/**
 * Regression contract for mapQuotaDenyResponse.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/quotaDenyResponse.cases.test.ts
 */

import { mapQuotaDenyResponse } from "./quotaDenyResponse.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertExactBody(
  body: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
): void {
  const keys = Object.keys(body).sort();
  const expectedKeys = Object.keys(expected).sort();
  assert(
    keys.length === expectedKeys.length &&
      keys.every((k, i) => k === expectedKeys[i]),
    `${label}: body keys ${JSON.stringify(keys)} !== ${JSON.stringify(expectedKeys)}`,
  );
  for (const key of expectedKeys) {
    assert(
      body[key] === expected[key],
      `${label}: body.${key} expected ${String(expected[key])}, got ${String(body[key])}`,
    );
  }
}

const calm = { suspended: "S", rateLimit: "R" };

{
  const r = mapQuotaDenyResponse("suspended", calm);
  assert(r.status === 429, "1.suspended: status");
  assertExactBody(r.body, { content: "S" }, "1.suspended");
  console.log("✓ suspended → 429 { content: S }");
}

{
  const r = mapQuotaDenyResponse("daily_limit", calm);
  assert(r.status === 429, "2.daily_limit: status");
  assertExactBody(r.body, { content: "R" }, "2.daily_limit");
  console.log("✓ daily_limit → 429 { content: R }");
}

{
  const r = mapQuotaDenyResponse("missing_tier", calm);
  assert(r.status === 503, "3.missing_tier: status");
  assertExactBody(r.body, { error: "service_unavailable" }, "3.missing_tier");
  console.log("✓ missing_tier → 503 { error: service_unavailable }");
}

{
  const r = mapQuotaDenyResponse("limit_check_error", calm);
  assert(r.status === 503, "4.limit_check_error: status");
  assertExactBody(
    r.body,
    { error: "service_unavailable" },
    "4.limit_check_error",
  );
  console.log("✓ limit_check_error → 503 { error: service_unavailable }");
}

{
  const r = mapQuotaDenyResponse("weekly_limit", calm);
  assert(r.status === 503, "5.unknown: status");
  assertExactBody(r.body, { error: "service_unavailable" }, "5.unknown");
  console.log("✓ unknown reason → 503 { error: service_unavailable }");
}

{
  const r = mapQuotaDenyResponse(undefined, calm);
  assert(r.status === 503, "6.undefined: status");
  assertExactBody(r.body, { error: "service_unavailable" }, "6.undefined");
  console.log("✓ undefined → 503 { error: service_unavailable }");
}

console.log("=== quotaDenyResponse.cases.test.ts OK ===");
