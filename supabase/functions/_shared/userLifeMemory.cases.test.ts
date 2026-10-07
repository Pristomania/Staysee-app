import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

// userLifeMemory.ts has runtime npm: dependencies that plain Node cannot load.
// This narrow wiring contract complements profilePrefs.cases.test.ts, which
// exercises the real preference reader behavior.
const source = await readFile(new URL("./userLifeMemory.ts", import.meta.url), "utf8");

it("uses the conversation preference for live refreshes and the profile default for maintenance", () => {
  assert.match(
    source,
    /conversationId\s*\?\s*await fetchConversationCrossMemoryEnabled\(\s*supabase,\s*userId,\s*conversationId\s*\)\s*:\s*await fetchCrossMemoryEnabled\(\s*supabase,\s*userId\s*\)/u,
  );
});

it("writes the candidate's computed importance on both user_memory insert paths, not just memory_type and content", () => {
  // Regression coverage: TYPE_IMPORTANCE already scores every candidate
  // (communication/preference=5, life_context/insight=4, theme/emotion=3),
  // but both insert() calls silently dropped that value -- every row in
  // production has sat at the importance column's default (3) ever since
  // migration 005 added it, which made "order by importance" (context.ts's
  // fetchMemoryItems) a no-op tie-break instead of real prioritization.
  const insertCalls = source.match(/\.insert\(\{[^}]*\}\)/gs) ?? [];
  const userMemoryInsertCalls = insertCalls.filter((call) => call.includes("memory_type"));
  assert.equal(userMemoryInsertCalls.length, 2, "expected exactly the fact-evolution and generic insert sites");
  for (const call of userMemoryInsertCalls) {
    assert.match(call, /importance:\s*c\.importance/);
  }
});

it("reinforces (not silently skips) a fact that matches an already-stored row, instead of leaving importance write-once forever", () => {
  // Without this, importance is set once at insert and never revisited --
  // a fact mentioned again in a later conversation (the only real "still
  // relevant" signal this table has) was previously just deduplicated
  // away with zero effect, same as a fact nobody has mentioned since.
  assert.match(
    source,
    /async function reinforceExistingRow\(rowId: string\): Promise<void> \{/,
  );
  assert.match(source, /const boosted = Math\.min\(5, current \+ 1\);/);
  assert.match(
    source,
    /\.update\(\{\s*importance:\s*boosted,\s*updated_at:\s*new Date\(\)\.toISOString\(\),?\s*\}\)/,
  );
  // Called from both the exact-duplicate and the similar-fact branch, in
  // both the fact-evolution insert path and the generic insert path --
  // four call sites, not just a defined-but-unused helper.
  const calls = source.match(/reinforceExistingRow\([a-zA-Z.]+\)/g) ?? [];
  assert.equal(calls.length, 4);
});

it("keeps importance within the column's 1-5 range even after repeated reinforcement", () => {
  // The backing column has CHECK (importance BETWEEN 1 AND 5) (migration
  // 005) -- Math.min(5, ...) is not just a product choice, an unbounded
  // increment would make every repeat insert fail the constraint outright.
  assert.match(source, /Math\.min\(5, current \+ 1\)/);
});
