/**
 * Batch backfill conversation_summary via deployed edge function.
 * Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (project root).
 *
 * Usage:
 *   npm run backfill:memory
 *   npm run backfill:memory -- --conversationId <uuid>
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnvFile(path) {
  const vars = {};
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // missing .env
  }
  return vars;
}

function parseArgs(argv) {
  let conversationId = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--conversationId" || arg === "--conversation-id") {
      conversationId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith("--conversationId=")) {
      conversationId = arg.slice("--conversationId=".length);
    }
    if (arg.startsWith("--conversation-id=")) {
      conversationId = arg.slice("--conversation-id=".length);
    }
  }
  return { conversationId: conversationId?.trim() || null };
}

const env = loadEnvFile(join(root, ".env"));
const { conversationId: forcedConversationId } = parseArgs(process.argv.slice(2));
const baseUrl =
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  env.SUPABASE_URL ??
  env.VITE_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

if (!baseUrl) {
  console.error("Missing SUPABASE_URL or VITE_SUPABASE_URL in .env");
  process.exit(1);
}
if (!serviceKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const batchSize = Number(process.env.BACKFILL_BATCH_SIZE ?? "8") || 8;
const dryRun = process.argv.includes("--dry-run");
const endpoint = `${baseUrl.replace(/\/$/, "")}/functions/v1/backfill-conversation-summaries`;

const headers = {
  "Content-Type": "application/json",
  apikey: serviceKey.trim(),
  Authorization: `Bearer ${serviceKey.trim()}`,
};
if (process.env.BACKFILL_SECRET ?? env.BACKFILL_SECRET) {
  headers["X-Backfill-Secret"] =
    process.env.BACKFILL_SECRET ?? env.BACKFILL_SECRET;
}

let cursor = null;
let round = 0;
let totalProcessed = 0;
let totalOk = 0;
let totalFailed = 0;
let totalSkipped = 0;
const errors = [];

function logForcedResult(data) {
  const r = data.results?.[0];
  if (!r) {
    console.log("No result row returned.");
    return;
  }
  console.log("");
  console.log("=== Forced backfill ===");
  console.log(`conversationId:     ${r.conversationId ?? data.conversationId}`);
  console.log(`messages found:     ${r.messagesFound ?? r.messageCount ?? "?"}`);
  console.log(`summary generated:  ${r.summaryGenerated === true}`);
  console.log(`saved:              ${r.saved === true}`);
  console.log(`status:             ${r.status}`);
  if (r.error) console.log(`error:              ${r.error}`);
  if (data.error) console.log(`response error:     ${data.error}`);
}

async function postBatch() {
  const body = { batchSize };
  if (cursor) body.cursor = cursor;
  if (dryRun) body.dryRun = true;
  if (forcedConversationId) {
    body.conversationId = forcedConversationId;
    body.force = true;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(
      data?.error ?? data?.message ?? `HTTP ${res.status}: ${text.slice(0, 500)}`
    );
  }

  return data;
}

console.log(`Backfill → ${endpoint}`);
if (forcedConversationId) {
  console.log(`Forced mode → conversationId=${forcedConversationId}`);
}
if (dryRun) console.log("(dry run)");

if (forcedConversationId) {
  let data;
  try {
    data = await postBatch();
  } catch (err) {
    console.error("Request failed:", err.message);
    process.exit(1);
  }
  logForcedResult(data);
  if (data.results?.[0]?.status === "failed" || data.error) {
    process.exit(1);
  }
  process.exit(0);
}

let done = false;

while (!done) {
  round += 1;
  console.log(`Round ${round} ...`);

  let data;
  try {
    data = await postBatch();
  } catch (err) {
    console.error("Request failed:", err.message);
    process.exit(1);
  }

  const processed = data.processed ?? 0;
  const ok = data.ok ?? 0;
  const failed = data.failed ?? 0;
  const skipped = data.skipped ?? 0;

  totalProcessed += processed;
  totalOk += ok;
  totalFailed += failed;
  totalSkipped += skipped;

  for (const r of data.results ?? []) {
    if (r.status === "failed") {
      errors.push({
        conversationId: r.conversationId,
        error: r.error ?? "unknown",
      });
    }
  }

  console.log(
    `  processed=${processed} ok=${ok} failed=${failed} skipped=${skipped} done=${data.done}`
  );
  if (data.hint) console.log(`  ${data.hint}`);
  if (data.message) console.log(`  ${data.message}`);

  cursor = data.nextCursor ?? null;
  done = data.done === true;

  if (processed === 0 && done) break;
}

console.log("");
console.log("=== Backfill summary ===");
console.log(`Conversations processed: ${totalProcessed}`);
console.log(`Summaries created (ok):  ${totalOk}`);
console.log(`Skipped:                 ${totalSkipped}`);
console.log(`Failed:                  ${totalFailed}`);

if (errors.length > 0) {
  console.log(`Errors (${errors.length}):`);
  for (const e of errors.slice(0, 20)) {
    console.log(`  - ${e.conversationId}: ${e.error}`);
  }
  if (errors.length > 20) {
    console.log(`  ... and ${errors.length - 20} more`);
  }
  process.exit(1);
}

console.log("Errors: none");
