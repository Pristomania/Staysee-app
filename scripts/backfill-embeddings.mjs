/**
 * Backfill message_embeddings for existing conversations (one chat at a time).
 *
 * Requires: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY in .env
 *
 * Usage:
 *   npm run backfill:embeddings
 *   npm run backfill:embeddings -- --conversationId <uuid>
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const EMBEDDING_MODEL =
  process.env.STAYSEE_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
const BATCH = 20;

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
    // no file
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
    } else if (arg.startsWith("--conversationId=")) {
      conversationId = arg.slice("--conversationId=".length);
    }
  }
  return { conversationId: conversationId?.trim() || null };
}

async function createEmbeddings(texts, apiKey) {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://staysee.app",
      "X-Title": "StaySee AI",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return [...data.data].sort((a, b) => a.index - b.index).map((r) => r.embedding);
}

function embedLabel(sender, content) {
  const role = sender === "user" ? "Пользователь" : "StaySee";
  return `${role}: ${content.replace(/\s+/g, " ").trim().slice(0, 6000)}`;
}

async function backfillConversation(supabase, conv, apiKey) {
  const { data: messages } = await supabase
    .from("messages")
    .select("id, sender, content, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });

  if (!messages?.length) return 0;

  const { data: existing } = await supabase
    .from("message_embeddings")
    .select("message_id")
    .eq("conversation_id", conv.id);

  const have = new Set((existing ?? []).map((r) => r.message_id));
  const missing = messages.filter((m) => m.content?.trim() && !have.has(m.id));
  if (!missing.length) return 0;

  let done = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const vectors = await createEmbeddings(
      batch.map((m) => embedLabel(m.sender, m.content)),
      apiKey
    );
    const rows = batch.map((m, idx) => ({
      message_id: m.id,
      conversation_id: conv.id,
      user_id: conv.user_id,
      sender: m.sender,
      embedding: vectors[idx],
    }));
    const { error } = await supabase.from("message_embeddings").upsert(rows, {
      onConflict: "message_id",
    });
    if (error) throw error;
    done += batch.length;
    process.stdout.write(`  +${batch.length} `);
  }
  return done;
}

const env = loadEnvFile(join(root, ".env"));
const { conversationId } = parseArgs(process.argv.slice(2));

const baseUrl = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const apiKey = env.OPENROUTER_API_KEY;

if (!baseUrl || !serviceKey || !apiKey) {
  console.error("Need VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY in .env");
  process.exit(1);
}

const supabase = createClient(baseUrl, serviceKey);

let query = supabase.from("conversations").select("id, user_id, title");
if (conversationId) query = query.eq("id", conversationId);

const { data: convs, error } = await query;
if (error) {
  console.error(error.message);
  process.exit(1);
}

console.log(`Conversations: ${convs?.length ?? 0}`);

let total = 0;
for (const conv of convs ?? []) {
  console.log(`\n${conv.title || conv.id}`);
  try {
    total += await backfillConversation(supabase, conv, apiKey);
  } catch (e) {
    console.error(`  failed: ${e.message}`);
    if (e.message.includes("message_embeddings")) {
      console.error("  Run: npx supabase db push (migration 015_message_embeddings)");
    }
  }
}

console.log(`\nDone. Embedded ${total} messages.`);
