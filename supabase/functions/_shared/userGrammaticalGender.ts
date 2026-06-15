/**
 * Grammatical gender for Russian user addressing — not biological inference.
 */

export type UserGrammaticalGender = "feminine" | "masculine" | "neutral" | "unknown";
export type GenderConfidence = "high" | "low";
export type GenderSource = "memory" | "detector" | "unknown";

export interface GenderMessage {
  role: string;
  content: string;
}

export interface CrossMemoryGenderItem {
  memory_type: string;
  content: string;
}

export interface GenderDetectionInput {
  messages: GenderMessage[];
  conversationPreferences?: string[];
  crossMemoryItems?: CrossMemoryGenderItem[];
}

export interface GenderDetectionResult {
  gender: UserGrammaticalGender;
  confidence: GenderConfidence;
  source: GenderSource;
}

const USER_SCAN_LIMIT = 8;

const FEMININE_EXPLICIT_RE =
  /(?:^|[\s,.:;!?«"(\[])(?:я\s+женщин[аы]|обращай(?:ся|те)?\s+ко\s+мне\s+в\s+женск(?:ом|ой)\s+роде|предпочита(?:ю|ете)\s+(?:женск(?:ий|ого)\s+род|обращение\s+в\s+женск(?:ом|ой)\s+роде))(?:$|[\s,.:;!?»")\]])/iu;

const MASCULINE_EXPLICIT_RE =
  /(?:^|[\s,.:;!?«"(\[])(?:я\s+мужчин[аы]|обращай(?:ся|те)?\s+ко\s+мне\s+в\s+мужск(?:ом|ой)\s+роде|предпочита(?:ю|ете)\s+(?:мужск(?:ий|ого)\s+род|обращение\s+в\s+мужск(?:ом|ой)\s+роде))(?:$|[\s,.:;!?»")\]])/iu;

const NEUTRAL_MEMORY_RE =
  /обращать(?:ся)?\s+нейтрально|нейтральн(?:ое|ый)\s+обращени/i;

const FEMININE_MEMORY_RE =
  /обращать(?:ся)?\s+в\s+женск(?:ом|ой)\s+роде|предпочитает\s+женск(?:ий|ого)\s+род/i;

const MASCULINE_MEMORY_RE =
  /обращать(?:ся)?\s+в\s+мужск(?:ом|ой)\s+роде|предпочитает\s+мужск(?:ий|ого)\s+род/i;

const CYR_BOUNDARY_BEFORE = "(?:^|[\\s,.:;!?«\"(\\[])";
const CYR_BOUNDARY_AFTER = "(?:$|[\\s,.:;!?»\")\\]])";

function fp(pattern: string): RegExp {
  return new RegExp(`${CYR_BOUNDARY_BEFORE}${pattern}${CYR_BOUNDARY_AFTER}`, "iu");
}

const FEMININE_FIRST_PERSON_RE = [
  fp("я\\s+(?:не\\s+)?устал[аи]"),
  fp("я\\s+(?:не\\s+)?пошл[аи]"),
  fp("я\\s+(?:не\\s+)?понял[аи]"),
  fp("я\\s+(?:не\\s+)?родил[аи]сь"),
  fp("я\\s+(?:не\\s+)?был[аи]"),
  fp("я\\s+(?:не\\s+)?готов[аи]"),
  fp("я\\s+(?:не\\s+)?написал[аи]"),
  fp("я\\s+(?:не\\s+)?сказал[аи]"),
  fp("я\\s+(?:не\\s+)?решил[аи]"),
];

const MASCULINE_FIRST_PERSON_RE = [
  fp("я\\s+(?:не\\s+)?устал(?!а)"),
  fp("я\\s+(?:не\\s+)?пош(?:ёл|ел)"),
  fp("я\\s+(?:не\\s+)?понял(?!а)"),
  fp("я\\s+(?:не\\s+)?родился"),
  fp("я\\s+(?:не\\s+)?был(?!а)"),
  fp("я\\s+(?:не\\s+)?готов(?!а)"),
  fp("я\\s+(?:не\\s+)?написал(?!а)"),
  fp("я\\s+(?:не\\s+)?сказал(?!а)"),
  fp("я\\s+(?:не\\s+)?решил(?!а)"),
];

