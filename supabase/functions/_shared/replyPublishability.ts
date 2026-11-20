/**
 * Publishability diagnostics — same rules as isPublishableReply, with reasons.
 */

import {
  endsAtSentenceBoundary,
  hasBrokenEnding,
} from "./replyEnding.ts";
import { isNaturalStop, isPublishableReply } from "./completeReply.ts";

const LEGACY_GRACEFUL_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

export interface PublishabilityExplanation {
  publishable: boolean;
  reasons: string[];
}

export function explainPublishability(text: string, finishReason?: string | null): PublishabilityExplanation {
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();
  const reasons: string[] = [];

  if (!body) {
    reasons.push("empty");
    return { publishable: false, reasons };
  }
  if (body.length < 2) {
    reasons.push("too_short");
  }
  // A reply the model finished on its own is complete whatever its last character is (see completeReply.ts).
  if (!isNaturalStop(finishReason)) {
    if (!endsAtSentenceBoundary(body)) {
      reasons.push("no_sentence_boundary");
    }
    if (hasBrokenEnding(body)) {
      reasons.push("broken_ending");
    }
  }

  const publishable = isPublishableReply(text, finishReason);
  if (!publishable && reasons.length === 0) {
    reasons.push("not_publishable");
  }

  return { publishable, reasons };
}
