/**
 * Near-integration tests for reply recovery route orchestration.
 * Run: npx tsx supabase/functions/_shared/replyRecoveryRoutes.cases.test.ts
 */

import {
  runReplyRecoveryRoutes,
  type RecoveryChatMessage,
  type RecoveryModelCallKind,
} from "./replyRecovery.ts";

const REJECTED = "REJECTED_SEGMENT_SHOULD_NOT_APPEAR";
const BASE_MESSAGES: RecoveryChatMessage[] = [
  { role: "user", content: "Как мне с этим быть?" },
];

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Case A: stop + not publishable → retry whole replaces, no merge, no rejected segment in retry input
{
  let retryWholeMessages: RecoveryChatMessage[] | null = null;
  let callCount = 0;

  const out = await runReplyRecoveryRoutes({
    firstSegment: {
      content: `${REJECTED} and`,
      finishReason: "stop",
    },
    baseModelMessages: BASE_MESSAGES,
    unavailableMessage: "UNAVAILABLE",
    replyNotRecoveredMessage: "NOT_RECOVERED",
    callModel: async (messages, kind) => {
      callCount++;
      if (kind === "retry_whole") {
        retryWholeMessages = messages;
        return { content: "Это новый цельный ответ.", finishReason: "stop" };
      }
      throw new Error(`unexpected call kind: ${kind}`);
    },
  });

  assert(callCount === 1, "Case A: exactly one retry_whole call");
  assert(
    out.diagnostics.completionRoute === "stop_not_publishable_retry_whole",
    "Case A: route retry_whole"
  );
  assert(!out.wasAutoContinued, "Case A: auto_continue_used false");
  assert(out.diagnostics.retryWholeUsed, "Case A: retry_whole_used");
  assert(
    out.content === "Это новый цельный ответ.",
    "Case A: final output is retry only"
  );
  assert(!out.content.includes(REJECTED), "Case A: rejected phrase absent from output");
  assert(
    out.diagnostics.mergeStrategy === null,
    "Case A: no merge strategy"
  );

  assert(retryWholeMessages !== null, "Case A: retry_whole was called");
  const serialized = JSON.stringify(retryWholeMessages);
  assert(!serialized.includes(REJECTED), "Case A: rejected phrase absent from retry input");
  assert(
    serialized === JSON.stringify(BASE_MESSAGES),
    "Case A: retry input equals base messages only"
  );

  for (const m of retryWholeMessages!) {
    assert(m.role !== "assistant", "Case A: no assistant message in retry input");
  }
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
