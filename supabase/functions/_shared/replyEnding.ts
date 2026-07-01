/**
 * Reply ending helpers — pure logic, no Deno/Supabase imports (Node-testable).
 */

const LEGACY_GRACEFUL_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

/** Max length for a complete short closure/acknowledgement without terminal punctuation. */
const MAX_SHORT_COMPLETE_UTTERANCE_CHARS = 140;

/** Obvious unfinished analytical / connector tails — not warm closure. */
const UNFINISHED_TRAILING_PHRASE_RE =
  /(?:^|[\s,—–-])(?:и|а|но|что|как|если|когда|где|чтобы|тогда|потому(?:\s+что)?|как\s+будто|о\s+том,?\s+что|про\s+то,?\s+что|это|то|про|о|который|которая|которые|которое|похоже,?)\s*$/iu;

/** Incomplete substantive fragments (not closure-shaped). */
const INCOMPLETE_SUBSTANTIVE_FRAGMENT_RES: RegExp[] = [
  /^ты\s+(?:сегодня\s+)?(?:смогла|смог|могла|мог)\s*$/iu,
  /^ты\s+говоришь\s+о\s+том,\s+что\s*$/iu,
];

/** Warm closure / acknowledgement shapes valid without a final period. */
const CLOSURE_COMPLETE_UTTERANCE_RES: RegExp[] = [
  /^спокойной\s+ночи$/iu,
  /^приятных\s+снов$/iu,
  /^доброй\s+ночи$/iu,
  /^хорошо[.!]?\s+спокойной\s+ночи$/iu,
  /^хорошо[.!]?\s+спи\b[\s\S]{0,100}$/iu,
  /^хорошо[.!]?\s+спи\s+[—–-]\s+это\s+сейчас\s+правильно\.?$/iu,
  /^спасибо,?\s+что\s+[а-яё]{3,}$/iu,
  /^спасибо\b[\s\S]{0,80}$/iu,
  /^хорошо,?\s+что\s+полегче\.?$/iu,
];

function stripTrailingEmoji(text: string): { core: string; hadEmoji: boolean } {
  const m = text.match(
    /^([\s\S]*?)(?:\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F])+$/u
  );
  if (!m?.[1]) return { core: text, hadEmoji: false };
  return { core: m[1].trimEnd(), hadEmoji: true };
}

function hasObviousUnfinishedTail(text: string): boolean {
  if (UNFINISHED_TRAILING_PHRASE_RE.test(text)) return true;
  return INCOMPLETE_SUBSTANTIVE_FRAGMENT_RES.some((re) => re.test(text));
}

function matchesClosureOrAcknowledgementShape(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (CLOSURE_COMPLETE_UTTERANCE_RES.some((re) => re.test(t))) return true;

  const parts = t.split(/(?<=[.!?…])\s+/u).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 3) {
    const last = parts[parts.length - 1]!.trim();
    if (last.length <= 80 && CLOSURE_COMPLETE_UTTERANCE_RES.some((re) => re.test(last))) {
      return true;
    }
  }
  return false;
}

function isLongSubstantiveWithoutBoundary(text: string): boolean {
  const t = text.trim();
  if (t.length <= MAX_SHORT_COMPLETE_UTTERANCE_CHARS) return false;
  if (/[.!?…]/u.test(t)) return false;
  return true;
}

/** Short warm closure / acknowledgement without terminal punctuation or emoji tail. */
export function isCompleteShortUtteranceWithoutTerminalPunctuation(
  text: string
): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_SHORT_COMPLETE_UTTERANCE_CHARS) return false;
  if (/[.!?…]["')\]]*\s*$/u.test(t)) return false;
  if (hasObviousUnfinishedTail(t)) return false;
  if (isLongSubstantiveWithoutBoundary(t)) return false;
  return matchesClosureOrAcknowledgementShape(t);
}

/**
 * Short live phrase + trailing emoji (Core V2). Not closure-list only —
 * requires substantive words and rejects connector / fragment tails.
 */
function isSubstantiveShortPhraseForEmojiTail(core: string): boolean {
  const t = core.trim();
  if (!t || t.length < 4) return false;
  if (t.length > MAX_SHORT_COMPLETE_UTTERANCE_CHARS) return false;
  if (hasObviousUnfinishedTail(t)) return false;
  if (INCOMPLETE_SUBSTANTIVE_FRAGMENT_RES.some((re) => re.test(t))) return false;
  if (isLongSubstantiveWithoutBoundary(t)) return false;
  if (!/\p{L}{2,}/u.test(t)) return false;

  const words = t.match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return false;
  if (words.length === 1 && words[0]!.length < 5) return false;
  return true;
}

function endsWithEmojiAfterCompleteShortPhrase(text: string): boolean {
  const { core, hadEmoji } = stripTrailingEmoji(text);
  if (!hadEmoji || !core) return false;
  if (/[.!?…]["')\]]*\s*$/u.test(core)) return true;
  if (isCompleteShortUtteranceWithoutTerminalPunctuation(core)) return true;
  return isSubstantiveShortPhraseForEmojiTail(core);
}

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
  if (/[.!?…]["')\]]*\s*$/.test(t)) return true;
  if (endsWithEmojiAfterCompleteShortPhrase(t)) return true;
  if (isCompleteShortUtteranceWithoutTerminalPunctuation(t)) return true;
  return false;
}

/** Trim trailing fragment after the last complete sentence. */
export function trimToLastCompleteSentence(text: string): string {
  const t = text.trimEnd();
  const m = t.match(/^([\s\S]*?[.!?…])(?:\s+[^\s.!?……]*)?$/);
  if (m?.[1] && m[1].length >= 12) {
    return m[1].trimEnd();
  }
  return t;
}

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
