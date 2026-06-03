/**
 * 7-day breakdown: model, tokens, cost per request.
 * Usage: node scripts/usage-breakdown-7d.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const since = new Date(Date.now() - 7 * 86400000).toISOString();

const { data, error } = await sb
  .from("ai_usage_logs")
  .select("model,prompt_tokens,completion_tokens,total_tokens,cost,summary_tokens,memory_tokens")
  .gte("created_at", since);

if (error) {
  console.error(error);
  process.exit(1);
}

const n = data.length;
const sum = (k) => data.reduce((s, r) => s + Number(r[k] || 0), 0);
const byModel = {};

for (const r of data) {
  const m = r.model || "unknown";
  if (!byModel[m]) {
    byModel[m] = { n: 0, cost: 0, prompt: 0, completion: 0, summary: 0 };
  }
  byModel[m].n++;
  byModel[m].cost += Number(r.cost);
  byModel[m].prompt += Number(r.prompt_tokens);
  byModel[m].completion += Number(r.completion_tokens);
  byModel[m].summary += Number(r.summary_tokens);
}

console.log("\n=== 7 дней: ai_usage_logs ===\n");
console.log("Запросов к API:", n);
console.log("Сумма USD:", sum("cost").toFixed(4));
console.log("Среднее USD на запрос:", (sum("cost") / n).toFixed(4));
console.log("Средний prompt_tokens:", Math.round(sum("prompt_tokens") / n));
console.log("Средний completion_tokens:", Math.round(sum("completion_tokens") / n));
console.log("Средний summary_tokens (архив+сводка в промпте):", Math.round(sum("summary_tokens") / n));
console.log("Средний memory_tokens:", Math.round(sum("memory_tokens") / n));

console.log("\nПо модели:\n");
console.table(
  Object.entries(byModel)
    .map(([model, v]) => ({
      model,
      requests: v.n,
      usd: Number(v.cost.toFixed(3)),
      avg_usd: Number((v.cost / v.n).toFixed(4)),
      avg_prompt: Math.round(v.prompt / v.n),
      avg_completion: Math.round(v.completion / v.n),
    }))
    .sort((a, b) => b.usd - a.usd)
);

// Rough $/user message if ~1 API call per user message (often 1-3 with continue)
const userMessagesEst = 435;
const cost435 = 10;
console.log("\nОценка пользователя (435 сообщений ≈ $10):");
console.log("USD на сообщение (если 1 API-вызов):", (cost435 / userMessagesEst).toFixed(4));
console.log("Факт из логов (7д, 211 API):", (sum("cost") / n).toFixed(4), "USD/API");
