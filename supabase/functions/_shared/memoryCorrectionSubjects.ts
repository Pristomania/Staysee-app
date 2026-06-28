/** Shared subject keys and patterns for durable memory corrections v1. */

export const MEMORY_CORRECTION_SUBJECTS = {
  cohabitation: "relationship.cohabitation",
  status: "relationship.status",
  deleteFact: "memory.delete_fact",
} as const;

export type MemoryCorrectionSubjectKey =
  (typeof MEMORY_CORRECTION_SUBJECTS)[keyof typeof MEMORY_CORRECTION_SUBJECTS];

export type MemoryCorrectionScope = "conversation" | "global";

/** Living-together claims contradicted by separate-living corrections. */
export const COHABIT_CONFLICT_RE =
  /жив(?:[уё]м?|ут|(?:ёт|ет))\s+вместе|вместе\s+жив|одной\s+(квартир|дом)|прожива.*вместе\s+с\s+(?:ним|нею|муж|партн)|съехались|одна\s+семья|живём\s+вместе|живем\s+вместе/i;

/** Fabrication accusations — not durable in v1 (ephemeral hints only). */
export const FABRICATION_ACCUSATION_RE =
  /(?:ты\s+)?(?:придумал|придумала|выдумал|выдумала|фантаз|додумал|додумала)/i;

/** User signals separate living / not together (cohabitation). */
export const COHABIT_SEPARATE_RE =
  /не\s+живу|не\s+живём|не\s+живем|не\s+прожива|раздельно|отдельно\s+жив|не\s+одной\s+семь|живут\s+раздельно|разное\s+жиль/i;

/** Relationship status: not a couple / broke up. */
export const RELATIONSHIP_STATUS_RE =
  /(?:мы\s+)?не\s+вместе|(?:мы\s+)?расстал|(?:мы\s+)?не\s+пара|больше\s+не\s+вместе|не\s+состоим\s+в\s+отношениях/i;

/** Partner / relationship context within message. */
export const PARTNER_CONTEXT_RE =
  /(?:мужчин|партн[её]р|муж\b|супруг|парень|девушк|мы\s+с\s+(?:ним|нею|н[её]))/i;

/** Explicit global scope markers. */
export const GLOBAL_SCOPE_RE =
  /(?:^|[\s,.!?—–-])(?:везде|в\s+моей\s+памяти|запомни\s+в\s+целом|вообще|для\s+всех\s+диалогов)(?:[\s,.!?:—–-]|$)/i;

export const DELETE_FACT_COMMAND_RE =
  /(?:^|[\s,.!?—–-])(?:удали\s+из\s+памяти|забудь\s+что|не\s+запоминай)(?:\s|:)/i;

export const COHABIT_CORRECTION_PHRASE_RE =
  /(?:нет,?\s*)?(?:мы\s+)?не\s+жив(?:ём|ем)|(?:мы\s+)?жив(?:ём|ем)\s+отдельно|(?:на\s+самом\s+деле\s+)?(?:мы\s+)?жив(?:ём|ем)\s+раздельно/i;

export const MAX_CORRECTION_TEXT = 420;
export const MAX_DISPLAY_TEXT = 280;

export function normalizeCorrectionLine(text: string, maxLen: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function buildDisplayText(fullText: string): string {
  const t = normalizeCorrectionLine(fullText, MAX_DISPLAY_TEXT);
  return t.length >= 3 ? t : fullText.trim().slice(0, MAX_DISPLAY_TEXT);
}

export function wantsGlobalScope(message: string): boolean {
  return GLOBAL_SCOPE_RE.test(message);
}
