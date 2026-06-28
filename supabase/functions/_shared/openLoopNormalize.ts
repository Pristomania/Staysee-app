/**
 * Normalize conversation open_loops — process items, not raw user quotes.
 */

const MAX_OPEN_LOOP_CHARS = 80;

const RAW_QUOTE_RE =
  /^(?:я\s+|мне\s+|а\s+как\s+ты|как\s+ты\s+поняла|поможешь|можешь\s+ли|может\s+что)/i;

/** Reject or normalize an open_loop item for conversation_summary storage. */
export function normalizeOpenLoopItem(raw: string): string | null {
  let t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length < 4) return null;

  if (/\?/.test(t)) {
    const normalized = normalizeQuestionLikeLoop(t);
    if (normalized) t = normalized;
    else return null;
  }

  if (RAW_QUOTE_RE.test(t)) return null;
  if (/^["'«»].*["'«»]$/.test(t)) return null;
  if (t.length > MAX_OPEN_LOOP_CHARS) return null;

  t = t.replace(/\?+$/, "").trim();
  if (!t || RAW_QUOTE_RE.test(t)) return null;

  if (!/[.!?…]$/.test(t)) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  return t.length <= MAX_OPEN_LOOP_CHARS ? t : null;
}

function normalizeQuestionLikeLoop(text: string): string | null {
  const t = text.replace(/\?+$/, "").trim();

  if (/внутренн.*критик/i.test(t)) {
    return "Разобраться с внутренним критиком вокруг продукта";
  }

  if (/путь к сцене|признан/i.test(t)) {
    return "Прояснить путь к сцене и признанию";
  }

  if (/^поможешь/i.test(t) || /^можешь/i.test(t)) {
    return null;
  }

  if (/^а\s+как\s+ты/i.test(t) || /^как\s+ты\s+поняла/i.test(t)) {
    return null;
  }

  return null;
}

export function normalizeOpenLoopList(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const normalized = normalizeOpenLoopItem(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (out.some((o) => o.toLowerCase() === key)) continue;
    out.push(normalized);
  }
  return out;
}
