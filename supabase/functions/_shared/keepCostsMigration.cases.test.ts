/**
 * Static contract for migration 099: the cost of a call is never lost.
 * Run: node --test supabase/functions/_shared/keepCostsMigration.cases.test.ts
 *
 * The behaviour is checked on a real database in tests/db/usageCostsKept.dbtest.ts; this keeps the rule from being undone by a later
 * migration, which a test on one database would not notice until money had already been lost again.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const names = readdirSync(dir).sort();
const file = names.find((name) => name.endsWith("_099_keep_costs_of_deleted_accounts.sql"));
assert(file !== undefined, "migration 099 must exist");
const strip = (text: string): string => text.replace(/^--.*$/gm, "");
const sql = strip(readFileSync(resolve(dir, file!), "utf8"));

// 1. The table lets a row have no person, and an account that goes no longer takes its cost rows with it.
assert(/ALTER COLUMN user_id DROP NOT NULL/i.test(sql), "a cost row may have no person");
assert(/FOREIGN KEY \(user_id\) REFERENCES auth\.users\(id\) ON DELETE SET NULL/i.test(sql), "the foreign key lets go of the row, it does not delete it");
assert(!/ON DELETE CASCADE/i.test(sql), "nothing here deletes cost rows with an account");
assert(/account_deleted_at\s+timestamptz/i.test(sql) && /account_label_key\s+text/i.test(sql), "the deleted mark and the label the account had");

// 2. What cutting a row loose does: keeps the money, removes everything that points at the person or quotes them.
const keep = /CREATE OR REPLACE FUNCTION public\._keep_usage_costs\(p_user_id uuid\)[\s\S]*?\$\$;/i.exec(sql)?.[0] ?? "";
assert(keep.length > 0, "_keep_usage_costs is defined");
assert(/SECURITY DEFINER/i.test(keep) && /SET search_path\s*=\s*''/i.test(keep), "_keep_usage_costs is hardened");
assert(!/DELETE\s+FROM/i.test(keep), "cutting loose never deletes");
for (const column of ["user_id", "conversation_id", "request_id", "error_message"]) {
  assert(new RegExp(`${column}\\s*=\\s*NULL`, "i").test(keep), `${column} is cleared`);
}
assert(/account_deleted_at\s*=\s*now\(\)/i.test(keep) && /account_label_key\s*=/i.test(keep), "the row is marked deleted and keeps the label's word");
assert(!/\bcost\s*=|model\s*=|created_at\s*=|call_kind\s*=|cost_category\s*=/i.test(keep), "the money, the model, the time and the kind are left alone");

// 3. It happens whichever way an account goes.
assert(
  /CREATE TRIGGER trg_keep_usage_costs_on_account_delete\s+BEFORE DELETE ON auth\.users\s+FOR EACH ROW EXECUTE FUNCTION public\._keep_usage_costs_on_account_delete\(\)/i.test(sql),
  "a trigger runs before any account is deleted",
);
for (const fn of ["_keep_usage_costs(uuid)", "_keep_usage_costs_on_account_delete()"]) {
  const escaped = fn.replace(/[()]/g, "\\$&");
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC, anon, authenticated`, "i").test(sql), `${fn} is closed to people and the public key`);
}

// 4. The room deletion keeps the cost: the LATEST definition of request_room_deletion must not delete usage rows.
let latest = "";
for (const name of names) {
  const text = strip(readFileSync(resolve(dir, name), "utf8"));
  const match = /CREATE OR REPLACE FUNCTION public\.request_room_deletion\(\)[\s\S]*?\n\$\$;/i.exec(text);
  if (match) latest = match[0];
}
assert(latest.length > 0, "request_room_deletion is defined");
assert(!/DELETE FROM public\.ai_usage_logs/i.test(latest), "the room deletion does not delete cost rows");
assert(/PERFORM public\._keep_usage_costs\(v_uid\)/i.test(latest), "the room deletion cuts the cost loose instead");
assert(latest.indexOf("_wipe_account_content") >= 0 && /DELETE FROM public\.user_usage_tiers/i.test(latest), "the rest of the room deletion is as before");

// 5. Nothing from 099 on deletes cost rows.
for (const name of names.filter((n) => n >= file!)) {
  const text = strip(readFileSync(resolve(dir, name), "utf8"));
  assert(!/DELETE FROM public\.ai_usage_logs/i.test(text), `${name} must not delete cost rows`);
}

console.log("=== keepCostsMigration.cases.test.ts OK ===");
