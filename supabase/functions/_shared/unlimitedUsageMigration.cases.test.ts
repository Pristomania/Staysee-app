/**
 * Static contract for migration 088: a person marked as unlimited has no message limit, no hidden ceiling and no daily
 * guard, and the plan still decides the features.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/unlimitedUsageMigration.cases.test.ts
 *
 * The behaviour was run against a real Postgres: see knowledge/staysee-usage-limits-2026-11-01.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_088_unlimited_usage.sql"));
assert(file !== undefined, "migration 088_unlimited_usage must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

assert(/ALTER TABLE public\.user_usage_tiers\s+ADD COLUMN IF NOT EXISTS unlimited_usage\s+boolean\s+NOT NULL DEFAULT false/i.test(sql), "the flag, off for everybody by default");
assert(!/UPDATE public\.user_usage_tiers/i.test(sql.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/i, "")), "the migration marks nobody: it is done by hand, for named accounts");

const match = sql.match(/CREATE OR REPLACE FUNCTION public\.reserve_ai_request\s*\([\s\S]*?\$\$;/i);
assert(match !== null, "reserve_ai_request block");
const fn = match![0];
assert(/reserve_ai_request\s*\(\s*p_user_id\s+uuid\s*\)/i.test(fn), "same signature");
assert(/SECURITY DEFINER/i.test(fn) && /SET search_path\s*=\s*''/i.test(fn) && /FOR UPDATE/i.test(fn), "same hardening");
for (const reason of ["missing_tier", "suspended", "period_limit", "cost_cap", "daily_limit"]) {
  assert(fn.includes(`'${reason}'`), `reason ${reason} is kept`);
}
// Order: a suspended person is refused first, then an unlimited one is let through, only then the limits.
const iSuspended = fn.indexOf("'suspended'");
const iUnlimited = fn.search(/IF v_row\.unlimited_usage THEN/i);
const iPeriod = fn.indexOf("'period_limit'");
const iCap = fn.indexOf("'cost_cap'");
const iDaily = fn.indexOf("'daily_limit'");
assert(iUnlimited > iSuspended, "suspension still stops everybody");
assert(iUnlimited > 0 && iUnlimited < iPeriod && iUnlimited < iCap && iUnlimited < iDaily, "an unlimited person is let through before any limit");
assert(/last_request_at\s*=\s*v_now/i.test(fn), "the counters and the clock still run for them");
assert(/interval\s+'24 hours'/i.test(fn) && /interval\s+'30 days'/i.test(fn) && /make_interval/i.test(fn), "the rules for everybody else are kept");

for (const role of ["PUBLIC", "anon", "authenticated"]) {
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.reserve_ai_request\\(uuid\\) FROM ${role}`, "i").test(sql), `revoke ${role}`);
}
assert(/GRANT EXECUTE ON FUNCTION public\.reserve_ai_request\(uuid\) TO service_role/i.test(sql), "grant service_role");

console.log("=== unlimitedUsageMigration.cases.test.ts OK ===");
