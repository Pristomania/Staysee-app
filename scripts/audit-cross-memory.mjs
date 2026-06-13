/**
 * Audit user_memory rows against cross-memory policy (no DB writes).
 * Usage: node scripts/audit-cross-memory.mjs
 *        node scripts/audit-cross-memory.mjs --userId=<uuid>
 */

import { readFileSync, writeFileSync } from "node:fs";
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
const DEPRECATED = new Set(["theme", "emotion", "insight"]);

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

function isStablePeopleFact(text) {
  const t = text.trim();
  if (!t) return false;
  return !isBlocked(t);
}

function auditRow(row) {
  if (DEPRECATED.has(row.memory_type)) return "delete";
  if (!ALLOWED.has(row.memory_type)) return "delete";
  if (isBlocked(row.content)) return "delete";
  if (row.memory_type === "life_context") {
    const t = row.content.trim();
    if (t.length >= 40 && !isStableLifeFact(t)) return "hide";
    if (t.length < 40 && !isStablePeopleFact(t)) return "hide";
  }
  return "keep";
}

const env = loadEnvFile(join(root, ".env"));
const baseUrl =
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  env.SUPABASE_URL ??
  env.VITE_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

const userIdArg = process.argv.find((a) => a.startsWith("--userId="));
const userId = userIdArg?.split("=")[1];

if (!baseUrl || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

let url = `${baseUrl.replace(/\/$/, "")}/rest/v1/user_memory?select=id,user_id,memory_type,content,created_at&order=created_at.desc`;
if (userId) url += `&user_id=eq.${userId}`;

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
  },
});

if (!res.ok) {
  console.error("Fetch failed:", res.status, await res.text());
  process.exit(1);
}

const rows = await res.json();
const byVerdict = { keep: [], hide: [], delete: [] };

for (const row of rows) {
  const verdict = auditRow(row);
  const bucket = verdict === "keep" ? "keep" : verdict === "hide" ? "hide" : "delete";
  byVerdict[bucket].push({
    id: row.id,
    user_id: row.user_id,
    memory_type: row.memory_type,
    content: row.content,
    verdict,
  });
}

const report = {
  audited_at: new Date().toISOString(),
  total: rows.length,
  keep: byVerdict.keep.length,
  hide: byVerdict.hide.length,
  delete: byVerdict.delete.length,
  rows: byVerdict,
};

const outPath = join(root, "audit-cross-memory.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

console.log(
  `Audited ${rows.length} rows → keep ${byVerdict.keep.length}, hide ${byVerdict.hide.length}, delete ${byVerdict.delete.length}`,
);

for (const v of ["delete", "hide", "keep"]) {
  if (!byVerdict[v].length) continue;
  console.log(`\n=== ${v.toUpperCase()} (${byVerdict[v].length}) ===`);
  for (const r of byVerdict[v]) {
    console.log(`[${r.memory_type}] ${r.content.slice(0, 120)}${r.content.length > 120 ? "…" : ""}`);
  }
}
