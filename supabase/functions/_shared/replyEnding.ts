/**
 * Reply ending helpers — pure logic, no Deno/Supabase imports (Node-testable).
 *
 * The rule (owner's decision, 20.11.2026): an ending is a sentence mark (. ? ! …, possibly followed by a closing quote or bracket) or an
 * emoji. Nothing here looks at WORDS (no lists of connectors, closures or phrases) and nothing cuts a reply by its length. Whether a
 * reply that stopped without a mark is complete is not decided here: a reply the model finished on its own is complete (see
 * completeReply.ts); only a reply the model was cut in (finish_reason "length") is ever trimmed, to its last sentence mark.
 */

const LEGACY_GRACEFUL_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

/** A sentence mark at the end, with closing quotes or brackets after it: «да.», "ладно.", (так.) */
const TERMINAL_MARK_RE = /[.!?…]["'»”’)\]]*\s*$/u;

/** An emoji at the end (a warm reply may end with one instead of a mark). */
const TRAILING_EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}️]\s*$/u;

/** A mark that cuts the text off: a sentence that was broken off at a dash, colon, comma or semicolon. No word is looked at. */
const CUT_AT_MARK_RE = /[,:;—–-]\s*$/u;

/** A sentence mark with its closing quotes/brackets, followed by a space or the end (not the dot inside 3.5 or a.b). */
const SENTENCE_MARK_IN_TEXT_RE = /[.!?…]["'»”’)\]]*(?=\s|$)/gu;

/** Shortest text kept when trimming to the last mark: never trim a reply down to a stub. */
const MIN_TRIMMED_CHARS = 12;

/** A dash, colon, comma or semicolon at the very end: the sentence was cut at a mark. */
export function hasBrokenEnding(text: string): boolean {
  const t = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trimEnd();
  if (!t) return false;
  return CUT_AT_MARK_RE.test(t);
}

/** True if the text ends on a sentence mark (RU/EN punctuation, closers allowed) or on an emoji. */
export function endsAtSentenceBoundary(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return true;
  return TERMINAL_MARK_RE.test(t) || TRAILING_EMOJI_RE.test(t);
}

/** Trim the fragment after the last sentence mark. Unchanged when there is no mark, or the text before it would be a stub. */
export function trimToLastCompleteSentence(text: string): string {
  const t = text.trimEnd();
  let end = -1;
  for (const match of t.matchAll(SENTENCE_MARK_IN_TEXT_RE)) {
    end = (match.index ?? 0) + match[0].length;
  }
  if (end >= MIN_TRIMMED_CHARS) return t.slice(0, end).trimEnd();
  return t;
}

/** Clean the ending of a reply that was cut: to its last sentence mark; nothing else about the text is judged. */
export function cleanReplyEnding(text: string): string {
  const body = text.replace(LEGACY_GRACEFUL_TAIL_RE, "").trim();
  if (!body) return body;
  if (endsAtSentenceBoundary(body)) return body;
  return trimToLastCompleteSentence(body);
}

/** After length limit: clean ending only (no meta «дальше»). */
export function finalizeLengthLimitedContent(
  content: string,
  _mergedFromRetry: boolean
): string {
  void _mergedFromRetry;
  return cleanReplyEnding(content);
}
