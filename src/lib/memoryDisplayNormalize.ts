/**
 * Display-only: remove internal role label «пользователь» from memory UI text.
 * Does not affect DB, prompts, or backend injection.
 */

const PROTECTED_TERM_RE = /слово\s+пользователь/i;

const FAMILY_ROLE_USER_RE =
  /(племянница|племянник|сын|дочь|мама|папа|бабушка|дедушка|тётя|тетя|отец|муж|жена|партн[ёе]р)\s+пользователя/giu;

function lowercaseFirstChar(text: string): string {
  if (!text) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Humanize stored memory text for MemoryScreen display only. */
export function normalizeMemoryTextForDisplay(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (!t || PROTECTED_TERM_RE.test(t)) return t;

  t = t.replace(FAMILY_ROLE_USER_RE, "$1");

  t = t.replace(/^У\s+пользователя\s+есть\s+/iu, "есть ");
  t = t.replace(/^У\s+пользователя\s+был[а]?\s+/iu, "был ");
  t = t.replace(/^У\s+пользователя\s+/iu, "");

  t = t.replace(
    /^Партн[ёе]р\s+не\s+жив(?:ёт|ет)\s+с\s+пользователем\s+вместе\.?/iu,
    "партнёр не живёт вместе"
  );

  t = t.replace(/^Пользователю\s+важно\s+/iu, "важно ");
  t = t.replace(/^Пользователь\s+/iu, "");

  t = t.replace(/\s+/g, " ").trim();

  if (/^(?:есть|был|важно|предпочитает|партнёр)\s+/iu.test(t)) {
    t = lowercaseFirstChar(t);
  }

  return t;
}
