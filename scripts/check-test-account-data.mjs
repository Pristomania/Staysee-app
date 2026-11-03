// Read-only: how much of a freshly made TEST account's data is in the production database, table by table.
// Counts only, never content. For checking that "delete all memory", "delete the data of the account" and
// "delete the room" really leave nothing behind, and that the plan, the counter and the consents stay when they should.
//
//   STAYSEE_ALLOW_PROD_TESTS=1 STAYSEE_CHECK_EMAIL=<the mailbox the test account was made with> node scripts/check-test-account-data.mjs
//
// It looks only at an account created in the last 24 hours, so a wrong address can never show the data of a real person.
// A journey that runs over midnight can say so: STAYSEE_CHECK_MAX_AGE_HOURS=48 (a whole number, at most 72).
// The address is shown masked. It writes nothing.
import { pathToFileURL } from "node:url";
import { getServiceKey, getSupabaseUrl, isProdSupabaseUrl, loadEnvFile, makeServiceHeaders } from "./lib/prod-test-env.mjs";

/** A person's own content: all of it must be gone after "delete the data of the account". */
export const DATA_TABLES = [
  "conversations",
  "message_embeddings",
  "message_length_events",
  "message_model_summaries",
  "memory_corrections",
  "progress_entries",
  "protocol_events",
  "user_memory",
  "ai_reply_recovery_events",
  "memory_v3_dialogue_backfill_imports",
  "memory_v3_dialogue_evidence",
  "memory_v3_dialogue_heads",
  "memory_v3_dialogue_identities",
  "memory_v3_dialogue_items",
  "memory_v3_dialogue_runs",
  "memory_v3_lifecycle_backfill_imports",
  "memory_v3_lifecycle_shadow_evidence",
  "memory_v3_lifecycle_shadow_heads",
  "memory_v3_lifecycle_shadow_identities",
  "memory_v3_lifecycle_shadow_items",
  "memory_v3_lifecycle_shadow_runs",
  "memory_v3_reservation_failures",
  "memory_v3_shadow_identities",
  "memory_v3_shadow_runs",
  "memory_v3_stale_alerts",
];

/** Tables nobody can read through the API (all access is revoked, even for the service key): count them with SQL. */
export const SQL_ONLY_TABLES = ["memory_v3_stale_alerts"];

/** What stays when the data is deleted: the plan and the counter, the bought messages, the consents, the usage log. */
export const KEPT_TABLES = ["user_usage_tiers", "message_packs", "user_consents", "ai_usage_log", "ai_usage_logs"];

const FRESH_HOURS = 24;
const FRESH_HOURS_LIMIT = 72;

/** A day by default. A longer window (up to 72 hours) only when it is asked for on purpose, for a journey that runs over midnight. */
export function freshHours(value) {
  if (value === undefined || String(value).trim() === "") return FRESH_HOURS;
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 1 || hours > FRESH_HOURS_LIMIT) {
    throw new Error(`STAYSEE_CHECK_MAX_AGE_HOURS must be a whole number from 1 to ${FRESH_HOURS_LIMIT}`);
  }
  return hours;
}

