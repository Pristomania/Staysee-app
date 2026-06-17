/**
 * Dynamic completion token budget — short / medium / deep by message context.
 * Imported by: supabase/functions/staysee-chat/index.ts
 */

import type { UsageTier } from "./cost.ts";
import { TIER_CONFIG } from "./cost.ts";
import type { SafetyCategory } from "./safety.ts";
import {
  analyzeEmotionalTrajectory,
  analyzeResponseDepth,
  detectResponseDepth,
  type DepthReason,
  type EmotionalTrajectory,
  type OpenFigureConfidence,
  type OpenFigureIntensity,
  type OpenFigureKind,
  type OpenFigureState,
  type OpenFigureTrigger,
  type ResponseDepth,
  type ResponseDepthAnalysis,
} from "./responseDepthTrajectory.ts";

export {
  cleanReplyEnding,
  endsAtSentenceBoundary,
  finalizeLengthLimitedContent,
  hasBrokenEnding,
  trimToLastCompleteSentence,
} from "./replyEnding.ts";

export type {
  DepthReason,
  EmotionalTrajectory,
  OpenFigureConfidence,
  OpenFigureIntensity,
  OpenFigureKind,
  OpenFigureState,
  OpenFigureTrigger,
  ResponseDepth,
  ResponseDepthAnalysis,
};

export {
  analyzeEmotionalTrajectory,
  analyzeResponseDepth,
  detectResponseDepth,
};

export interface ResponseBudget extends ResponseDepthAnalysis {
  maxTokens: number;
}

/** Per-depth targets (capped by tier ceiling). */
/** Balanced: 2–4 sentences in identity, enough room to finish a thought. */
const DEPTH_TOKEN_TARGET: Record<ResponseDepth, number> = {
  brief: 380,
  medium: 900,
  deep: 1200,
};

export function computeResponseBudget(
  message: string,
  safetyCategory: SafetyCategory,
  recentHistory: Array<{ role: string; content: string }>,
  tier: UsageTier
): ResponseBudget {
  const analysis = analyzeResponseDepth(message, safetyCategory, recentHistory);
  const tierCeiling = TIER_CONFIG[tier].maxTokensOutput;
  const target = DEPTH_TOKEN_TARGET[analysis.depth];
  const maxTokens = Math.min(tierCeiling, target);

  return { ...analysis, maxTokens };
}

/** Tokens for each automatic continuation segment — short, not another essay. */
export function continuationTokenBudget(
  tier: UsageTier,
  depth: ResponseDepth = "medium",
): number {
  const tierCeiling = TIER_CONFIG[tier].maxTokensOutput;
  const target = Math.floor(DEPTH_TOKEN_TARGET[depth] * 0.55);
  return Math.min(tierCeiling, Math.max(280, target));
}
