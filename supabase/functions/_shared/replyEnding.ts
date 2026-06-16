/**
 * Reply ending helpers — pure logic, no Deno/Supabase imports (Node-testable).
 */

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
