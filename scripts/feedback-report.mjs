/**
 * What people said about Stacy's answers (thumbs up / down, migration 095), for the owner of the product.
 * Reads the view message_feedback_review with the service key, read only. Nothing is written or saved to a file: the text
 * of the answers and of the notes is shown in the terminal and nowhere else.
 *
 *   npm run feedback:report                   the last 30, newest first
 *   npm run feedback:report -- --bad          only the "not good" ones
 *   npm run feedback:report -- --limit=100    more of them (up to 200)
 *   npm run feedback:report -- --since=2026-11-17
 */
import { pathToFileURL } from "node:url";
import { getServiceKey, getSupabaseUrl, loadEnvFile, makeServiceHeaders } from "./lib/prod-test-env.mjs";

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 200;

export function parseArgs(argv) {
  const options = { bad: false, limit: DEFAULT_LIMIT, since: null };
  for (const arg of argv) {
    if (arg === "--bad") options.bad = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isInteger(n) && n >= 1) options.limit = Math.min(n, MAX_LIMIT);
    } else if (arg.startsWith("--since=")) {
      const day = arg.slice("--since=".length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) options.since = day;
    }
  }
  return options;
}

export function buildQuery(options) {
  const parts = ["select=*", "order=created_at.desc", `limit=${options.limit}`];
  if (options.bad) parts.push("rating=eq.-1");
  if (options.since) parts.push(`created_at=gte.${options.since}`);
  return `message_feedback_review?${parts.join("&")}`;
}

export function maskEmail(email) {
  if (!email) return "почта неизвестна";
  const [name = "", domain = ""] = String(email).split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

const oneLine = (text) => String(text ?? "").replace(/\s*\n+\s*/g, " / ").trim();

export function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatReport(rows) {
  const bad = rows.filter((row) => row.rating === -1).length;
  const lines = [`Отзывы на ответы Стейси: показано ${rows.length} (плохих ${bad}, хороших ${rows.length - bad}). Новые сверху, время московское.`];
  if (rows.length === 0) lines.push("", "Пока ничего нет.");
  for (const row of rows) {
    lines.push(
      "",
      `[${row.rating === -1 ? "ПЛОХО" : "ХОРОШО"}] ${formatWhen(row.created_at)} | аккаунт ${String(row.user_id ?? "").slice(0, 8)} (${maskEmail(row.email)}, тариф ${row.tier ?? "?"}) | модель: ${row.model_guess ?? "?"} | промпт: ${row.prompt_version_guess ?? "?"} (по журналу, примерно)`,
      `  Вопрос: «${oneLine(row.previous_user_message)}»`,
      `  Ответ:  «${oneLine(row.reply_excerpt)}»`,
    );
    if (row.comment) lines.push(`  Написал(а): «${oneLine(row.comment)}»`);
    lines.push(`  беседа ${String(row.conversation_id).slice(0, 8)}, ответ ${String(row.message_id).slice(0, 8)}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = loadEnvFile();
  const baseUrl = getSupabaseUrl(env);
  const serviceKey = getServiceKey(env);
  if (!baseUrl || !serviceKey) {
    console.error("Нужны VITE_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в файле .env");
    process.exitCode = 1;
    return;
  }
  const response = await fetch(`${baseUrl}/rest/v1/${buildQuery(options)}`, { headers: makeServiceHeaders(serviceKey) });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404 || /message_feedback_review|PGRST205/.test(text)) {
      console.error("Таблица отзывов ещё не создана на боевой базе (миграция 095 не выложена).");
    } else {
      console.error(`Не удалось прочитать отзывы: HTTP ${response.status}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(formatReport(text ? JSON.parse(text) : []));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
