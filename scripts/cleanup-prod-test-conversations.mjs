/**
 * Find and remove prod test conversations that leaked into user profiles.
 *
 *   node scripts/cleanup-prod-test-conversations.mjs --dry-run
 *   node scripts/cleanup-prod-test-conversations.mjs --apply
 */

import {
  isTestConversationTitle,
  deleteTestConversation,
  getServiceKey,
  getSupabaseUrl,
  loadEnvFile,
  makeServiceHeaders,
  restJson,
} from "./lib/prod-test-env.mjs";

const args = new Set(process.argv.slice(2));
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

const targets = (allConvs ?? []).filter((c) => isTestTitle(c.title));

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
