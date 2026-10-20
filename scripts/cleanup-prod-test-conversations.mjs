/**
 * Find and remove prod test conversations that leaked into user profiles.
 *
 *   node scripts/cleanup-prod-test-conversations.mjs --dry-run
 *   node scripts/cleanup-prod-test-conversations.mjs --apply
 *   node scripts/cleanup-prod-test-conversations.mjs --apply --older-than-minutes 60
 *
 * Test conversations are kept when a test ends (so memory can finish and failures can be examined); the next
 * test run removes the ones older than an hour. This removes them on request, optionally only the old ones.
 */

import {
  isTestConversationTitle,
  selectStaleTestConversations,
  deleteTestConversation,
  getServiceKey,
  getSupabaseUrl,
  loadEnvFile,
  makeServiceHeaders,
  restJson,
} from "./lib/prod-test-env.mjs";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const olderIndex = rawArgs.indexOf("--older-than-minutes");
const olderThanMinutes = olderIndex === -1 ? null : Number(rawArgs[olderIndex + 1]);
if (olderIndex !== -1 && (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0)) {
  console.error("--older-than-minutes needs a number of minutes (0 or more)");
  process.exit(1);
}
const dryRun = args.has("--dry-run") || !args.has("--apply");

if (!args.has("--dry-run") && !args.has("--apply")) {
  console.error("Usage: node scripts/cleanup-prod-test-conversations.mjs --dry-run|--apply");
  process.exit(1);
}

const env = loadEnvFile();
const url = getSupabaseUrl(env);
const serviceKey = getServiceKey(env);

if (!url || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const headers = makeServiceHeaders(serviceKey);

function isTestTitle(title) {
  return isTestConversationTitle(title);
}

async function countRows(table, filter, select = "id") {
  const rows = await restJson(url, headers, `${table}?${filter}&select=${select}`);
  return Array.isArray(rows) ? rows.length : 0;
}

const allConvs = await restJson(
  url,
  headers,
  "conversations?select=id,title,user_id,created_at&order=created_at.desc&limit=500"
);

const targets = olderThanMinutes === null
  ? (allConvs ?? []).filter((c) => isTestTitle(c.title))
  : selectStaleTestConversations(allConvs ?? [], { olderThanMinutes });

console.log(`Mode: ${dryRun ? "DRY-RUN (no deletes)" : "APPLY (will delete)"}`);
console.log(`Supabase: ${url}`);
console.log(`Found ${targets.length} test conversation(s)\n`);

if (targets.length === 0) {
  console.log("Nothing to clean up.");
  process.exit(0);
}

for (const conv of targets) {
  const cid = conv.id;
  const msgCount = await countRows("messages", `conversation_id=eq.${cid}`);
  const embByConv = await countRows(
    "message_embeddings",
    `conversation_id=eq.${cid}`,
    "message_id"
  );
  const progressCount = await countRows("progress_entries", `conversation_id=eq.${cid}`);

  console.log("---");
  console.log(`id:          ${cid}`);
  console.log(`title:       ${conv.title}`);
  console.log(`user_id:     ${conv.user_id}`);
  console.log(`created_at:  ${conv.created_at}`);
  console.log(`messages:    ${msgCount}`);
  console.log(`embeddings:  ${embByConv}`);
  console.log(`progress:    ${progressCount}`);

  if (!dryRun) {
    await deleteTestConversation(url, headers, cid);
    console.log(`deleted:     ${cid}`);
  }
}

console.log("\n---");
if (dryRun) {
  console.log(`Dry-run complete. Re-run with --apply to delete ${targets.length} conversation(s).`);
} else {
  console.log(`Deleted ${targets.length} test conversation(s).`);
}
