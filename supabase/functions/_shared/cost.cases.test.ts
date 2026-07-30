/**
 * Fail-closed rate-limit regression contract for checkRateLimit (variant A).
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/cost.cases.test.ts
 */

import { register } from "node:module";

// cost.ts (and its transitive Edge imports) use Deno-style `npm:` specifiers.
// Remap them to bare package names so local tsx can load checkRateLimit without
// changing production code or package.json.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string" && specifier.startsWith("npm:")) {
    const rest = specifier.slice(4);
    const bare = rest.startsWith("@")
      ? "@" + rest.slice(1).split("@")[0]
      : rest.split("@")[0];
    return nextResolve(bare, context);
  }
  return nextResolve(specifier, context);
}
`)}`,
);

// Transitive Edge modules read Deno.env at import time; stub only for local tsx.
const g = globalThis as typeof globalThis & {
  Deno?: { env: { get: (key: string) => string | undefined } };
};
if (!g.Deno) {
  g.Deno = {
    env: {
      get() {
        return undefined;
      },
    },
  };
}

const { checkRateLimit } = await import("./cost.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type FakeRow = {
  tier: string;
  daily_request_limit: number;
  daily_requests_used: number;
  month_reset_at: string;
  day_reset_at: string;
  is_suspended: boolean;
};

type FakeResult = {
  data: FakeRow | null;
  error: { message: string } | null;
};

/** Minimal chain: from → select → eq → maybeSingle */
function makeFakeClient(result: FakeResult) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return result;
                },
              };
            },
          };
        },
      };
    },
  };
}

const USER_ID = "00000000-0000-4000-8000-000000000001";
const recentDayReset = new Date().toISOString();

// ── 1. SELECT error → fail-closed ─────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: null,
      error: { message: "forced select failure" },
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "1.error: allowed must be false");
  assert(
    result.reason === "limit_check_error",
    `1.error: reason expected limit_check_error, got ${String(result.reason)}`,
  );
  console.log("✓ SELECT error → allowed:false, reason:limit_check_error");
}

// ── 2. Missing row → fail-closed ──────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: null,
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "2.missing: allowed must be false");
  assert(
    result.reason === "missing_tier",
    `2.missing: reason expected missing_tier, got ${String(result.reason)}`,
  );
  console.log("✓ missing tier row → allowed:false, reason:missing_tier");
}

// ── 3. Suspended ──────────────────────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: {
        tier: "free",
        daily_request_limit: 50,
        daily_requests_used: 0,
        month_reset_at: recentDayReset,
        day_reset_at: recentDayReset,
        is_suspended: true,
      },
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "3.suspended: allowed must be false");
  assert(
    result.reason === "suspended",
    `3.suspended: reason expected suspended, got ${String(result.reason)}`,
  );
  console.log("✓ suspended → allowed:false, reason:suspended");
}

// ── 4. Daily limit exhausted ──────────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: {
        tier: "free",
        daily_request_limit: 50,
        daily_requests_used: 50,
        month_reset_at: recentDayReset,
        day_reset_at: recentDayReset,
        is_suspended: false,
      },
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "4.daily_limit: allowed must be false");
  assert(
    result.reason === "daily_limit",
    `4.daily_limit: reason expected daily_limit, got ${String(result.reason)}`,
  );
  console.log("✓ daily limit exhausted → allowed:false, reason:daily_limit");
}

// ── 5. Within limit ───────────────────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: {
        tier: "basic",
        daily_request_limit: 200,
        daily_requests_used: 3,
        month_reset_at: recentDayReset,
        day_reset_at: recentDayReset,
        is_suspended: false,
      },
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === true, "5.ok: allowed must be true");
  assert(result.tier === "basic", `5.ok: tier expected basic, got ${result.tier}`);
  console.log("✓ within limit → allowed:true, tier:basic");
}

console.log("=== cost.cases.test.ts OK ===");
