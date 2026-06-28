/**
 * Approved model policy guard for edge runtime sources.
 * Run: npx tsx supabase/functions/_shared/approvedModels.cases.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  APPROVED_MODEL_GPT4O,
  APPROVED_MODEL_SONNET,
  BANNED_RUNTIME_MODEL_SUBSTRINGS,
  assertApprovedRuntimeModel,
  buildOpenRouterUtilityModelConfig,
  isApprovedRuntimeModel,
  resolveApprovedUtilityModel,
} from "./approvedModels.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const ROOT = join(import.meta.dirname, "..");

const SCAN_EXCLUDE_FILES = new Set([
  "approvedModels.ts",
  "approvedModels.cases.test.ts",
]);

const RUNTIME_SCAN_PATHS = [
  join(ROOT, "backfill-conversation-summaries", "index.ts"),
  join(ROOT, "consolidate-user-life-memory", "index.ts"),
  join(ROOT, "weekly-reflection", "index.ts"),
  join(ROOT, "staysee-chat", "index.ts"),
  join(ROOT, "_shared", "semanticCrisisCheck.ts"),
  join(ROOT, "_shared", "cost.ts"),
  join(ROOT, "_shared", "modelRouter.ts"),
];

const SCAN_EXCLUDE_SUFFIXES = [
  ".cases.test.ts",
  "openRouterPricing.ts",
  "structuredTurnModelSupport.ts",
];

function collectSharedRuntimeFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) continue;
    if (!entry.endsWith(".ts")) continue;
    if (SCAN_EXCLUDE_FILES.has(entry)) continue;
    if (SCAN_EXCLUDE_SUFFIXES.some((suffix) => entry.endsWith(suffix) || entry.includes(suffix))) {
      continue;
    }
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
}

console.log("=== approved model constants ===\n");
assert(isApprovedRuntimeModel(APPROVED_MODEL_GPT4O), "gpt-4o approved");
assert(isApprovedRuntimeModel(APPROVED_MODEL_SONNET), "sonnet approved");
assert(!isApprovedRuntimeModel("openai/gpt-4.1"), "gpt-4.1 not approved");
assert(!isApprovedRuntimeModel("anthropic/claude-3.5-haiku"), "haiku not approved");

console.log("=== utility model defaults ===\n");
const utility = resolveApprovedUtilityModel();
assert(utility.primary === APPROVED_MODEL_GPT4O, "utility primary gpt-4o");
assert(utility.fallback === APPROVED_MODEL_SONNET, "utility fallback sonnet");

const config = buildOpenRouterUtilityModelConfig({ title: "Test" });
assert(config.model === APPROVED_MODEL_GPT4O, "utility config model");
assert(config.fallbackModel === APPROVED_MODEL_SONNET, "utility config fallback");

console.log("=== env override validation ===\n");
let rejected = false;
try {
  assertApprovedRuntimeModel("openai/gpt-4.1", "test");
} catch {
  rejected = true;
}
assert(rejected, "gpt-4.1 override rejected");

console.log("=== banned model substring scan ===\n");
const sharedDir = join(ROOT, "_shared");
const sharedFiles: string[] = [];
collectSharedRuntimeFiles(sharedDir, sharedFiles);

const filesToScan = [...new Set([...RUNTIME_SCAN_PATHS, ...sharedFiles])];
const violations: string[] = [];

for (const file of filesToScan) {
  const text = readFileSync(file, "utf8");
  for (const banned of BANNED_RUNTIME_MODEL_SUBSTRINGS) {
    if (text.includes(banned)) {
      violations.push(`${relative(join(ROOT, ".."), file)} contains "${banned}"`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  throw new Error(`Banned model strings found in runtime sources (${violations.length})`);
}

console.log(`scanned ${filesToScan.length} runtime files — no banned model strings`);
console.log("\n=== approvedModels.cases.test.ts OK ===\n");
