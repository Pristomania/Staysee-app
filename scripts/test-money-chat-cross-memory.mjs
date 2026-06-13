/**
 * Post-deploy: money-chat must not get dynamic cross-memory in context.
 * Rebuilds injectable cross-memory block from prod DB (same filter as context.ts).
 *
 * Usage: node scripts/test-money-chat-cross-memory.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
  const vars = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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
    /* missing */
  }
  return vars;
}

const env = loadEnvFile(join(root, ".env"));
const baseUrl = (
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  env.SUPABASE_URL ??
  env.VITE_SUPABASE_URL
).replace(/\/$/, "");
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey =
  process.env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY;

if (!baseUrl || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${serviceKey}`,
  apikey: serviceKey,
};

const FORBIDDEN = [
  "сепарац",
  "предательств",
  "страх потери контроля",
  "эмоционально истощ",
  "кризис",
  "стали парой",
  "повторяющиеся жизненные темы",
];

async function rest(path) {
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// User with richest cross-memory from audit
const userId = "0acde6d0-2741-4992-b876-d77eab0f6d15";

const convs = await rest(
  `conversations?user_id=eq.${userId}&select=id,title,conversation_summary&order=last_message_at.desc&limit=20`,
);

let moneyConv =
  convs.find((c) => /деньг|финанс|бюджет|доход/i.test(c.title ?? "")) ?? null;

if (!moneyConv) {
  const createRes = await fetch(`${baseUrl}/rest/v1/conversations`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: userId,
      title: "Деньги и бюджет",
      conversation_summary: JSON.stringify({
        people: [],
        preferences: ["хочет ясности в цифрах"],
        important_events: [],
        themes: ["финансовая тревога в этом чате"],
        emotional_state: ["напряжение из-за расходов"],
        open_loops: [],
        risks: [],
      }),
    }),
  });
  if (!createRes.ok) {
    console.error("Create money conv failed:", await createRes.text());
    process.exit(1);
  }
  moneyConv = (await createRes.json())[0];
  console.log("Created test conversation:", moneyConv.id, moneyConv.title);
} else {
  console.log("Using conversation:", moneyConv.id, moneyConv.title);
}

const memoryRows = await rest(
  `user_memory?user_id=eq.${userId}&select=memory_type,content&order=created_at.desc`,
);

// Mirror filterCrossMemoryRowsForInjection + formatCrossMemoryForPrompt
const ALLOWED = new Set(["life_context", "communication", "preference"]);
const DYNAMIC = [/страх/i, /сепарац/i, /предательств/i, /кризис/i, /эмоционально\s+истощ/i, /стали\s+парой/i, /повторяющиеся жизненные темы/i];
const NARRATIVE = [/стали\s+парой/i, /нестандартн/i, /съемн/i];

function injectable(rows) {
  return rows.filter((r) => {
    if (!ALLOWED.has(r.memory_type)) return false;
    if (DYNAMIC.some((re) => re.test(r.content))) return false;
    if (r.memory_type === "life_context" && r.content.length >= 40) {
      if (NARRATIVE.some((re) => re.test(r.content))) return false;
    }
    return true;
  });
}

const block = injectable(memoryRows)
  .map((r) => `• [${r.memory_type}] ${r.content}`)
  .join("\n");

console.log("\n=== Injectable cross-memory (post-filter) ===\n");
console.log(block || "(empty)");

let ok = true;
for (const term of FORBIDDEN) {
  if (block.toLowerCase().includes(term)) {
    console.error(`FAIL: forbidden term in injectable block: "${term}"`);
    ok = false;
  }
}

// Conversation summary must still have per-chat dynamics
let summary;
try {
  summary = typeof moneyConv.conversation_summary === "string"
    ? JSON.parse(moneyConv.conversation_summary)
    : moneyConv.conversation_summary;
} catch {
  summary = null;
}

if (summary) {
  const convBlob = JSON.stringify(summary);
  const hasConvDynamics =
    (summary.themes?.length ?? 0) > 0 || (summary.emotional_state?.length ?? 0) > 0;
  console.log("\n=== Conversation memory (per-chat, untouched) ===");
  console.log(`themes: ${summary.themes?.length ?? 0}, emotional_state: ${summary.emotional_state?.length ?? 0}`);
  if (!hasConvDynamics && !/деньг|финанс/i.test(moneyConv.title ?? "")) {
    console.warn("WARN: money conv has no themes/emotional_state in summary (may be new empty conv)");
  }
  if (/финансовая тревога|напряжение из-за расходов/.test(convBlob)) {
    console.log("PASS: per-chat dynamics still present in conversation_summary");
  }
}

// Optional live staysee-chat ping (needs anon key + user JWT path — skip if no anon)
if (anonKey && process.env.RUN_LIVE_CHAT === "1") {
  const chatRes = await fetch(`${baseUrl}/functions/v1/staysee-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
      Apikey: anonKey,
    },
    body: JSON.stringify({
      message: "Как мне спокойнее смотреть на ежемесячные расходы?",
      conversationId: moneyConv.id,
      userId,
      requestId: `cross-mem-test-${Date.now()}`,
    }),
  });
  const chatData = await chatRes.json();
  const reply = String(chatData.content ?? "");
  console.log("\n=== Live reply snippet ===\n", reply.slice(0, 400));
  for (const term of ["сепарац", "предательств", "племянниц", "страх потери контроля"]) {
    if (new RegExp(term, "i").test(reply)) {
      console.error(`FAIL: reply mentions "${term}" — possible cross-memory leak`);
      ok = false;
    }
  }
}

console.log(ok ? "\nPASS: money-chat cross-memory test" : "\nFAIL: money-chat cross-memory test");
process.exit(ok ? 0 : 1);
