import { test } from "node:test";
import assert from "node:assert/strict";
import { effectivePaidTier } from "./paidAccess.ts";
const now = Date.parse("2026-11-20T12:00:00Z");
test("legacy manual assignments and unlimited are not converted into expired purchases", () => {
  assert.equal(effectivePaidTier({ tier: "premium" }, now), "premium");
  assert.equal(
    effectivePaidTier({ tier: "basic", access_source: "manual" }, now),
    "basic",
  );
  assert.equal(
    effectivePaidTier({
      tier: "premium",
      access_source: "purchase",
      paid_access_until: "2026-01-01T00:00:00Z",
      unlimited_usage: true,
    }, now),
    "premium",
  );
});
test("active purchased features do not depend on remaining messages", () => {
  assert.equal(
    effectivePaidTier({
      tier: "basic",
      access_source: "purchase",
      paid_access_until: "2026-12-20T12:00:00Z",
      period_requests_used: 400,
    }, now),
    "basic",
  );
});
test("purchased features close at exact expiry and fail closed on missing deadline", () => {
  for (
    const paid_access_until of [
      undefined,
      null,
      "invalid",
      "2026-11-20T12:00:00Z",
      "2026-11-19T12:00:00Z",
    ]
  ) {
    assert.equal(
      effectivePaidTier({
        tier: "premium",
        access_source: "purchase",
        paid_access_until,
      }, now),
      "free",
    );
  }
  assert.equal(effectivePaidTier({ tier: "unknown" }, now), "free");
});
