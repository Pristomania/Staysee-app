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
  type ResponseDepth,
  type ResponseDepthAnalysis,
} from "./responseDepthTrajectory.ts";

export type {
  DepthReason,
  EmotionalTrajectory,
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

const LEGACY_GRACEFUL_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

/** Trailing word fragment from token limit (e.g. «…в этом мол»). */
export function hasBrokenEnding(text: string): boolean {
  const t = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trimEnd();
  if (!t || endsAtSentenceBoundary(t)) return false;
  if (/[—–-]\s*$/u.test(t)) return true;
  if (/\s[а-яёa-z]{1,5}$/iu.test(t)) return true;
  if (/[,:;—–-]\s*[^\s.!?…]{1,12}$/u.test(t)) return true;
  return false;
}

/** True if text ends on a sentence boundary (RU/EN punctuation). */
export function endsAtSentenceBoundary(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return true;
  return /[.!?…]["')\]]*\s*$/.test(t);
}

/** Trim trailing fragment after the last complete sentence. */
export function trimToLastCompleteSentence(text: string): string {
  const t = text.trimEnd();
  const m = t.match(/^([\s\S]*?[.!?…])(?:\s+[^\s.!?……]*)?$/);
  if (m?.[1] && m[1].length >= 20) {
    return m[1].trimEnd();
  }
  return t;
}

/**
 * Every assistant reply: no «напиши дальше», no cut-off «мол».
 * Ends on a full sentence or is trimmed back to the last one.
 */
/** Remove «Вопрос?» + orphan «Да.» / «Нет.» self-dialogue at the end. */
function stripSelfAnswerTail(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^([\s\S]+?)\n+(Да|Нет|Так|Да,)\.?\s*$/iu);
    if (!m?.[1]) break;
    const head = m[1].trimEnd();
    if (/[?…]\s*$/u.test(head)) t = head;
    else break;
  }
  return t;
}

export function cleanReplyEnding(text: string): string {
  let body = stripSelfAnswerTail(text.replace(LEGACY_GRACEFUL_TAIL_RE, "")).trim();
  if (!body) return body;
  if (endsAtSentenceBoundary(body)) return body;

  const trimmed = trimToLastCompleteSentence(body);
  if (endsAtSentenceBoundary(trimmed)) return trimmed;

  const withoutFragment = body
    .replace(/\s+[^\s.!?…,]{1,6}$/u, "")
    .trimEnd();
  if (endsAtSentenceBoundary(withoutFragment)) return withoutFragment;

  if (trimmed.length >= 40) return trimmed;
  return withoutFragment.length >= 40 ? withoutFragment : trimmed;
}

/** After length limit: clean ending only (no meta «дальше»). */
export function finalizeLengthLimitedContent(
  content: string,
  _mergedFromRetry: boolean
): string {
  return cleanReplyEnding(content);
}
