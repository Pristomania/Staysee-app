/**
 * OpenRouter usage report (service role).
 * Usage: npm run usage:report
 *        npm run usage:report -- --conversationId <uuid>
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const vars = {};
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env */
  }
  return vars;
}

const env = loadEnv();
const url = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

let conversationId = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--conversationId") conversationId = process.argv[++i];
}

if (!url || !key) {
  console.error("Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  const { data: today, error: e1 } = await supabase.rpc("get_usage_cost_today");
  if (e1) console.warn("get_usage_cost_today:", e1.message);

  console.log("\n=== Расход за сегодня (UTC) ===");
  console.log(today?.[0] ?? "(нет данных — таблица пуста или миграция не применена)");

  const { data: users, error: e2 } = await supabase.rpc("get_usage_cost_by_users", {
    p_since: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  if (e2) console.warn("get_usage_cost_by_users:", e2.message);
  console.log("\n=== По пользователям (7 дней) ===");
  console.table((users ?? []).slice(0, 15));

  const { data: convs, error: e3 } = await supabase.rpc("get_top_expensive_conversations", {
    p_limit: 10,
    p_since: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  if (e3) console.warn("get_top_expensive_conversations:", e3.message);
  console.log("\n=== Самые дорогие беседы (30 дней) ===");
  console.table(convs ?? []);

  const { data: mem, error: e4 } = await supabase.rpc("get_memory_token_usage", {
    p_since: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  if (e4) console.warn("get_memory_token_usage:", e4.message);
  console.log("\n=== Память (30 дней) ===");
  console.log(mem?.[0] ?? {});

  if (conversationId) {
    const { data: rows, error: e5 } = await supabase
      .from("ai_usage_logs")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });
    if (e5) console.warn("conversation query:", e5.message);
    console.log(`\n=== Беседа ${conversationId} ===`);
    const total = (rows ?? []).reduce((s, r) => s + Number(r.cost), 0);
    console.log(`Запросов: ${rows?.length ?? 0}, сумма: $${total.toFixed(6)}`);
    console.table(rows ?? []);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
