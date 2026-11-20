/**
 * Near-integration tests for reply recovery route orchestration (a reply the model finished is left alone; one cut by length is continued).
 * Run: npx tsx supabase/functions/_shared/replyRecoveryRoutes.cases.test.ts
 */

import {
  runReplyRecoveryRoutes,
  type RecoveryChatMessage,
  type RecoveryModelCallKind,
} from "./replyRecovery.ts";

const MARKER = "MARKER_AT_THE_END";
const BASE_MESSAGES: RecoveryChatMessage[] = [
  { role: "user", content: "Как мне с этим быть?" },
];

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Case A: a reply that stopped by itself and has no mark at the end is left exactly as it is:
// no repair, no second generation, no error text.
{
  let callCount = 0;
  const reply = `Это цельный ответ, который закончился на слове ${MARKER}`;

  const out = await runReplyRecoveryRoutes({
    firstSegment: { content: reply, finishReason: "stop" },
    baseModelMessages: BASE_MESSAGES,
    unavailableMessage: "UNAVAILABLE",
    callModel: async (_messages, kind) => {
      callCount++;
      throw new Error(`unexpected call kind: ${kind}`);
    },
  });

  assert(callCount === 0, "Case A: no model call at all");
  assert(out.diagnostics.completionRoute === "normal_publishable", "Case A: normal route");
  assert(out.content === reply, "Case A: the reply comes out unchanged");
  assert(
    !out.wasAutoContinued && !out.diagnostics.retryWholeUsed && !out.diagnostics.failClosedUsed && !out.diagnostics.repairApplied,
    "Case A: nothing was repaired, retried or failed"
  );
}

// Case B: length truncation → continue + merge
{
  let continueMessages: RecoveryChatMessage[] | null = null;
  let callCount = 0;

  const partA = "Первый абзац обрывается на полуслове момен";
  const partB = "т продолжения.";

  const out = await runReplyRecoveryRoutes({
    firstSegment: { content: partA, finishReason: "length" },
    baseModelMessages: BASE_MESSAGES,
    unavailableMessage: "UNAVAILABLE",
    callModel: async (messages, kind: RecoveryModelCallKind) => {
      callCount++;
      if (kind === "auto_continue") {
        continueMessages = messages;
        return { content: partB, finishReason: "stop" };
      }
      throw new Error(`unexpected call kind: ${kind}`);
    },
  });

  assert(callCount === 1, "Case B: one auto_continue call");
  assert(
    out.diagnostics.completionRoute === "length_truncation_continue",
    "Case B: length_truncation_continue route"
  );
  assert(out.wasAutoContinued, "Case B: auto_continue_used");
  assert(
    out.diagnostics.autoContinueTriggerReason === "finish_reason_length",
    "Case B: trigger reason length"
  );
  assert(out.diagnostics.mergeStrategy !== null, "Case B: merge allowed");
  assert(out.content.includes(partA), "Case B: merged output includes segment1");
  assert(out.content.includes("момент"), "Case B: merged output includes continuation");

  assert(continueMessages !== null, "Case B: auto_continue was called");
  const assistantMsg = continueMessages!.find((m) => m.role === "assistant");
  assert(assistantMsg?.content === partA, "Case B: continue sees segment1 as assistant context");
}

console.log("All replyRecoveryRoutes cases passed.");