export function maskEmail(email) {
  const [name = "", domain = ""] = String(email).split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

export function isFreshAccount(createdAt, now = new Date(), hours = FRESH_HOURS) {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const age = now.getTime() - created.getTime();
  return age >= 0 && age <= hours * 3_600_000;
}

/** "2/5" or "*\/0" of a content-range header becomes the number after the slash. */
export function rangeTotal(header) {
  const total = Number(String(header ?? "").split("/")[1]);
  return Number.isFinite(total) ? total : null;
}

export function summarize(counts) {
  const filled = Object.entries(counts).filter(([, count]) => count > 0);
  return { rows: filled.reduce((sum, [, count]) => sum + count, 0), tables: filled.map(([table, count]) => `${table} ${count}`) };
}

async function main() {
  const env = loadEnvFile();
  const url = getSupabaseUrl(env);
  const serviceKey = getServiceKey(env);
  if (!url || !serviceKey) throw new Error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  if (isProdSupabaseUrl(url) && process.env.STAYSEE_ALLOW_PROD_TESTS !== "1") {
    throw new Error("Prod checks are disabled unless STAYSEE_ALLOW_PROD_TESTS=1 is set in the environment");
  }
  const email = String(process.env.STAYSEE_CHECK_EMAIL ?? "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Set STAYSEE_CHECK_EMAIL to the mailbox the test account was made with");

  const headers = makeServiceHeaders(serviceKey);
  const get = async (path, init = {}) => fetch(`${url}${path}`, { headers: { ...headers, ...(init.prefer ? { Prefer: init.prefer } : {}) }, method: init.method ?? "GET" });

  // Find the account by its address (a small project: a few pages of the admin list).
  let account = null;
  for (let page = 1; page <= 20 && !account; page += 1) {
    const response = await get(`/auth/v1/admin/users?page=${page}&per_page=200`);
    if (!response.ok) throw new Error(`admin users list failed: HTTP ${response.status}`);
    const body = await response.json();
    const users = body.users ?? [];
    account = users.find((user) => String(user.email ?? "").toLowerCase() === email) ?? null;
    if (users.length < 200) break;
  }

  console.log(`mailbox: ${maskEmail(email)}`);
  if (!account) {
    console.log("auth user: NOT FOUND (never made, or already removed for good)");
    return;
  }
  const hours = freshHours(process.env.STAYSEE_CHECK_MAX_AGE_HOURS);
  if (!isFreshAccount(account.created_at, new Date(), hours)) {
    console.log(`refusing: this account was not made in the last ${hours} hours, so it is not looked at. Nothing was read.`);
    process.exitCode = 1;
    return;
  }
  await report(url, headers, account);
}

/** Prints the counts for one account (already found and already checked to be fresh). Read-only. */
export async function report(url, headers, account) {
  const get = async (path, init = {}) => fetch(`${url}${path}`, { headers: { ...headers, ...(init.prefer ? { Prefer: init.prefer } : {}) }, method: init.method ?? "GET" });
  const id = account.id;
  console.log(`auth user: present, made ${account.created_at}, email confirmed: ${account.email_confirmed_at ? "yes" : "no"}`);

  // A table this database does not have is listed as missing. Any other failed read is listed as unreadable and makes the
  // run fail: a zero that came from a failed read must never pass for "nothing left".
  const missing = [];
  const unreadable = [];
  const count = async (table, filter = `user_id=eq.${id}`) => {
    const response = await get(`/rest/v1/${table}?select=*&${filter}`, { method: "HEAD", prefer: "count=exact" });
    if (response.status === 404) {
      missing.push(table);
      return null;
    }
    const total = response.ok ? rangeTotal(response.headers.get("content-range")) : null;
    if (total === null) unreadable.push(`${table} (HTTP ${response.status})`);
    return total;
  };

  // Only columns the production table has (asking for one it lacks made every read fail and the line say "no row").
  // A read that fails is said so; it is never shown as an empty answer.
  const rows = async (path) => {
    const response = await get(path);
    if (!response.ok) return { failed: response.status };
    const body = await response.json().catch(() => null);
    return { rows: Array.isArray(body) ? body : [] };
  };

  const profileRead = await rows(`/rest/v1/profiles?select=room_deletion_requested_at,room_purge_after&id=eq.${id}`);
  const profile = profileRead.rows?.[0];
  console.log(
    `profile: ${profileRead.failed ? `query failed (HTTP ${profileRead.failed})` : profile ? `room deletion requested: ${profile.room_deletion_requested_at ?? "no"}, purge after: ${profile.room_purge_after ?? "-"}` : "no row"}`,
  );

  const planRead = await rows(`/rest/v1/user_usage_tiers?select=tier,period_requests_used,unlimited_usage,max_conversations_override&user_id=eq.${id}`);
  const plan = planRead.rows?.[0];
  const packsRead = await rows(`/rest/v1/message_packs?select=messages_left&user_id=eq.${id}&voided_at=is.null&messages_left=gt.0`);
  console.log(
    `plan: ${planRead.failed ? `query failed (HTTP ${planRead.failed})` : plan ? `tier=${plan.tier}, messages used=${plan.period_requests_used}, unlimited=${plan.unlimited_usage}, rooms override=${plan.max_conversations_override}` : "no row"}; bought messages left: ${packsRead.failed ? `query failed (HTTP ${packsRead.failed})` : packsRead.rows.reduce((sum, pack) => sum + (pack.messages_left ?? 0), 0)}`,
  );

  const dataCounts = {};
  for (const table of DATA_TABLES.filter((name) => !SQL_ONLY_TABLES.includes(name))) dataCounts[table] = (await count(table)) ?? 0;
  const conversationRead = await rows(`/rest/v1/conversations?select=id&user_id=eq.${id}&limit=1000`);
  if (conversationRead.failed) unreadable.push(`conversations list (HTTP ${conversationRead.failed})`);
  const conversationIds = (conversationRead.rows ?? []).map((row) => row.id);
  dataCounts.messages = conversationIds.length ? ((await count("messages", `conversation_id=in.(${conversationIds.join(",")})`)) ?? 0) : 0;
  const data = summarize(dataCounts);
  console.log(`\nDATA (the person's own content; must be 0 after "delete the data of the account"):`);
  console.log(data.rows === 0 ? "  none: 0 rows in every table" : `  ${data.rows} rows: ${data.tables.join(", ")}`);

  const keptCounts = {};
  for (const table of KEPT_TABLES) keptCounts[table] = (await count(table)) ?? 0;
  console.log(`\nKEPT BY DESIGN (plan and counter, bought messages, consents, usage log):`);
  console.log(`  ${Object.entries(keptCounts).map(([table, n]) => `${table} ${n}`).join(", ")}`);

  for (const table of SQL_ONLY_TABLES) {
    console.log(`\nNot readable through the API, count it with SQL: select count(*) from public.${table} where user_id = '${id}';`);
  }
  if (missing.length) console.log(`\nNot in this database (counted as 0): ${[...new Set(missing)].join(", ")}`);
  if (unreadable.length) {
    console.log(`\nUNREADABLE, do not trust the zeros above: ${unreadable.join(", ")}`);
    process.exitCode = 1;
  }
}

// Run only when started from the command line, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
