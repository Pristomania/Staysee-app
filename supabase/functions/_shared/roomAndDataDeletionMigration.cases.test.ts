/**
 * Static contract for migration 092: the data of an account and the room deletion, repaired for the production schema.
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

// 1. Only what production has. The old function failed on a column and a table that production does not have.
const body = sql.replace(/^--.*$/gm, "");
assert(!/onboarding_completed|primary_concern/.test(body), "no column that production's profiles table lacks");
assert(!/\bai_usage_log\b/.test(body), "no table (ai_usage_log) that production lacks");

// 2. The list of tables that are wiped is the list the checker counts, so the check and the deletion cannot disagree.
const list = /v_tables text\[\] := ARRAY\[([\s\S]*?)\];/.exec(body)?.[1] ?? "";
const wiped = [...list.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
assert(wiped.length >= 20, `the wipe lists the tables (${wiped.length})`);
assert(JSON.stringify([...wiped].sort()) === JSON.stringify([...DATA_TABLES].sort()), "the wipe and the checker agree on which tables are a person's content");
for (const kept of ["user_usage_tiers", "message_packs", "user_consents", "ai_usage_logs", "profiles"]) {
  assert(!wiped.includes(kept), `${kept} is not wiped by the data deletion`);
}
assert(wiped[0] === "conversations", "conversations first: what hangs on them goes with them");

// 3. Who can call what.
const fn = (name: string) => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`, "i").exec(sql)?.[0] ?? "";
for (const name of ["_wipe_account_content", "delete_my_account_data", "request_room_deletion", "purge_scheduled_rooms"]) {
  const text = fn(name);
  assert(text.length > 0, `${name} is defined`);
  assert(/SECURITY DEFINER/i.test(text) && /SET search_path\s*=\s*''/i.test(text), `${name} is hardened`);
}
assert(/REVOKE ALL ON FUNCTION public\._wipe_account_content\(uuid\) FROM authenticated/i.test(sql), "a person cannot call the wipe helper");
assert(/GRANT EXECUTE ON FUNCTION public\.delete_my_account_data\(\) TO authenticated/i.test(sql), "a signed-in person can delete their data");
assert(/GRANT EXECUTE ON FUNCTION public\.request_room_deletion\(\) TO authenticated/i.test(sql), "a signed-in person can delete their room");
assert(/REVOKE ALL ON FUNCTION public\.purge_scheduled_rooms\(\) FROM authenticated/i.test(sql) && /GRANT EXECUTE ON FUNCTION public\.purge_scheduled_rooms\(\) TO service_role/i.test(sql), "only the service runs the purge");
assert(fn("delete_my_account_data").includes("auth.uid()") && !/p_user_id/.test(fn("delete_my_account_data")), "the data deletion is bound to the caller, nobody can name another person");
assert(fn("request_room_deletion").includes("auth.uid()") && !/p_user_id/.test(fn("request_room_deletion")), "so is the room deletion");

// 4. The room deletion: same wipe, then the usage rows, then the profile is marked (and made if it was missing).
const room = fn("request_room_deletion");
assert(room.indexOf("_wipe_account_content") < room.indexOf("DELETE FROM public.user_usage_tiers"), "content first, then the usage row");
assert(/INSERT INTO public\.profiles[\s\S]*ON CONFLICT \(id\) DO UPDATE/i.test(room), "the profile is marked, or made when it is missing");
assert(/interval '14 days'/.test(room), "14 days");

// 5. The data deletion keeps the plan side.
const data = fn("delete_my_account_data");
assert(!/user_usage_tiers|message_packs|user_consents|ai_usage_logs/.test(data) && !/DELETE FROM/i.test(data), "the data deletion touches only what the helper wipes");

// 6. The purge is daily and the migration can be run twice.
assert(/cron\.unschedule\('purge-scheduled-rooms-daily'\)/.test(sql) && /cron\.schedule\(\s*'purge-scheduled-rooms-daily'/.test(sql), "one daily job, replaced when run again");
assert(/DELETE FROM auth\.users WHERE id = v_id/.test(fn("purge_scheduled_rooms")), "the purge removes the sign-in record, the rest follows it");

console.log("=== roomAndDataDeletionMigration.cases.test.ts OK ===");
