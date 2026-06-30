/**
 * Explicit closure vs emotional trajectory — routing cases.
 * Run: npx tsx supabase/functions/_shared/responseDepthTrajectory.cases.test.ts
 */

import {
  analyzeEmotionalTrajectory,
  analyzeOpenFigure,
  analyzeResponseDepth,
  isExplicitConversationClosure,
} from "./responseDepthTrajectory.ts";

type Turn = { role: "user" | "assistant"; content: string };

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function buildHistory(pairs: Array<[string, string?]>): Turn[] {
  const out: Turn[] = [];
  for (const [user, assistant] of pairs) {
    out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

// 1. Standalone explicit closure — still brief / explicit_closure / closed figure
{
  const message = "на сегодня всё";
  assert(
    isExplicitConversationClosure(message),
    "standalone closure phrase should match detector"
  );
  const analysis = analyzeResponseDepth(message, "normal", []);
  assert(analysis.depth === "brief", `expected brief, got ${analysis.depth}`);
  assert(
    analysis.depthReason === "explicit_closure",
    `expected explicit_closure, got ${analysis.depthReason}`
  );
  assert(
    !analysis.openFigure.isOpen,
    "standalone closure should keep open figure closed"
  );
  console.log("✓ explicit closure without emotional arc → brief / closed");
}

// 2. Explicit closure during emotionalMomentum — do not force closure path
{
  const history = buildHistory([
    ["Мне тревожно последние дни", "..."],
    ["Не могу понять что со мной", "..."],
    ["Устала от всего этого", "..."],
  ]);
  const message = "на сегодня всё";
  assert(
    isExplicitConversationClosure(message),
    "closure phrase inside emotional arc should still match detector"
  );
  const analysis = analyzeResponseDepth(message, "normal", history);
  assert(
    analysis.depthReason !== "explicit_closure",
    `emotionalMomentum must block explicit_closure, got ${analysis.depthReason}`
  );
  console.log("✓ explicit closure with emotionalMomentum → not explicit_closure");
}

// 3. Explicit closure after short emotional turn — do not force closure path
{
  const history = buildHistory([["Мне страшно", "..."]]);
  const message = "пока";
  assert(isExplicitConversationClosure(message), "пока should match closure detector");
  const analysis = analyzeResponseDepth(message, "normal", history);
  assert(
    analysis.depthReason !== "explicit_closure",
    `shortAfterEmotional must block explicit_closure, got ${analysis.depthReason}`
  );
  const openFigure = analyzeOpenFigure({
    message,
    recentHistory: history,
    safetyCategory: "normal",
    trajectory: analyzeEmotionalTrajectory(message, history),
  });
  assert(
    openFigure.isOpen,
    "shortAfterEmotional closure phrase should not auto-close open figure"
  );
  console.log("✓ explicit closure with shortAfterEmotional → open figure allowed");
}

// 4. Empty message — still CLOSED_OPEN_FIGURE
{
  const openFigure = analyzeOpenFigure({
    message: "   ",
    recentHistory: [],
    safetyCategory: "normal",
    trajectory: {
      recentUserTurns: [],
      emotionalMomentum: false,
      shortAfterEmotional: false,
      signalCount: 0,
      uncertaintyInProcess: false,
    },
  });
  assert(!openFigure.isOpen, "empty message should return CLOSED_OPEN_FIGURE");
  console.log("✓ empty message → CLOSED_OPEN_FIGURE");
}

console.log("\nAll responseDepthTrajectory cases passed.");
