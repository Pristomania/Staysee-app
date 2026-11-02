/**
 * Static contract for migration 086: the free messages come back 3 months after the person's last message.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/freeTariffRenewalMigration.cases.test.ts
 *
 * Source contract over the migration text and the texts the person reads. The behaviour itself (the dates, the
 * resets, a refused message not moving the clock) was run against a real Postgres: see
 * knowledge/staysee-usage-limits-2026-11-01.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_086_free_tariff_renewal.sql"));
assert(file !== undefined, "migration 086_free_tariff_renewal must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

// ── Where the number lives and what is remembered per person ────────────────────────────────────────

assert(/ALTER TABLE public\.usage_tier_limits[\s\S]*?ADD COLUMN IF NOT EXISTS renew_after_idle_months\s+int\b/i.test(sql), "renewal months column");
assert(/CHECK\s*\(\s*renew_after_idle_months\s*>\s*0\s*\)/i.test(sql), "a renewal period must be positive");
assert(/ALTER TABLE public\.user_usage_tiers[\s\S]*?ADD COLUMN IF NOT EXISTS last_request_at\s+timestamptz/i.test(sql), "last answered message time");
assert(/UPDATE public\.usage_tier_limits\s+SET renew_after_idle_months\s*=\s*3\s+WHERE tier\s*=\s*'free'/i.test(sql), "free renews after 3 months");
assert(!/'basic'/.test(sql.replace(/--.*$/gm, "")), "a paid plan is not changed here: it renews by its own 30-day period");

// ── reserve_ai_request: same signature and hardening, one new rule ─────────────────────────────────

const reserveMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.reserve_ai_request\s*\([\s\S]*?\$\$;/i);
assert(reserveMatch !== null, "reserve_ai_request block");
const reserve = reserveMatch![0];
assert(/reserve_ai_request\s*\(\s*p_user_id\s+uuid\s*\)/i.test(reserve), "same signature");
assert(/SECURITY DEFINER/i.test(reserve), "SECURITY DEFINER");
assert(/SET search_path\s*=\s*''/i.test(reserve), "empty search_path");
assert(/FOR UPDATE/i.test(reserve), "row is locked");
for (const reason of ["missing_tier", "suspended", "period_limit", "cost_cap", "daily_limit"]) {
  assert(reserve.includes(`'${reason}'`), `reason ${reason} is kept`);
}
// The clock starts at the last ANSWERED message; a person with no answered message yet counts from the period start.
assert(/coalesce\s*\(\s*v_row\.last_request_at\s*,\s*v_row\.period_started_at\s*\)/i.test(reserve), "reference time");
assert(/make_interval\s*\(\s*months\s*=>\s*v_limits\.renew_after_idle_months\s*\)/i.test(reserve), "calendar months, not 90 days");
assert(/v_period_used\s*:=\s*0/i.test(reserve) && /v_period_start\s*:=\s*v_now/i.test(reserve), "renewal restarts the count and the money");
// Only an allowed message moves the clock: a refused attempt returns before the UPDATE.
const iUpdate = reserve.search(/UPDATE public\.user_usage_tiers/i);
assert(iUpdate > 0, "the update exists");
assert(/last_request_at\s*=\s*v_now/i.test(reserve.slice(iUpdate)), "the clock is moved in the same UPDATE as the counter");
assert(!/last_request_at\s*=\s*v_now/i.test(reserve.slice(0, iUpdate)), "no earlier write: a refused message must not restart the wait");
assert(/period_kind\s*=\s*'month'/i.test(reserve), "month plans keep their rule");
assert(/interval\s+'30 days'/i.test(reserve), "month plans keep their 30 days");

for (const role of ["PUBLIC", "anon", "authenticated"]) {
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.reserve_ai_request\\(uuid\\) FROM ${role}`, "i").test(sql), `revoke ${role}`);
}
assert(/GRANT EXECUTE ON FUNCTION public\.reserve_ai_request\(uuid\) TO service_role/i.test(sql), "grant service_role");

// ── What the person reads says the same as the database does ───────────────────────────────────────

const cost = readFileSync(resolve("supabase/functions/_shared/cost.ts"), "utf8");
// The text of the free refusal is built from the plans table and checked against it in plans.cases.test.ts.
assert(/freeUsedUp:\s*`[^`]*monthsPhrase\(PLANS\.free\.renewAfterIdleMonths/.test(cost), "the free refusal takes the months from the plans table");

console.log("=== freeTariffRenewalMigration.cases.test.ts OK ===");
