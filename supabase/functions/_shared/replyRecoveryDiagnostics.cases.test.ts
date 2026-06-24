/**
 * Recovery diagnostics row builder tests.
 * Run: npx tsx supabase/functions/_shared/replyRecoveryDiagnostics.cases.test.ts
 */

import { buildRecoveryEventInsert } from "./replyRecoveryDiagnostics.ts";
import { createEmptyRecoveryDiagnostics, snapshotSegment } from "./replyRecovery.ts";

const d = createEmptyRecoveryDiagnostics();
d.completionRoute = "stop_not_publishable_repair";
d.segment1 = snapshotSegment("обрыв", "stop");
d.stopNotPublishableReasons = ["broken_ending"];

const row = buildRecoveryEventInsert({
  requestId: "req-1",
  conversationId: "conv-1",
  userId: "user-1",
  model: "anthropic/claude-sonnet-4-5",
  promptVersion: "test-prompt",
  constitutionVersion: "test-const",
  diagnostics: d,
});

if (row.completion_route !== "stop_not_publishable_repair") {
  throw new Error("completion_route mismatch");
}
if (row.request_id !== "req-1") throw new Error("request_id mismatch");
if (row.segment_1_publishable !== false) throw new Error("segment_1_publishable");
if ((row.stop_not_publishable_reasons ?? "").includes("broken_ending") === false) {
  throw new Error("stop reasons");
}
if ("content" in row || "assistant_text" in row) {
  throw new Error("must not include raw content fields");
}

console.log("All replyRecoveryDiagnostics cases passed.");
