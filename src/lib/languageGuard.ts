/** Client-side mirror of server profanity filter (display + saved messages). */

const PROFANITY_REPLACEMENTS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /^[\s]*[Чч][ёе]рт(?:\s+возьми)?[,.!…—–-]*\s*/gimu, replace: '' },
  { pattern: /(?:^|\n)[\s]*[Чч][ёе]рт[,.!…—–-]*\s*/gimu, replace: '\n' },
  { pattern: /\b[Чч][ёе]рт(?:\s+возьми)?\b[,.!…]?\s*/giu, replace: '' },
  { pattern: /\bблин\b[,.!…]?\s*/giu, replace: '' },
  { pattern: /\b[Ёё]-?моё\b[,.!…]?\s*/giu, replace: '' },
];

function tidyAfterRemoval(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeProfanityInReply(text: string): string {
  if (!text?.trim()) return text;
  let out = text;
  for (const { pattern, replace } of PROFANITY_REPLACEMENTS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replace);
  }
  return tidyAfterRemoval(out);
}
