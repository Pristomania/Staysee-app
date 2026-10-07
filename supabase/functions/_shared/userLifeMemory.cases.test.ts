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
