/**
 * Verify cross-memory filter: prod rows → injectable prompt block.
 * Usage: node scripts/verify-cross-memory-filter.mjs
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

const ALLOWED = new Set(["life_context", "communication", "preference"]);

const DYNAMIC_CONTENT_RE = [
  /страх/i,
  /тревог/i,
  /истощ/i,
  /кризис/i,
  /предательств/i,
  /сепарац/i,
  /эмоциональн/i,
  /пережива/i,
  /боится/i,
  /боитесь/i,
  /боль/i,
  /страдан/i,
  /повторяющиеся жизненные темы/i,
  /эмоциональный фон/i,
  /конфликт/i,
  /напряжен/i,
  /незаверш/i,
  /саморазрушен/i,
  /выгоран/i,
  /изоляц/i,
  /не\s+доверя/i,
  /сложная и эмоционально/i,
  /потер[яи]\s+контрол/i,
];

const NARRATIVE_EVENT_RE = [
  /сказала,\s*что/i,
  /разговор\s+с/i,
  /не\s+попытал/i,
  /съехали/i,
  /стали\s+парой/i,
  /жила\s+втроем/i,
  /почти\s+месяц/i,
  /обследован/i,
  /намек\s+на/i,
  /нестандартн/i,
  /съемн/i,
];

const FORBIDDEN_IN_MONEY_CHAT = [
  /сепарац/i,
  /предательств/i,
  /страх\s+потери\s+контрол/i,
  /эмоционально\s+истощ/i,
  /кризис/i,
  /стали\s+парой/i,
  /повторяющиеся\s+жизненные\s+темы/i,
];

function isBlocked(content) {
  const t = content.trim();
  if (!t) return true;
  return DYNAMIC_CONTENT_RE.some((re) => re.test(t));
}

function isStableLifeFact(text) {
  const t = text.trim();
  if (t.length < 40) return false;
  if (isBlocked(t)) return false;
  if (NARRATIVE_EVENT_RE.some((re) => re.test(t))) return false;
  return true;
}

function filterForInjection(rows) {
  return rows.filter((row) => {
    if (!ALLOWED.has(row.memory_type)) return false;
    if (isBlocked(row.content)) return false;
    if (row.memory_type === "life_context") {
      const t = row.content.trim();
      if (t.length >= 40 && !isStableLifeFact(t)) return false;
    }
    return true;
  });
}

function formatCrossMemoryForPrompt(items) {
  const TYPE_LABELS = {
    communication: "Стиль общения",
    preference: "Предпочтения контакта",
    life_context: "Факты профиля",
  };
  const grouped = new Map();
  for (const i of items) {
    const label = TYPE_LABELS[i.memory_type] ?? i.memory_type;
    const list = grouped.get(label) ?? [];
    list.push(i.content.trim());
    grouped.set(label, list);
  }
  const lines = [
    "СКВОЗНАЯ ПАМЯТЬ (между беседами — стабильный профиль и стиль общения):",
    "Только устойчивые факты и предпочтения контакта. Не подставляй сюжеты и эмоции других бесед.",
  ];
  for (const [label, sentences] of grouped) {
    lines.push(`${label}:`);
    for (const s of sentences) lines.push(`• ${s}`);
  }
  return lines.join("\n");
}

function testManualAddBlocked() {
  const samples = [
    "Пользователь переживает сепарацию с сыном.",
    "Пользователь находится в эмоциональном кризисе.",
    "страх потери контроля в отношениях.",
    "У пользователя есть сын.",
    "предпочитает прямой тон без пустых успокоений.",
  ];
  let ok = true;
  for (const s of samples) {
    const blocked = isBlocked(s);
    const expectBlock = s.includes("сепарац") || s.includes("кризис") || s.startsWith("страх");
    if (blocked !== expectBlock) {
      console.error(`FAIL manual-add check: "${s}" blocked=${blocked} expected=${expectBlock}`);
      ok = false;
    }
  }
  return ok;
}

const env = loadEnvFile(join(root, ".env"));
const baseUrl =
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  env.SUPABASE_URL ??
  env.VITE_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

if (!baseUrl || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const url = `${baseUrl.replace(/\/$/, "")}/rest/v1/user_memory?select=id,memory_type,content&order=created_at.desc`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
});
if (!res.ok) {
  console.error("Fetch failed:", res.status, await res.text());
  process.exit(1);
}

const rows = await res.json();
const injectable = filterForInjection(rows);
const crossBlock = injectable.length ? formatCrossMemoryForPrompt(injectable) : "";

console.log("=== Cross-memory injection preview ===\n");
console.log(crossBlock || "(empty — no injectable rows)");
console.log("\n=== Checks ===");

let pass = true;
pass = testManualAddBlocked() && pass;

for (const re of FORBIDDEN_IN_MONEY_CHAT) {
  if (re.test(crossBlock)) {
    console.error(`FAIL: forbidden pattern in injectable block: ${re}`);
    pass = false;
  }
}

const deprecatedTypes = rows.filter((r) => !ALLOWED.has(r.memory_type));
if (deprecatedTypes.length) {
  console.log(`Legacy rows in DB (not injected): ${deprecatedTypes.length}`);
}

console.log(`Injectable rows: ${injectable.length} / ${rows.length} total`);
console.log(pass ? "\nPASS: filter verification OK" : "\nFAIL: filter verification failed");
process.exit(pass ? 0 : 1);
