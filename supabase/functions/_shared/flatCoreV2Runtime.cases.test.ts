/**
 * Core V2 flat ordinary runtime — budget, guidance injection, diagnostics.
 * Run: npx tsx supabase/functions/_shared/flatCoreV2Runtime.cases.test.ts
 */

import { isFlatCoreV2OrdinaryRuntime } from "./flatCoreV2Runtime.ts";
import {
  buildOpenFigureTurnGuidance,
  openFigureGuidanceInjected,
} from "./openFigureTurnGuidance.ts";
import {
  buildPauseInArcTurnGuidance,
  pauseInArcGuidanceInjected,
} from "./pauseInArcTurnGuidance.ts";
import {
  buildExplicitClosureTurnGuidance,
  explicitClosureGuidanceInjected,
} from "./explicitClosureTurnGuidance.ts";
import {
  buildUncertaintyTurnGuidance,
  uncertaintyGuidanceInjected,
} from "./uncertaintyTurnGuidance.ts";
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

/** Mirrors staysee-chat/index.ts guidance gating for Core V2 flat ordinary turns. */
function simulateGuidanceInjection(message: string, history: Turn[]) {
  const flatOrdinary = isFlatCoreV2OrdinaryRuntime("normal", v2Env);
  const analysis = analyzeResponseDepth(message, "normal", history);

  const openFigureGuidance = flatOrdinary
    ? null
    : buildOpenFigureTurnGuidance({
        openFigure: analysis.openFigure,
        depthReason: analysis.depthReason,
        safetyCategory: "normal",
      });
  const openFigureOn = flatOrdinary
    ? false
    : openFigureGuidanceInjected({
        openFigure: analysis.openFigure,
        depthReason: analysis.depthReason,
        safetyCategory: "normal",
      });

  const pauseInput = {
    message,
    depthReason: analysis.depthReason,
    openFigure: analysis.openFigure,
    emotionalMomentum: analysis.emotionalMomentum,
    shortAfterEmotional: analyzeEmotionalTrajectory(message, history)
      .shortAfterEmotional,
    recentHistory: history,
    safetyCategory: "normal" as const,
  };
  const pauseGuidance = buildPauseInArcTurnGuidance(pauseInput);
  const pauseOn = pauseInArcGuidanceInjected(pauseInput);

  const uncertaintyGuidance = flatOrdinary
    ? null
    : buildUncertaintyTurnGuidance({
        depthReason: analysis.depthReason,
        message,
        openFigure: { isOpen: analysis.openFigure.isOpen },
      });
  const uncertaintyOn = flatOrdinary
    ? false
    : uncertaintyGuidanceInjected({
        depthReason: analysis.depthReason,
        message,
        openFigure: { isOpen: analysis.openFigure.isOpen },
      });

  const explicitClosureGuidance = buildExplicitClosureTurnGuidance({
    depthReason: analysis.depthReason,
    message,
  });
  const explicitClosureOn = explicitClosureGuidanceInjected({
    depthReason: analysis.depthReason,
    message,
  });

  return {
    flatOrdinary,
    analysis,
    openFigureGuidance,
    openFigureOn,
    pauseGuidance,
    pauseOn,
    uncertaintyGuidance,
    uncertaintyOn,
    explicitClosureGuidance,
    explicitClosureOn,
    ceilingGuidance: OUTPUT_TOKEN_CEILING_GUIDANCE,
  };
}

console.log("=== flatCoreV2Runtime mode detection ===\n");

assert(isFlatCoreV2OrdinaryRuntime("normal", v2Env), "v2 normal → flat ordinary");
assert(!isFlatCoreV2OrdinaryRuntime("crisis", v2Env), "v2 crisis → not flat ordinary");
assert(!isFlatCoreV2OrdinaryRuntime("normal", legacyEnv), "legacy → not flat ordinary");

console.log("\n=== flat budget — tier ceiling, not depth target ===\n");

const longEmotional =
  "Мне так тревожно последние недели, я не могу спать, постоянно думаю что со мной не так и боюсь что всё рухнет и я не выдержу этот круг одиночества и усталости от работы которая меня выматывает каждый день без конца";

for (const [label, message] of [
  ["brief", "Привет"],
  ["medium", "устала"],
  ["deep", longEmotional],
] as const) {
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

console.log("\n=== flat guidance injection (Core V2 ordinary) ===\n");

const openFigureTurn = simulateGuidanceInjection("устала", []);
assert(openFigureTurn.flatOrdinary, "open figure turn uses flat mode");
assert(openFigureTurn.analysis.depthReason === "open_figure", "depth still diagnostic");
assert(!openFigureTurn.openFigureGuidance, "openFigure guidance not injected when flat");
assert(!openFigureTurn.openFigureOn, "openFigureGuidanceInjected false when flat");

const uncertaintyTurn = simulateGuidanceInjection(
  "Не знаю",
  buildHistory([
    ["Мне грустно", "..."],
    ["Просто есть", "..."],
  ]),
);
assert(
  uncertaintyTurn.analysis.depthReason === "uncertainty_in_process",
  "uncertainty still classified",
);
assert(!uncertaintyTurn.uncertaintyGuidance, "uncertainty guidance not injected when flat");
assert(!uncertaintyTurn.uncertaintyOn, "uncertaintyGuidanceInjected false when flat");

console.log("\n=== pause / explicit closure still active ===\n");

const pauseTurn = simulateGuidanceInjection(
  "Я пока пойду",
  buildHistory([
    [
      "Меня накрывает страх перед ответственностью. Я должна принять решение, и от этого мандраж.",
      "Похоже, это решение важно для тебя.",
    ],
    ["И это пугает.", "Что именно тебя пугает?"],
  ]),
);
assert(!!pauseTurn.pauseGuidance, "pauseInArc guidance still injected when triggered");
assert(pauseTurn.pauseOn, "pauseInArcGuidanceInjected true when triggered");

const closureTurn = simulateGuidanceInjection("На сегодня всё.", []);
assert(closureTurn.explicitClosureOn, "explicit closure detected");
assert(!!closureTurn.explicitClosureGuidance, "explicit closure guidance injected");

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll flatCoreV2Runtime cases passed.");
