/**
 * Static contract for migration 085: message limits per plan and the hidden spending ceiling.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/usageLimitsMigration.cases.test.ts
 *
 * Source contract over the migration text. The behaviour itself (the numbers, the resets) was run against a real
 * Postgres: see knowledge/staysee-usage-limits-2026-11-01.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_085_usage_limits.sql"));
assert(file !== undefined, "migration 085_usage_limits must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

// ── The limits live in a table, so a number can change without a deploy ─────────────────────────────

assert(/CREATE TABLE IF NOT EXISTS public\.usage_tier_limits/i.test(sql), "usage_tier_limits table");
assert(/period_kind\s+text\s+NOT NULL\s+CHECK\s*\(\s*period_kind\s+IN\s*\(\s*'lifetime'\s*,\s*'month'\s*\)\s*\)/i.test(sql), "period_kind lifetime|month");
assert(/period_request_limit\s+int\b/i.test(sql), "period_request_limit column");
assert(/cost_cap_usd\s+numeric/i.test(sql), "cost_cap_usd column");
assert(/ALTER TABLE public\.usage_tier_limits ENABLE ROW LEVEL SECURITY/i.test(sql), "limits table has RLS on");
assert(!/CREATE POLICY[^;]*usage_tier_limits/i.test(sql), "no policy: people must not read the ceiling");
assert(/REVOKE ALL ON public\.usage_tier_limits FROM anon, authenticated/i.test(sql), "limits table closed to people");

// The agreed numbers: free is 50 messages in total, the lowest paid plan is 400 a month with a 900 RUB (10 USD) ceiling.
assert(/\(\s*'free'\s*,\s*'lifetime'\s*,\s*50\s*,/i.test(sql), "free: 50 messages in total");
assert(/\(\s*'basic'\s*,\s*'month'\s*,\s*400\s*,\s*10(\.0+)?\s*\)/i.test(sql), "basic: 400 a month, ceiling 10 USD");
assert(/ON CONFLICT\s*\(tier\)\s*DO NOTHING/i.test(sql), "seed rows never overwrite numbers changed later");

// ── Per-person counters ───────────────────────────────────────────────────────────────────────────────

assert(/ADD COLUMN IF NOT EXISTS period_requests_used\s+int\s+NOT NULL DEFAULT 0/i.test(sql), "period_requests_used");
assert(/ADD COLUMN IF NOT EXISTS period_started_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i.test(sql), "period_started_at");

// ── reserve_ai_request is replaced with the same signature and the same hardening ───────────────────────

const reserveMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.reserve_ai_request\s*\([\s\S]*?\$\$;/i);
assert(reserveMatch !== null, "reserve_ai_request block");
const reserve = reserveMatch![0];
assert(/reserve_ai_request\s*\(\s*p_user_id\s+uuid\s*\)/i.test(reserve), "same signature");
assert(/SECURITY DEFINER/i.test(reserve), "SECURITY DEFINER");
assert(/SET search_path\s*=\s*''/i.test(reserve), "empty search_path");
assert(/FOR UPDATE/i.test(reserve), "row is locked");
assert(/FROM public\.usage_tier_limits/i.test(reserve), "limits read schema-qualified");
assert(/FROM public\.ai_usage_logs/i.test(reserve), "money spent is summed from the usage log, schema-qualified");
assert(/v_period_start\s*:=\s*v_row\.period_started_at/i.test(reserve), "the period start comes from the person's row");
assert(/created_at\s*>=\s*v_period_start/i.test(reserve), "money is counted from the start of the period");
assert(/'period_limit'/.test(reserve), "visible message limit reason");
assert(/'cost_cap'/.test(reserve), "hidden ceiling reason");
for (const reason of ["missing_tier", "suspended", "daily_limit"]) {
  assert(reserve.includes(`'${reason}'`), `old reason ${reason} is kept`);
}
assert(/interval\s+'24 hours'/i.test(reserve), "daily window kept");
assert(/interval\s+'30 days'/i.test(reserve), "the month rolls forward after 30 days");
assert(/period_requests_used\s*=\s*/i.test(reserve), "the period counter is moved in the same statement");
// A lifetime plan never rolls forward.
assert(/period_kind\s*=\s*'month'/i.test(reserve), "only month plans roll forward");

// The order matters: the person is told the visible limit first; the ceiling is the quiet second line.
const iPeriod = reserve.indexOf("'period_limit'");
const iCap = reserve.indexOf("'cost_cap'");
const iDaily = reserve.indexOf("'daily_limit'");
assert(iPeriod > 0 && iPeriod < iCap, "message limit is checked before the ceiling");
assert(iCap < iDaily, "ceiling is checked before the daily guard");

// ── Grants ───────────────────────────────────────────────────────────────────────────────────────────

for (const role of ["PUBLIC", "anon", "authenticated"]) {
  assert(
    new RegExp(`REVOKE ALL ON FUNCTION public\\.reserve_ai_request\\(uuid\\) FROM ${role}`, "i").test(sql),
    `revoke ${role}`,
  );
}
assert(/GRANT EXECUTE ON FUNCTION public\.reserve_ai_request\(uuid\) TO service_role/i.test(sql), "grant service_role");

console.log("=== usageLimitsMigration.cases.test.ts OK ===");
