/**
 * Regression contract for runAtomicModelGate.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/atomicModelGate.cases.test.ts
 */

import { runAtomicModelGate } from "./atomicModelGate.ts";
import type { RateLimitResult } from "./cost.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── 1. Atomic deny daily_limit ────────────────────────────────────────────────

{
  let reserveCalls = 0;
  let providerCalls = 0;
  const result = await runAtomicModelGate({
    reserve: async (): Promise<RateLimitResult> => {
      reserveCalls += 1;
      return { allowed: false, tier: "free", reason: "daily_limit" };
    },
    callModel: async () => {
      providerCalls += 1;
      return "MODEL";
    },
  });
  assert(result.ok === false, "1.deny_daily: ok");
  assert(reserveCalls === 1, "1.deny_daily: reserve once");
  assert(providerCalls === 0, "1.deny_daily: provider zero");
  assert(result.reserve.reason === "daily_limit", "1.deny_daily: reason");
  console.log("✓ atomic deny daily_limit → reserve 1, provider 0");
}

// ── 2. Atomic deny missing_tier ───────────────────────────────────────────────

{
  let reserveCalls = 0;
  let providerCalls = 0;
  const result = await runAtomicModelGate({
    reserve: async (): Promise<RateLimitResult> => {
      reserveCalls += 1;
      return { allowed: false, tier: "free", reason: "missing_tier" };
    },
    callModel: async () => {
      providerCalls += 1;
      return "MODEL";
    },
  });
  assert(result.ok === false, "2.deny_missing: ok");
  assert(reserveCalls === 1, "2.deny_missing: reserve once");
  assert(providerCalls === 0, "2.deny_missing: provider zero");
  assert(result.reserve.reason === "missing_tier", "2.deny_missing: reason");
  assert(result.reserve.allowed === false, "2.deny_missing: allowed");
  console.log("✓ atomic deny missing_tier → reserve 1, provider 0");
}

// ── 3. Atomic allow ───────────────────────────────────────────────────────────

{
  let reserveCalls = 0;
  let providerCalls = 0;
  const result = await runAtomicModelGate({
    reserve: async (): Promise<RateLimitResult> => {
      reserveCalls += 1;
      return { allowed: true, tier: "basic" };
    },
    callModel: async () => {
      providerCalls += 1;
      return "MODEL";
    },
  });
  assert(result.ok === true, "3.allow: ok");
  assert(reserveCalls === 1, "3.allow: reserve once");
  assert(providerCalls === 1, "3.allow: provider once");
  if (result.ok) {
    assert(result.value === "MODEL", "3.allow: value");
    assert(result.reserve.tier === "basic", "3.allow: tier");
  }
  console.log("✓ atomic allow → reserve 1, provider 1, value kept");
}

// ── 4. Order: reserve then provider ───────────────────────────────────────────

{
  const order: string[] = [];
  await runAtomicModelGate({
    reserve: async (): Promise<RateLimitResult> => {
      order.push("reserve");
      return { allowed: true, tier: "free" };
    },
    callModel: async () => {
      order.push("provider");
      return null;
    },
  });
  assert(order.join(",") === "reserve,provider", "4.order");
  console.log("✓ order → reserve,provider");
}

// ── 5. Provider throw: propagate, no rereserve ────────────────────────────────

{
  let reserveCalls = 0;
  let providerCalls = 0;
  let caught: unknown = null;
  try {
    await runAtomicModelGate({
      reserve: async (): Promise<RateLimitResult> => {
        reserveCalls += 1;
        return { allowed: true, tier: "free" };
      },
      callModel: async () => {
        providerCalls += 1;
        throw new Error("provider down");
      },
    });
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof Error && caught.message === "provider down",
    "5.provider_throw: original error",
  );
  assert(reserveCalls === 1, "5.provider_throw: reserve once");
  assert(providerCalls === 1, "5.provider_throw: provider once");
  console.log("✓ provider throw → rethrown, no second reserve/provider");
}

// ── 6. Reserve throw: propagate, provider untouched, no retry ─────────────────

{
  let reserveCalls = 0;
  let providerCalls = 0;
  let caught: unknown = null;
  try {
    await runAtomicModelGate({
      reserve: async (): Promise<RateLimitResult> => {
        reserveCalls += 1;
        throw new Error("reserve exploded");
      },
      callModel: async () => {
        providerCalls += 1;
        return "MODEL";
      },
    });
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof Error && caught.message === "reserve exploded",
    "6.reserve_throw: original error",
  );
  assert(reserveCalls === 1, "6.reserve_throw: reserve once");
  assert(providerCalls === 0, "6.reserve_throw: provider zero");
  console.log("✓ reserve throw → rethrown, provider 0, no retry");
}

console.log("=== atomicModelGate.cases.test.ts OK ===");
