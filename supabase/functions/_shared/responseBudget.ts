/**
 * Completion token budget.
 * Imported by: supabase/functions/staysee-chat/index.ts
 *
 * Nothing here is decided by the words of the message (owner's rule, 20.11.2026): the ceiling of a reply is the ceiling of the tier,
 * and the model decides how much of it to use. The older "short / medium / deep" depth that was read off the wording of the
 * message is gone.
 */

import type { UsageTier } from "./cost.ts";
import { PLANS } from "./plans.ts";

export {
  cleanReplyEnding,
  endsAtSentenceBoundary,
  finalizeLengthLimitedContent,
  hasBrokenEnding,
  trimToLastCompleteSentence,
} from "./replyEnding.ts";

/** Minimal technical note — ceiling is a boundary, not a target length. */
export const OUTPUT_TOKEN_CEILING_GUIDANCE =
  "Output has a maximum token ceiling. The ceiling is a boundary, not a requested response length. Respond within the available ceiling.";

/** The most tokens one reply may have: the ceiling of the tier. */
export function responseTokenCeiling(tier: UsageTier): number {
  return PLANS[tier].maxTokensOutput;
}

/** Tokens for each automatic continuation segment — short, not another essay. */
export function continuationTokenBudget(tier: UsageTier): number {
  const tierCeiling = responseTokenCeiling(tier);
  return Math.min(tierCeiling, Math.max(280, Math.floor(tierCeiling * 0.55)));
}
