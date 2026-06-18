/**
 * Guarantee assistant text is safe to show: full sentence, no mid-word / em-dash cut.
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

/** Extra short calls to close the last 1–2 sentences. */
export const MAX_FINALIZE_ATTEMPTS = 2;

export const AUTO_CONTINUE_USER_PROMPT =
  "Продолжи свой предыдущий ответ с места обрыва. Не повторяй уже сказанное. Допиши мысль до естественного конца — цельным текстом.";

export const FINALIZE_USER_PROMPT =
  "Закончи предыдущий текст ТОЛЬКО последними одним-двумя предложениями. Не повторяй начало. Обязательно закончи точкой.";

export function isPublishableReply(text: string): boolean {
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();
  if (!body || body.length < 2) return false;
  return endsAtSentenceBoundary(body) && !hasBrokenEnding(body);
}

/** Whether another model segment should run before showing the user. */
export function needsAutoContinue(
  content: string,
  finishReason?: string
): boolean {
  const body = content.trim();
  if (!body) return false;
  if (finishReason === "length") return true;
  return !isPublishableReply(body);
}

/** Sentence-ending punctuation — finalize not needed after auto-continue. */
export function endsWithSentencePunctuation(text: string): boolean {
  const t = text.trimEnd();
  return /[.!?…]["')\]]*\s*$/.test(t);
}

/**
 * True when text is clearly cut off and may benefit from a finalize segment.
 */
export function isClearlyTruncatedForFinalize(text: string): boolean {
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trimEnd();
  if (!body) return false;
  if (endsWithSentencePunctuation(body)) return false;

  const dq = (body.match(/"/g) ?? []).length;
  if (dq % 2 === 1) return true;

  const openGuillemets = (body.match(/«/g) ?? []).length;
  const closeGuillemets = (body.match(/»/g) ?? []).length;
  if (openGuillemets !== closeGuillemets) return true;

  if (/\([^)]*$/.test(body) || /\[[^\]]*$/.test(body)) return true;
  if (/[—–:,]\s*$/u.test(body)) return true;
  if (
    /\s(и|а|но|что|как|если|когда|чтобы|для|при|про|на|в|к|с|у|о|от|до|по|за|из|со|об)\s*$/iu.test(
      body
    )
  ) {
    return true;
  }
  if (hasBrokenEnding(body)) return true;

  return false;
}

/** Whether finalize loop should run for the accumulated reply. */
export function shouldRunFinalize(
  accumulated: string,
  wasAutoContinued: boolean
): boolean {
  if (isPublishableReply(accumulated)) return false;
  if (wasAutoContinued) {
    return isClearlyTruncatedForFinalize(accumulated);
  }
  return true;
}

/** Remove only a clearly broken trailing word fragment (autoContinue failure). */
function stripBrokenTrailingFragment(text: string): string {
  if (!hasBrokenEnding(text)) return text;
  const withoutFragment = text.replace(/\s+[^\s.!?…]{1,8}$/u, "").trimEnd();
  if (withoutFragment.length >= 8 && withoutFragment.length < text.length) {
    return withoutFragment;
  }
  return text;
}

function firstCompleteSentence(text: string): string | null {
  const m = text.match(/^([\s\S]*?[.!?…]["')\]]*)/u);
  const head = m?.[1]?.trimEnd();
  if (head && head.length >= 12 && isPublishableReply(head)) return head;
  return null;
}

/**
 * Last resort: trim to last full sentence — never return mid-word or trailing em-dash.
 */
export function ensurePublishableReply(content: string): string {
  const stripped = content.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();
  if (!stripped) return stripped;
  if (isPublishableReply(stripped)) return stripped;

  const trimmed = trimToLastCompleteSentence(stripped);
  if (trimmed.length >= 12 && isPublishableReply(trimmed)) {
    return trimmed;
  }

  const lastPunct = stripped.match(/^([\s\S]*[.!?…]["')\]]*)\s*[^\s.!?…]{0,20}$/u);
  if (lastPunct?.[1] && lastPunct[1].length >= 12 && isPublishableReply(lastPunct[1])) {
    return lastPunct[1].trimEnd();
  }

  const withoutDash = stripped.replace(/\s[—–-]\s*$/u, "").trimEnd();
  if (withoutDash.length >= 12 && isPublishableReply(withoutDash)) {
    return withoutDash;
  }

  const firstSentence = firstCompleteSentence(stripped);
  if (firstSentence) return firstSentence;

  const defragged = stripBrokenTrailingFragment(stripped);
  if (defragged.length >= 12 && isPublishableReply(defragged)) {
    return defragged;
  }

  if (trimmed.length >= 12) return trimmed;
  return defragged.length >= 12 ? defragged : stripped;
}
