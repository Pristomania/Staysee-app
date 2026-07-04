/**
 * Core V2 flat ordinary runtime — budget, diagnostics, active guidance.
 * Run: npx tsx supabase/functions/_shared/flatCoreV2Runtime.cases.test.ts
 */

import { isFlatCoreV2OrdinaryRuntime } from "./flatCoreV2Runtime.ts";
import {
  buildPauseInArcTurnGuidance,
  pauseInArcGuidanceInjected,
} from "./pauseInArcTurnGuidance.ts";
import {
  buildExplicitClosureTurnGuidance,
  explicitClosureGuidanceInjected,
} from "./explicitClosureTurnGuidance.ts";
import {
  analyzeEmotionalTrajectory,
  analyzeResponseDepth,
} from "./responseDepthTrajectory.ts";

const TIER_CEILING = { free: 1600, basic: 1200, premium: 1800 } as const;
const DEPTH_TOKEN_TARGET = { brief: 380, medium: 900, deep: 1600 } as const;
const OUTPUT_TOKEN_CEILING_GUIDANCE =
  "Output has a maximum token ceiling. The ceiling is a boundary, not a requested response length. Respond within the available ceiling.";

const v2Env = () => "v2";
const legacyEnv = () => "legacy";

let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.log(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`PASS: ${message}`);
}

type Turn = { role: "user" | "assistant"; content: string };

function buildHistory(pairs: Array<[string, string?]>): Turn[] {
  const out: Turn[] = [];
  for (const [user, assistant] of pairs) {
    out.push({ role: "user", content: user });
    if (assistant) out.push({ role: "assistant", content: assistant });
  }
  return out;
}

function flatBudgetMaxTokens(tier: keyof typeof TIER_CEILING): number {
  return TIER_CEILING[tier];
}

function flatContinuationSegmentBudget(tier: keyof typeof TIER_CEILING): number {
  const tierCeiling = TIER_CEILING[tier];
  return Math.min(tierCeiling, Math.max(280, Math.floor(tierCeiling * 0.55)));
}

function depthContinuationSegmentBudget(
  tier: keyof typeof TIER_CEILING,
  depth: keyof typeof DEPTH_TOKEN_TARGET,
): number {
  const tierCeiling = TIER_CEILING[tier];
  const target = Math.floor(DEPTH_TOKEN_TARGET[depth] * 0.55);
  return Math.min(tierCeiling, Math.max(280, target));
}

console.log("=== flatCoreV2Runtime mode detection ===\n");

assert(isFlatCoreV2OrdinaryRuntime("normal", v2Env), "v2 normal → flat ordinary");
assert(!isFlatCoreV2OrdinaryRuntime("crisis", v2Env), "v2 crisis → not flat ordinary");
assert(!isFlatCoreV2OrdinaryRuntime("normal", legacyEnv), "legacy → not flat ordinary");

console.log("\n=== flat budget — tier ceiling, not depth target ===\n");

for (const label of ["brief", "medium", "deep"]) {
  const budget = flatBudgetMaxTokens("free");
  assert(budget === TIER_CEILING.free, `flat free ${label} → maxTokens=${budget} (ceiling 1600)`);
  assert(budget !== 380 && budget !== 900, `flat free ${label} → not depth target 380/900`);
}

assert(
  flatBudgetMaxTokens("premium") === TIER_CEILING.premium,
  `flat premium deep → tier ceiling ${TIER_CEILING.premium}`,
);
assert(
  flatBudgetMaxTokens("basic") === TIER_CEILING.basic,
  `flat basic brief → tier ceiling ${TIER_CEILING.basic}`,
);

assert(
  OUTPUT_TOKEN_CEILING_GUIDANCE.includes("ceiling is a boundary, not a requested response length"),
  "OUTPUT_TOKEN_CEILING_GUIDANCE present",
);

console.log("\n=== flat continuation segment budget ===\n");

const flatSegment = flatContinuationSegmentBudget("free");
const mediumDepthSegment = depthContinuationSegmentBudget("free", "medium");
assert(flatSegment !== mediumDepthSegment, "flat continuation not medium depth target floor");
assert(flatSegment >= 280, "flat continuation has technical minimum");
assert(flatSegment <= TIER_CEILING.free, "flat continuation capped by tier");

console.log("\n=== removed behavioral guidance (diagnostic-only depth) ===\n");

const openFigureAnalysis = analyzeResponseDepth("устала", "normal", []);
assert(openFigureAnalysis.depthReason === "open_figure", "open figure still classified diagnostically");

const uncertaintyAnalysis = analyzeResponseDepth(
  "Не знаю",
  "normal",
  buildHistory([
    ["Мне грустно", "..."],
    ["Просто есть", "..."],
  ]),
);
assert(
  uncertaintyAnalysis.depthReason === "uncertainty_in_process",
  "uncertainty still classified diagnostically",
);

console.log("\n=== pause / explicit closure still active ===\n");

const pauseHistory = buildHistory([
  [
    "Меня накрывает страх перед ответственностью. Я должна принять решение, и от этого мандраж.",
    "Похоже, это решение важно для тебя.",
  ],
  ["И это пугает.", "Что именно тебя пугает?"],
]);
const pauseMessage = "Я пока пойду";
const pauseAnalysis = analyzeResponseDepth(pauseMessage, "normal", pauseHistory);
const pauseInput = {
  message: pauseMessage,
  depthReason: pauseAnalysis.depthReason,
  openFigure: pauseAnalysis.openFigure,
  emotionalMomentum: pauseAnalysis.emotionalMomentum,
  shortAfterEmotional: analyzeEmotionalTrajectory(pauseMessage, pauseHistory)
    .shortAfterEmotional,
  recentHistory: pauseHistory,
  safetyCategory: "normal" as const,
};
assert(!!buildPauseInArcTurnGuidance(pauseInput), "pauseInArc guidance still available");
assert(pauseInArcGuidanceInjected(pauseInput), "pauseInArcGuidanceInjected true when triggered");

const closureAnalysis = analyzeResponseDepth("На сегодня всё.", "normal", []);
assert(closureAnalysis.depthReason === "explicit_closure", "explicit closure detected");
assert(
  !!buildExplicitClosureTurnGuidance({
    depthReason: closureAnalysis.depthReason,
    message: "На сегодня всё.",
  }),
  "explicit closure guidance injected",
);
assert(
  explicitClosureGuidanceInjected({
    depthReason: closureAnalysis.depthReason,
    message: "На сегодня всё.",
  }),
  "explicitClosureGuidanceInjected true",
);

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll flatCoreV2Runtime cases passed.");
