import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// A script that reaches a model provider on its own (not through the app) must write the cost down: this keeps a new script from being added
// without it, which is how costs went missing from the panel before.

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (/\.(mjs|ts)$/.test(entry.name) && !/\.test\.(mjs|ts)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

// Scripts that already write their calls into ai_usage_logs themselves (each for the person whose data it works on).
const WRITES_ITS_OWN_ROWS = new Set(["memory-v3-topic-backfill/backfill-topics.ts"]);

describe("scripts that reach a model provider on their own write the cost down", () => {
  const files = collect(SCRIPTS).filter((file) => !file.endsWith(join("lib", "off-app-usage-log.mjs")));

  it("every direct use of the network's fetch for a run goes through wrapForOffAppUsage", () => {
    const loose = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/globalThis\.fetch\.bind\(globalThis\)/.test(text) && !/wrapForOffAppUsage\(globalThis\.fetch\.bind\(globalThis\)/.test(text)) {
        loose.push(relative(SCRIPTS, file).replaceAll("\\", "/"));
      }
    }
    assert.deepEqual(loose, [], "these scripts hand the plain fetch to a run: wrap it with wrapForOffAppUsage(...)");
  });

  it("a script that calls the provider's address itself uses the wrapper (or writes its own rows)", () => {
    const loose = [];
    for (const file of files) {
      const relativePath = relative(SCRIPTS, file).replaceAll("\\", "/");
      if (WRITES_ITS_OWN_ROWS.has(relativePath)) continue;
      const text = readFileSync(file, "utf8");
      const callsProvider = /[^.\w]fetch\(/.test(text) && /openrouter\.ai|foundation-models\.api\.cloud\.ru/.test(text);
      if (callsProvider && !/wrapForOffAppUsage\(/.test(text)) loose.push(relativePath);
    }
    assert.deepEqual(loose, [], "these scripts call a model provider directly without writing the cost down");
  });

  it("the scripts that already write their own rows still do", () => {
    for (const relativePath of WRITES_ITS_OWN_ROWS) {
      assert.match(readFileSync(join(SCRIPTS, relativePath), "utf8"), /ai_usage_logs/, `${relativePath} is on the list because it writes ai_usage_logs`);
    }
  });
});
