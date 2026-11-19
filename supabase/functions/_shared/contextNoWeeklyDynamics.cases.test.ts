/**
 * The weekly dynamics ("Динамика", progress_entries of type weekly) never go into Stacy's prompt.
 * Owner's rule, 20.11.2026: they were being read and put into the block «ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ» and should not have been.
 * Run: npx tsx --test supabase/functions/_shared/contextNoWeeklyDynamics.cases.test.ts
 *
 * context.ts has runtime npm: imports that plain Node cannot load, so this is a tripwire on the source: the reading of the weekly
 * entries and any field for them must not come back unnoticed. (The prompt itself is covered by lifecycleReadWiring.cases.test.ts.)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

const source = readFileSync(new URL("./context.ts", import.meta.url), "utf8")
  // Comments may explain the rule; only code counts.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

it("context.ts does not read the weekly entries", () => {
  assert.doesNotMatch(source, /from\(\s*["']progress_entries["']\s*\)/);
  assert.doesNotMatch(source, /entry_type["']?\s*,\s*["']weekly["']/);
  assert.doesNotMatch(source, /fetchWeeklyReflections/);
});

it("the context packet has no field for them and the narrative block is not given any", () => {
  assert.doesNotMatch(source, /weeklyReflections/);
  assert.doesNotMatch(source, /\bweekly\s*:/);
});
