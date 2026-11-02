/**
 * Static contract for migration 091: a person can delete their own memory corrections through a function, because the
 * table has no delete right for them. The function can only reach the caller's own rows.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/deleteMemoryCorrectionsMigration.cases.test.ts
 *
 * The behaviour was run against a real Postgres: a direct delete removes nothing, the function removes the caller's
 * rows only, anon is refused.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_091_delete_my_memory_corrections.sql"));
assert(file !== undefined, "migration 091 must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

assert(/CREATE OR REPLACE FUNCTION public\.delete_my_memory_corrections\(\)/i.test(sql), "the function");
assert(/SECURITY DEFINER/i.test(sql) && /SET search_path\s*=\s*''/i.test(sql), "hardened");
assert(/v_uid\s+uuid\s*:=\s*auth\.uid\(\)/i.test(sql), "bound to the caller");
assert(/DELETE FROM public\.memory_corrections WHERE user_id = v_uid/i.test(sql), "only the caller's rows");
assert(!/DELETE FROM public\.memory_corrections\s*;/i.test(sql) && !/p_user_id/i.test(sql), "no way to name another person");
assert(/not_authenticated/.test(sql), "refuses a caller who is not signed in");
assert(/REVOKE ALL ON FUNCTION public\.delete_my_memory_corrections\(\) FROM PUBLIC/i.test(sql) && /REVOKE ALL ON FUNCTION public\.delete_my_memory_corrections\(\) FROM anon/i.test(sql), "closed to everybody else");
assert(/GRANT EXECUTE ON FUNCTION public\.delete_my_memory_corrections\(\) TO authenticated/i.test(sql), "open to a signed-in person");
assert(!/CREATE POLICY[^;]*FOR DELETE/i.test(sql), "no general delete right is given on the table");

console.log("=== deleteMemoryCorrectionsMigration.cases.test.ts OK ===");
