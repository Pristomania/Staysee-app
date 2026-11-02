/**
 * Static contract for migration 090: bought messages. A pack is added by the service only, spent after the plan's own
 * messages (the one that ends first goes first), raises the quiet ceiling by its allowance, and is never visible as money.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/messagePacksMigration.cases.test.ts
 *
 * The behaviour was run against a real Postgres: see knowledge/staysee-message-packs-2026-11-02.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const dir = resolve("supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_090_message_packs.sql"));
assert(file !== undefined, "migration 090_message_packs must exist");
const sql = readFileSync(resolve(dir, file!), "utf8");

// The table: tied to the person, deleted with them, one payment never twice, can never be over-spent.
assert(/CREATE TABLE IF NOT EXISTS public\.message_packs/i.test(sql), "the table");
assert(/user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/i.test(sql), "removed with the person");
assert(/payment_ref\s+text\s+NOT NULL UNIQUE/i.test(sql), "the same payment is never granted twice, and a reference is always there");
assert(sql.includes("payment_ref_required") && sql.includes("payment_ref_taken"), "no grant without a reference, none on somebody else's reference");
assert(/messages_left\s+int\s+NOT NULL CHECK \(messages_left >= 0 AND messages_left <= messages_total\)/i.test(sql), "never negative, never above what was bought");

// A person only reads: row security on, a read policy for the owner, no write rights, no write policy.
assert(/ALTER TABLE public\.message_packs ENABLE ROW LEVEL SECURITY/i.test(sql), "row security");
assert(/FOR SELECT\s+USING \(auth\.uid\(\) = user_id\)/i.test(sql), "the owner reads their own");
assert(/REVOKE ALL ON public\.message_packs FROM authenticated/i.test(sql) && /GRANT SELECT ON public\.message_packs TO authenticated/i.test(sql), "read only for a person");
assert(!/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i.test(sql), "no policy lets a person write");

// The service-only functions.
for (const signature of ["grant_message_pack\\(uuid, int, text\\)", "void_message_pack\\(uuid\\)", "reserve_ai_request\\(uuid\\)"]) {
  for (const role of ["PUBLIC", "anon", "authenticated"]) {
    assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM ${role}`, "i").test(sql), `revoke ${signature} from ${role}`);
  }
  assert(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO service_role`, "i").test(sql), `grant ${signature} to service_role`);
}
assert((sql.match(/SECURITY DEFINER/gi) ?? []).length === 3 && (sql.match(/SET search_path\s*=\s*''/gi) ?? []).length === 3, "all three functions are hardened");
assert(/ON CONFLICT \(payment_ref\) DO NOTHING/i.test(sql), "a repeated payment notice grants nothing");

// reserve_ai_request: the same reasons and the same order, with the pack in the middle.
const match = sql.match(/CREATE OR REPLACE FUNCTION public\.reserve_ai_request\s*\([\s\S]*?\$\$;/i);
assert(match !== null, "reserve_ai_request block");
const fn = match![0];
assert(/reserve_ai_request\s*\(\s*p_user_id\s+uuid\s*\)/i.test(fn), "same signature");
assert(/FOR UPDATE/i.test(fn), "the person's row is locked");
for (const reason of ["missing_tier", "suspended", "period_limit", "cost_cap", "daily_limit"]) {
  assert(fn.includes(`'${reason}'`), `reason ${reason} is kept`);
}
const iUnlimited = fn.search(/IF v_row\.unlimited_usage THEN/i);
const iPack = fn.search(/FROM public\.message_packs/i);
const iDaily = fn.indexOf("'daily_limit'");
assert(iUnlimited > 0 && iUnlimited < iPack, "an unlimited person is let through before the packs are looked at");
assert(iPack < iDaily, "the daily guard still comes after the packs and applies to a bought message too");
assert(/messages_left > 0/i.test(fn) && /voided_at IS NULL/i.test(fn) && /expires_at > v_now/i.test(fn), "only packs that are open, not voided and not expired");
assert(/ORDER BY expires_at, purchased_at/i.test(fn), "the pack that ends first goes first");
assert(/messages_left = messages_left - 1/i.test(fn), "one message of the pack is spent");
assert(/CASE WHEN v_use_pack THEN v_period_used ELSE v_period_used \+ 1 END/i.test(fn), "a bought message does not move the plan's own counter");
assert(/sum\(cost_allowance_usd\)/i.test(fn) && /v_limits\.cost_cap_usd \+ v_allowance/i.test(fn), "the bought messages raise the quiet ceiling");
assert(/interval\s+'24 hours'/i.test(fn) && /interval\s+'30 days'/i.test(fn) && /make_interval/i.test(fn), "the rules of 088 are kept");
// The refusal reason of a person with no pack is the same as before: the visible limit first, then the ceiling.
assert(/CASE WHEN v_limit_hit THEN 'period_limit' ELSE 'cost_cap' END/i.test(fn), "no pack: period_limit first, else cost_cap");
// A pack is spent only when the plan's own messages are out: with messages left the ceiling is passed as a plan message.
const iHit = fn.search(/IF v_limit_hit THEN\s+SELECT id\s+INTO v_pack_id/i);
const iUse = fn.search(/v_use_pack := true/i);
assert(iHit > 0 && iUse > iHit, "the pack is chosen and marked for use only inside the plan-is-out branch");
assert((fn.match(/v_use_pack := true/gi) ?? []).length === 1, "there is no other way into a pack");

console.log("=== messagePacksMigration.cases.test.ts OK ===");