/** Strip third-person reported speech so «он сказал, что устал» does not count. */
function stripThirdPersonClauses(text: string): string {
  return text
    .replace(
      /(?:^|[\s,.:;!?«"(\[])(?:он|она|они|муж|жена|мама|папа|сын|дочь|брат|сестра)\s+[^.!?\n]{0,120}?(?:сказал[аи]?|говорил[аи]?|был[аи]?|устал[аи]?|пош(?:ёл|ел|ла)|понял[аи]?)[^.!?\n]*/giu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n += 1;
  }
  return n;
}

function scanUserMessages(messages: GenderMessage[]): {
  feminine: number;
  masculine: number;
  explicitFeminine: boolean;
  explicitMasculine: boolean;
} {
  const userTexts = messages
    .filter((m) => m.role === "user")
    .slice(-USER_SCAN_LIMIT)
    .map((m) => stripThirdPersonClauses(m.content));

  let feminine = 0;
  let masculine = 0;
  let explicitFeminine = false;
  let explicitMasculine = false;

  for (const raw of userTexts) {
    if (FEMININE_EXPLICIT_RE.test(raw)) explicitFeminine = true;
    if (MASCULINE_EXPLICIT_RE.test(raw)) explicitMasculine = true;
    feminine += countMatches(raw, FEMININE_FIRST_PERSON_RE);
    masculine += countMatches(raw, MASCULINE_FIRST_PERSON_RE);
  }

  return { feminine, masculine, explicitFeminine, explicitMasculine };
}

export function parseGenderFromMemoryTexts(texts: string[]): GenderDetectionResult | null {
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    if (NEUTRAL_MEMORY_RE.test(t)) {
      return { gender: "neutral", confidence: "high", source: "memory" };
    }
    if (FEMININE_MEMORY_RE.test(t)) {
      return { gender: "feminine", confidence: "high", source: "memory" };
    }
    if (MASCULINE_MEMORY_RE.test(t)) {
      return { gender: "masculine", confidence: "high", source: "memory" };
    }
  }
  return null;
}

function detectFromMessages(messages: GenderMessage[]): GenderDetectionResult {
  const { feminine, masculine, explicitFeminine, explicitMasculine } =
    scanUserMessages(messages);

  if (explicitFeminine && !explicitMasculine) {
    return { gender: "feminine", confidence: "high", source: "detector" };
  }
  if (explicitMasculine && !explicitFeminine) {
    return { gender: "masculine", confidence: "high", source: "detector" };
  }
  if (explicitFeminine && explicitMasculine) {
    return { gender: "unknown", confidence: "low", source: "unknown" };
  }

  if (feminine >= 2 && masculine === 0) {
    return { gender: "feminine", confidence: "high", source: "detector" };
  }
  if (masculine >= 2 && feminine === 0) {
    return { gender: "masculine", confidence: "high", source: "detector" };
  }

  if (feminine > 0 && masculine > 0) {
    return { gender: "unknown", confidence: "low", source: "unknown" };
  }

  if (feminine === 1 && masculine === 0) {
    return { gender: "feminine", confidence: "low", source: "detector" };
  }
  if (masculine === 1 && feminine === 0) {
    return { gender: "masculine", confidence: "low", source: "detector" };
  }

  return { gender: "unknown", confidence: "low", source: "unknown" };
}

export function collectMemoryGenderTexts(input: GenderDetectionInput): string[] {
  const texts: string[] = [];
  for (const p of input.conversationPreferences ?? []) {
    if (p?.trim()) texts.push(p.trim());
  }
  for (const item of input.crossMemoryItems ?? []) {
    if (
      item.memory_type === "communication" ||
      item.memory_type === "preference"
    ) {
      if (item.content?.trim()) texts.push(item.content.trim());
    }
  }
  return texts;
}

/** memory preference > detector > unknown */
export function detectUserGrammaticalGender(
  input: GenderDetectionInput
): GenderDetectionResult {
  const memoryTexts = collectMemoryGenderTexts(input);
  const fromMemory = parseGenderFromMemoryTexts(memoryTexts);
  if (fromMemory) return fromMemory;

  return detectFromMessages(input.messages);
}
