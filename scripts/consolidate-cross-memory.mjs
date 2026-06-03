/**
 * Merge fragment user_memory rows into full sentences (prod edge function).
 * Usage: npm run consolidate:memory
 *        npm run consolidate:memory -- --dryRun
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
const baseUrl =
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  env.SUPABASE_URL ??
  env.VITE_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

const dryRun = process.argv.includes("--dryRun") || process.argv.includes("--dry-run");
const recover = process.argv.includes("--recover");

if (!baseUrl || !serviceKey) {
  console.error("Need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const fnUrl = `${baseUrl.replace(/\/$/, "")}/functions/v1/consolidate-user-life-memory`;

console.log("Consolidate cross-memory", dryRun ? "(dry run)" : "");
console.log(fnUrl);

const res = await fetch(fnUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    dryRun,
    forceRebuild: true,
    recoverFromSummaries: recover,
  }),
});

const text = await res.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  console.error("Non-JSON response:", res.status, text.slice(0, 500));
  process.exit(1);
}

if (!res.ok) {
  console.error("Failed:", res.status, data);
  process.exit(1);
}

if (data.recovered) {
  console.log("\nRecovered from conversation summaries:");
  for (const r of data.recovered) {
    console.log(`  ${r.userId.slice(0, 8)}… fields≈${r.fields}`);
  }
  const results = data.consolidate ?? [];
  if (results.length) {
    console.log("\nConsolidated:");
    for (const r of results) {
      console.log(
        `  ${r.userId.slice(0, 8)}… removed=${r.removed} added=${r.added}${r.skipped ? ` (${r.skipped})` : ""}`
      );
    }
  }
} else if (data.summary) {
  console.log("\nSummary:", data.summary);
  if (data.results?.length) {
    console.log("\nPer user:");
    for (const r of data.results) {
      console.log(
        `  ${r.userId.slice(0, 8)}… kept=${r.kept} removed=${r.removed} added=${r.added}${r.skipped ? ` (${r.skipped})` : ""}`
      );
    }
  } else {
    console.log("No users with fragments to merge.");
  }
} else {
  console.log("\nResponse:", JSON.stringify(data, null, 2));
}

console.log("\nDone.");
