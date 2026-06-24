/**
 * Publishability diagnostics — same rules as isPublishableReply, with reasons.
 */

import {
  endsAtSentenceBoundary,
  hasBrokenEnding,
} from "./replyEnding.ts";
import { isPublishableReply } from "./completeReply.ts";

const LEGACY_GRACEFUL_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

export interface PublishabilityExplanation {
  publishable: boolean;
  reasons: string[];
}

export function explainPublishability(text: string): PublishabilityExplanation {
  const reasons: string[] = [];
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();

  if (!body) {
    reasons.push("empty");
    return { publishable: false, reasons };
  }
  if (body.length < 2) {
    reasons.push("too_short");
    return { publishable: false, reasons };
  }
  if (!endsAtSentenceBoundary(body)) {
    reasons.push("no_sentence_boundary");
  }
  if (hasBrokenEnding(body)) {
    reasons.push("broken_ending");
  }

  const dq = (body.match(/"/g) ?? []).length;
  if (dq % 2 === 1) reasons.push("unbalanced_double_quotes");

  const openGuillemets = (body.match(/«/g) ?? []).length;
  const closeGuillemets = (body.match(/»/g) ?? []).length;
  if (openGuillemets !== closeGuillemets) reasons.push("unbalanced_guillemets");

  if (/\([^)]*$/.test(body)) reasons.push("unclosed_paren");
  if (/\[[^\]]*$/.test(body)) reasons.push("unclosed_bracket");

  const publishable = isPublishableReply(text);
  if (publishable && reasons.length > 0) {
    return { publishable: true, reasons: [] };
  }
  return { publishable, reasons };
}
