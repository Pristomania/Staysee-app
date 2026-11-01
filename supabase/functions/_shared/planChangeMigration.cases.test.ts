/**
 * Static contract for migration 089: changing a person's plan starts a fresh period.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/planChangeMigration.cases.test.ts
 *
 * Without it a person who moves from free to basic would start with the messages already used on the free plan, and
 * the money they cost would count against the paid ceiling. The behaviour was run against a real Postgres.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_089_set_user_plan.sql"));
assert(file !== undefined, "migration 089_set_user_plan must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

const match = sql.match(/CREATE OR REPLACE FUNCTION public\.set_user_plan\s*\([\s\S]*?\$\$;/i);
assert(match !== null, "set_user_plan block");
const fn = match![0];
assert(/set_user_plan\s*\(\s*p_user_id\s+uuid\s*,\s*p_tier\s+text\s*\)/i.test(fn), "signature");
assert(/SECURITY DEFINER/i.test(fn) && /SET search_path\s*=\s*''/i.test(fn), "hardened");
assert(/p_tier NOT IN \('free', 'basic', 'premium'\)/i.test(fn), "only the three plans");
assert(/MESSAGE\s*=\s*'unknown_plan'/i.test(fn) && /MESSAGE\s*=\s*'missing_tier'/i.test(fn), "refuses an unknown plan and an unknown person");

// A fresh period: the count, the start of the period (which is also where the hidden ceiling starts counting), the day.
for (const assignment of [/tier\s*=\s*p_tier/i, /period_requests_used\s*=\s*0/i, /period_started_at\s*=\s*v_now/i, /daily_requests_used\s*=\s*0/i, /day_reset_at\s*=\s*v_now/i]) {
  assert(assignment.test(fn), `resets ${assignment}`);
}

// What it must leave alone: the owner's marks and the suspension.
for (const column of ["unlimited_usage", "max_conversations_override", "is_suspended", "last_request_at"]) {
  assert(!new RegExp(`${column}\\s*=`, "i").test(fn), `does not touch ${column}`);
}

// The daily guard of each plan is the one the chat uses (cost.ts TIER_CONFIG).
const daily = /CASE p_tier WHEN 'free' THEN (\d+) WHEN 'basic' THEN (\d+) ELSE (\d+) END/i.exec(fn);
assert(daily !== null, "daily guard per plan");
const cost = readFileSync(resolve("supabase/functions/_shared/cost.ts"), "utf8");
const configured = [...cost.matchAll(/dailyRequestLimit:\s*(\d+)/g)].map((m) => Number(m[1]));
assert(configured.join() === [daily![1], daily![2], daily![3]].map(Number).join(), `daily guard ${configured.join()} equals ${[daily![1], daily![2], daily![3]].join()}`);

for (const role of ["PUBLIC", "anon", "authenticated"]) {
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.set_user_plan\\(uuid, text\\) FROM ${role}`, "i").test(sql), `revoke ${role}: a person must not change their own plan`);
}
assert(/GRANT EXECUTE ON FUNCTION public\.set_user_plan\(uuid, text\) TO service_role/i.test(sql), "only the service");

console.log("=== planChangeMigration.cases.test.ts OK ===");
