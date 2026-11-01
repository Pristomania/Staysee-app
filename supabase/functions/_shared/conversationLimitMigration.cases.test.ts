/**
 * Static contract for migration 087: the database refuses a conversation above the plan's number.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/conversationLimitMigration.cases.test.ts
 *
 * Source contract over the migration text and the message the app reads. The behaviour (one, three, six, a deleted
 * conversation frees the place, a lower plan deletes nothing) was run against a real Postgres: see
 * knowledge/staysee-usage-limits-2026-11-01.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_087_plan_features.sql"));
assert(file !== undefined, "migration 087_plan_features must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.enforce_conversation_limit\s*\(\s*\)[\s\S]*?\$\$;/i);
assert(fnMatch !== null, "enforce_conversation_limit block");
const fn = fnMatch![0];
assert(/RETURNS trigger/i.test(fn), "a trigger function");
assert(/SECURITY DEFINER/i.test(fn), "SECURITY DEFINER: counts all rows of the person, whatever the caller may read");
assert(/SET search_path\s*=\s*''/i.test(fn), "empty search_path");
assert(/FOR UPDATE OF u/i.test(fn), "the person's row is locked: two conversations at once cannot both slip under");
assert(/coalesce\s*\(\s*u\.max_conversations_override\s*,\s*l\.max_conversations\s*\)/i.test(fn), "an override wins over the plan's number");
assert(/v_limit\s*:=\s*coalesce\s*\(\s*v_limit\s*,\s*1\s*\)/i.test(fn), "no row or no plan: the strictest number");
assert(/c\.is_active IS TRUE/i.test(fn), "only active conversations take a place");
assert(/NEW\.is_active IS NOT TRUE/i.test(fn), "an inactive row takes no place");
assert(/v_count\s*>=\s*v_limit/i.test(fn), "refuses when the places are taken");
assert(/MESSAGE\s*=\s*'conversation_limit_reached'/i.test(fn), "the agreed message");

assert(/REVOKE ALL ON FUNCTION public\.enforce_conversation_limit\(\) FROM PUBLIC, anon, authenticated/i.test(sql), "closed to people");
assert(/CREATE TRIGGER enforce_conversation_limit\s+BEFORE INSERT ON public\.conversations/i.test(sql), "fires before an insert");
assert(!/DELETE FROM public\.conversations/i.test(sql), "the migration deletes no conversation");
assert(!/UPDATE public\.conversations/i.test(sql), "and changes none");

// The app tells the person by this very message (src/components/screens/MainScreen.tsx).
const main = readFileSync(resolve("src/components/screens/MainScreen.tsx"), "utf8");
assert(main.includes("conversation_limit_reached"), "the app reads the message the database raises");

console.log("=== conversationLimitMigration.cases.test.ts OK ===");
