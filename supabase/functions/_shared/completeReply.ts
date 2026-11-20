/**
 * What counts as a finished reply, and what is done about one that was cut.
 *
 * The rule (owner's decision, 20.11.2026): a reply the model finished on its own is shown as it is; a reply the model was cut in
 * (finish_reason "length") is continued once, and if it still stops short of a sentence mark it is trimmed to the last mark. No lists
 * of words, no repair, no second generation for a reply that stopped by itself.
 */

import {
  endsAtSentenceBoundary,
  hasBrokenEnding,
  trimToLastCompleteSentence,
} from "./replyEnding.ts";

const LEGACY_GRACEFUL_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

/** Max silent continue segments when the model hits output limits. */
export const MAX_AUTO_CONTINUE_SEGMENTS = 1;

/** Extra short calls to close the last 1–2 sentences (only after a continuation that was itself cut). */
export const MAX_FINALIZE_ATTEMPTS = 2;

export const AUTO_CONTINUE_USER_PROMPT =
  "Продолжи свой предыдущий ответ с места обрыва. Не повторяй уже сказанное. Не начинай ответ заново. Не добавляй новый финальный блок или пересказ. Допиши мысль до естественного конца — цельным текстом.";

export const FINALIZE_USER_PROMPT =
  "Закончи предыдущий текст ТОЛЬКО последними одним-двумя предложениями. Не повторяй начало. Обязательно закончи точкой.";

/** The reasons with which a model says it finished by itself (providers name it differently). */
const NATURAL_STOP_REASONS = new Set(["stop", "end_turn", "end", "eos", "stop_sequence", "completed", "complete"]);

/** The model stopped on its own (not cut by a length limit, a filter or an error): its reply is complete whatever its last character is. */
export function isNaturalStop(finishReason?: string | null): boolean {
  return typeof finishReason === "string" && NATURAL_STOP_REASONS.has(finishReason.trim().toLowerCase());
}

function structurallyFinished(body: string): boolean {
  return endsAtSentenceBoundary(body) && !hasBrokenEnding(body);
}

/**
 * Whether a reply can be shown. A reply the model finished on its own always can (if it is not empty). Otherwise (cut by length, or
 * the reason is not known) it can when it ends on a sentence mark or an emoji and not on a dash, colon, comma or semicolon.
 */
export function isPublishableReply(text: string, finishReason?: string | null): boolean {
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();
  if (!body || body.length < 2) return false;
  if (isNaturalStop(finishReason)) return true;
  return structurallyFinished(body);
}

/**
 * Whether provider output was physically truncated and may be continued.
 * Only finish_reason=length: a reply that stopped by itself is never continued.
 */
export function needsAutoContinue(
  content: string,
  finishReason?: string
): boolean {
  const body = content.trim();
  if (!body) return false;
  return finishReason === "length";
}

/**
 * True when text is clearly cut off and may benefit from a finalize segment: it has no sentence mark (or emoji) at the end.
 * Only used after a length continuation (see shouldRunFinalize).
 */
export function isClearlyTruncatedForFinalize(text: string): boolean {
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trimEnd();
  if (!body) return false;
  return !structurallyFinished(body);
}

/** Whether the finalize call should run for the accumulated reply: only after a length continuation that still stops short of a mark. */
export function shouldRunFinalize(
  accumulated: string,
  wasAutoContinued: boolean
): boolean {
  if (!wasAutoContinued) return false;
  return isClearlyTruncatedForFinalize(accumulated);
}

/**
 * Last resort for a reply that was cut by length: trim it to its last sentence mark. A reply the model finished on its own, or whose
 * reason is not known, is never touched (no trimming without being sure it was cut).
 */
export function ensurePublishableReply(content: string, finishReason?: string | null): string {
  const stripped = content.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();
  if (!stripped) return stripped;
  if (finishReason !== "length") return stripped;
  if (structurallyFinished(stripped)) return stripped;

  const trimmed = trimToLastCompleteSentence(stripped);
  if (trimmed !== stripped) return trimmed;

  // No sentence mark to cut to: only take off a dangling mark (a trailing dash, colon, comma or semicolon); the words stay.
  return stripped.replace(/[\s,:;—–-]+$/u, "") || stripped;
}
