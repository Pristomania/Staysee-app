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
