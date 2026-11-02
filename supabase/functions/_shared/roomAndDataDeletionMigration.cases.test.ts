/**
 * Static contract for migration 092: the memory, the data of an account and the room deletion, repaired for the
 * production schema.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/roomAndDataDeletionMigration.cases.test.ts
 *
 * The behaviour was run against a real Postgres made to look like production (a profiles table without
 * onboarding_completed and primary_concern, no ai_usage_log table): see knowledge/staysee-room-deletion-repair-2026-11-03.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_TABLES } from "../../../scripts/check-test-account-data.mjs";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_092_room_and_data_deletion.sql"));
assert(file !== undefined, "migration 092 must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");
const body = sql.replace(/^--.*$/gm, "");

// 1. Only what production has. The old function failed on a column and a table that production does not have.
assert(!/onboarding_completed|primary_concern/.test(body), "no column that production's profiles table lacks");
assert(!/\bai_usage_log\b/.test(body), "no table (ai_usage_log) that production lacks");

// 2. The tables that are wiped are the ones the checker counts, so the check and the deletion cannot disagree.
const arrayOf = (name: string): string[] => {
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?v_tables text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`, "i");
  const block = pattern.exec(body)?.[1] ?? "";
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
};
const memoryTables = arrayOf("_wipe_memory");
const contentTables = arrayOf("_wipe_account_content");
const wiped = [...memoryTables, ...contentTables];
assert(memoryTables.length >= 15 && contentTables.length >= 5, `both lists are there (${memoryTables.length}, ${contentTables.length})`);
assert(JSON.stringify([...wiped].sort()) === JSON.stringify([...DATA_TABLES].sort()), "the wipe and the checker agree on which tables are a person's content");
const kept = ["user_usage_tiers", "message_packs", "user_consents", "ai_usage_logs", "ai_usage_log", "profiles"];
for (const table of kept) assert(!wiped.includes(table), `${table} is not wiped by the data deletion`);
assert(contentTables[0] === "conversations", "conversations first: what hangs on them goes with them");
assert(
  memoryTables.includes("memory_v3_dialogue_runs") && memoryTables.includes("memory_v3_lifecycle_shadow_runs") && memoryTables.includes("memory_corrections"),
  "the memory wipe reaches the runs behind the memory and the corrections, not only items and heads",
);
assert(/to_regclass\(format\('public\.%I', v_table\)\) IS NOT NULL/.test(body), "a listed table that does not exist is skipped, never blocks a deletion");

// 2b. Every table the migrations create with a user_id is either wiped or kept on purpose: a new table cannot be forgotten.
const known = new Set([...wiped, ...kept]);
const forgotten: string[] = [];
for (const migration of readdirSync(dir)) {
  const text = readFileSync(resolve(dir, migration), "utf8").replace(/^--.*$/gm, "");
  for (const match of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi)) {
    if (/\buser_id\b/.test(match[2]) && !known.has(match[1])) forgotten.push(match[1]);
  }
}
assert(forgotten.length === 0, `tables with a user_id that are neither wiped nor kept: ${forgotten.join(", ")}`);

// 3. Who can call what.
const fn = (name: string) => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`, "i").exec(sql)?.[0] ?? "";
for (const name of ["_wipe_memory", "_wipe_account_content", "delete_my_memory", "delete_my_account_data", "request_room_deletion", "purge_scheduled_rooms"]) {
  const text = fn(name);
  assert(text.length > 0, `${name} is defined`);
  assert(/SECURITY DEFINER/i.test(text) && /SET search_path\s*=\s*''/i.test(text), `${name} is hardened`);
}
assert(
  /REVOKE ALL ON FUNCTION public\._wipe_account_content\(uuid\) FROM authenticated/i.test(sql) && /REVOKE ALL ON FUNCTION public\._wipe_memory\(uuid\) FROM authenticated/i.test(sql),
  "a person cannot call the wipe helpers",
);
assert(/GRANT EXECUTE ON FUNCTION public\.delete_my_memory\(\) TO authenticated/i.test(sql), "a signed-in person can delete their memory");
assert(/GRANT EXECUTE ON FUNCTION public\.delete_my_account_data\(\) TO authenticated/i.test(sql), "a signed-in person can delete their data");
assert(/GRANT EXECUTE ON FUNCTION public\.request_room_deletion\(\) TO authenticated/i.test(sql), "a signed-in person can delete their room");
assert(
  /REVOKE ALL ON FUNCTION public\.purge_scheduled_rooms\(\) FROM authenticated/i.test(sql) && /GRANT EXECUTE ON FUNCTION public\.purge_scheduled_rooms\(\) TO service_role/i.test(sql),
  "only the service runs the purge",
);
for (const name of ["delete_my_memory", "delete_my_account_data", "request_room_deletion"]) {
  assert(fn(name).includes("auth.uid()") && !/p_user_id/.test(fn(name)), `${name} is bound to the caller, nobody can name another person`);
}

// 4. The room deletion: same wipe, then the usage rows, then the profile is marked (and made if it was missing).
const room = fn("request_room_deletion");
assert(room.indexOf("_wipe_account_content") < room.indexOf("DELETE FROM public.user_usage_tiers"), "content first, then the usage row");
assert(/INSERT INTO public\.profiles[\s\S]*ON CONFLICT \(id\) DO UPDATE/i.test(room), "the profile is marked, or made when it is missing");
assert(/interval '14 days'/.test(room), "14 days");
assert(/room_deletion_requested_at IS NOT NULL AND room_purge_after IS NOT NULL/.test(room), "a request without a date is done again");

// 5. The data deletion and the memory deletion keep the plan side and only call the helper.
for (const name of ["delete_my_memory", "delete_my_account_data"]) {
  const text = fn(name);
  assert(!/user_usage_tiers|message_packs|user_consents|ai_usage_logs/.test(text) && !/DELETE FROM/i.test(text), `${name} touches only what the helper wipes`);
}

// 6. The purge is daily, each account on its own, and the migration can be run twice.
assert(/cron\.unschedule\('purge-scheduled-rooms-daily'\)/.test(sql) && /cron\.schedule\(\s*'purge-scheduled-rooms-daily'/.test(sql), "one daily job, replaced when run again");
const purge = fn("purge_scheduled_rooms");
assert(/DELETE FROM auth\.users WHERE id = v_id/.test(purge), "the purge removes the sign-in record, the rest follows it");
assert(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/.test(purge), "one account that cannot be removed does not stop the others");

console.log("=== roomAndDataDeletionMigration.cases.test.ts OK ===");
