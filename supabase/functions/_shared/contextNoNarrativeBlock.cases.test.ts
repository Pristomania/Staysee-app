/**
 * Stacy's prompt gets no «ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ» block and no weekly dynamics ("Динамика").
 * Owner's decisions, 20.11.2026. The block was built from word patterns over the person's last lines, the old chat summary and
 * the weekly dynamics (progress_entries of type weekly); it spoke in the feminine («в её словах») and the new memory does its job.
 * Run: npx tsx --test supabase/functions/_shared/contextNoNarrativeBlock.cases.test.ts
 *
 * context.ts has runtime npm: imports that plain Node cannot load, so this is a tripwire on the source: neither the block nor
 * the reading of the weekly entries may come back unnoticed. (The prompt itself is covered by lifecycleReadWiring.cases.test.ts.)
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { it } from "node:test";

const source = readFileSync(new URL("./context.ts", import.meta.url), "utf8")
  // Comments may explain the rule; only code counts.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

it("context.ts does not build the narrative block", () => {
  assert.doesNotMatch(source, /narrativeEngine/);
  assert.doesNotMatch(source, /buildNarrativeContext|formatNarrativeForPrompt/);
  assert.doesNotMatch(source, /ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ/);
});

it("the engine file with the word patterns is gone", () => {
  assert.equal(existsSync(new URL("./narrativeEngine.ts", import.meta.url)), false);
});

it("context.ts does not read the weekly dynamics and its packet has no field for them", () => {
  assert.doesNotMatch(source, /from\(\s*["']progress_entries["']\s*\)/);
  assert.doesNotMatch(source, /entry_type["']?\s*,\s*["']weekly["']/);
  assert.doesNotMatch(source, /fetchWeeklyReflections|weeklyReflections/);
  assert.doesNotMatch(source, /\bweekly\s*:/);
});

// ── No «corrections» picked out of the person's words by patterns (owner's rule, 20.11.2026: no decisions by words in app code) ──

const indexSource = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

it("the chat does not detect or store memory corrections by word patterns", () => {
  assert.doesNotMatch(indexSource, /detectMemoryCorrection|isEphemeralDenialOnly|persistMemoryCorrection|candidateToDurable|sameTurnDurableCorrection/);
  assert.doesNotMatch(indexSource, /memoryCorrectionsEnabled/);
});

it("the context does not pick «corrections» out of the person's words and does not load stored ones", () => {
  assert.doesNotMatch(source, /collectMemoryCorrectionHints|loadActiveCorrections|memoryCorrectionsEnabled/);
});
