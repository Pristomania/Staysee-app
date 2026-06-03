/**
 * StaySee — respectful lexicon (no profanity / mild swearing in support context).
 */

export const LANGUAGE_GUARD_PROMPT = `
ЛЕКСИКА (критично, без исключений):
Ты в пространстве эмоциональной и душевной поддержки. Язык — спокойный, уважительный, бережный.
ЗАПРЕЩЕНО любые ругательства, «лёгкая» брань и грубые междометия — в том числе: чёрт, черт, блин, ё-моё, чёрт возьми, damn, hell, shit, fuck и любые производные, обсценную лексику.
Это запрет всегда: при ошибке памяти, растерянности, «живости», извинении, шутке. Брань не делает ответ человечнее — она ранит и ломает доверие.
Признание ошибки без брани: «Поняла — я запуталась.» · «Стоп. Я смешала факты — прости.» · «Ты права, я неверно уловила.» · «Да, я сбилась с линии.»
Не копируй грубую лексику пользователя и не цитируй её, если он процитировал твою ошибку — переформулируй нейтрально.

Если пользователь говорит о вере, ценностях или что такие слова недопустимы — принять спокойно, без споров и без «но я же извинилась». Коротко: «Принимаю. Так больше не буду.» Затем по сути разговора.
`.trim();

/** User signals faith / language boundary — extra guidance for this turn. */
export const LANGUAGE_BOUNDARY_USER_PATTERNS = [
  /верующ/i,
  /вера\b/i,
  /христиан/i,
  /православ/i,
  /католич/i,
  /мусульман/i,
  /не допустим\w* слов/i,
  /недопустим\w* слов/i,
  /ругательн/i,
  /брань/i,
  /мат\b/i,
  /чёрт/i,
  /черт/i,
  /выбил\w* (меня|из)/i,
  /обидел\w* слов/i,
];

export const LANGUAGE_BOUNDARY_GUIDANCE = `
ПОЛЬЗОВАТЕЛЬ ОБОЗНАЧИЛ ГРАНИЦУ ЯЗЫКА (вера, ценности, недопустимость брани):
- Никаких ругательств и «лёгкой» брани в этом и следующих ответах.
- Не оправдывайся длинно. Признай: «Принимаю. Так больше не буду.»
- Не повторяй слово, которое задело (чёрт и т.п.) — даже в кавычках и «я больше не скажу чёрт».
- Вернись к сути беседы одним спокойным вопросом или заземлением, если уместно.
`.trim();

const PROFANITY_REPLACEMENTS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /^[\s]*[Чч][ёе]рт(?:\s+возьми)?[,.!…—–-]*\s*/gimu, replace: "" },
  { pattern: /(?:^|\n)[\s]*[Чч][ёе]рт[,.!…—–-]*\s*/gimu, replace: "\n" },
  { pattern: /\b[Чч][ёе]рт(?:\s+возьми)?\b[,.!…]?\s*/giu, replace: "" },
  { pattern: /\bблин\b[,.!…]?\s*/giu, replace: "" },
  { pattern: /\b[Ёё]-?моё\b[,.!…]?\s*/giu, replace: "" },
  { pattern: /\bёб\b/giu, replace: "" },
  { pattern: /\bбляд\w*\b/giu, replace: "" },
  { pattern: /\bхер\b[,.!…]?\s*/giu, replace: "" },
  { pattern: /\bхрен\b[,.!…]?\s*/giu, replace: "" },
  { pattern: /\bfuck\w*\b/giu, replace: "" },
  { pattern: /\bshit\b/giu, replace: "" },
  { pattern: /\bdamn\b/giu, replace: "" },
  { pattern: /\bhell\b/giu, replace: "" },
];

function tidyAfterRemoval(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[,.!…—–-]+\s*/gm, "")
    .trim();
}

/** Strip profanity from model output before sending to the user. */
export function sanitizeProfanityInReply(text: string): string {
  if (!text?.trim()) return text;
  let out = text;
  for (const { pattern, replace } of PROFANITY_REPLACEMENTS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replace);
  }
  out = tidyAfterRemoval(out);
  if (!out && text.trim()) {
    return "Поняла — я сбилась. Давай продолжим с того, что для тебя сейчас важно.";
  }
  return out;
}

export function userSignalsLanguageBoundary(message: string): boolean {
  return LANGUAGE_BOUNDARY_USER_PATTERNS.some((p) => p.test(message));
}
