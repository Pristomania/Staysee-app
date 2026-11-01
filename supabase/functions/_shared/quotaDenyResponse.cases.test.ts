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

const calm = { suspended: "S", rateLimit: "R", freeUsedUp: "F", monthUsedUp: "M" };

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

// The message limit and the hidden spending ceiling look exactly the same to the person: one text per plan.
for (const reason of ["period_limit", "cost_cap"]) {
  {
    const r = mapQuotaDenyResponse(reason, calm, "free");
    assert(r.status === 429, `7.${reason}.free: status`);
    assertExactBody(r.body, { content: "F" }, `7.${reason}.free`);
  }
  for (const tier of ["basic", "premium"]) {
    const r = mapQuotaDenyResponse(reason, calm, tier);
    assert(r.status === 429, `7.${reason}.${tier}: status`);
    assertExactBody(r.body, { content: "M" }, `7.${reason}.${tier}`);
  }
  {
    // no tier known: still a calm text, never a technical error
    const r = mapQuotaDenyResponse(reason, calm);
    assert(r.status === 429, `7.${reason}.no_tier: status`);
    assertExactBody(r.body, { content: "M" }, `7.${reason}.no_tier`);
  }
  console.log(`✓ ${reason} → 429, free text for free, month text for paid`);
}

console.log("=== quotaDenyResponse.cases.test.ts OK ===");
