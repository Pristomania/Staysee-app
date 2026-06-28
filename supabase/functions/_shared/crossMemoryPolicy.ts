/**
 * Cross-memory (user_memory) admission policy v1.
 * Shared gate for write-path and injection-path.
 */

import { collapseEvolvedLifeContextRows } from "./factEvolution.ts";

export type AllowedCrossMemoryType = "life_context" | "communication" | "preference";
export type DeprecatedCrossMemoryType = "theme" | "emotion" | "insight";

export interface CrossMemoryCandidateLike {
  memory_type: string;
  content: string;
}

export const ALLOWED_CROSS_MEMORY_TYPES = new Set<string>([
  "life_context",
  "communication",
  "preference",
]);

export const DEPRECATED_CROSS_MEMORY_TYPES = new Set<string>([
  "theme",
  "emotion",
  "insight",
]);

/** JS `\b` is ASCII-only; build Unicode-aware patterns for Cyrillic. */
function uRx(source: string, flags = "iu"): RegExp {
  const parts = source.split("\\b");
  let body = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      body +=
        i % 2 === 1
          ? String.raw`(?<![\p{L}\p{N}])`
          : String.raw`(?![\p{L}\p{N}])`;
    }
    body += parts[i];
  }
  return new RegExp(body, flags);
}

const DISPLAY_PREFIX_RES = [
  /^в\s+жизни\s+пользователя\s+значимы\s+люди:\s*/iu,
  /^в\s+жизни\s+пользователя\s+значимы:\s*/iu,
  /^в\s+общении\s+важно:\s*/iu,
  /^предпочтения\s+в\s+общении:\s*/iu,
  /^пользователю\s+важно\s+в\s+диалоге:\s*/iu,
];

const BLOCKED_CROSS_MEMORY_RES = [
  uRx(String.raw`\b(?:купил[аи]?|покупал[аи]?|покупала)\b.*\bкурс`),
  uRx(String.raw`\bкурс\b.*\b(?:преподав|учител)`),
  uRx(String.raw`\bпреподав`),
  uRx(String.raw`\b(?:сегодня|вчера|сейчас|на\s+этой\s+неделе)\b`),
  uRx(String.raw`\b(?:красн|цвет|одежд|яркост|наряд)\b`),
  uRx(String.raw`\b(?:депресс|тревог|кризис|паник|самоповреж|суицид)\b`),
  uRx(
    String.raw`\b(?:сомнева(?:ет|ется|юсь)|боюсь\s+продав|можно\s+ли\s+продав)\b.*\b(?:продукт|staysee|стэйси)`
  ),
  uRx(String.raw`\b(?:племянниц|племянник).*(?:пар[уа]|сыном|создал|причин)`),
  uRx(String.raw`\b(?:создал[аи]?|стали)\s+пар`),
  /\?/u,
  uRx(String.raw`\b(?:growth|journey)\b`),
  uRx(String.raw`\b(?:путь\s+к\s+сцене)\b`),
  uRx(String.raw`\b(?:рост|трансформац|исцелен)\b`),
  uRx(String.raw`\b(?:insight|tension|weekly|note)\b`),
];

const LIFE_CONTEXT_CATEGORY_RES = [
  uRx(
    String.raw`\b(?:у\s+)?(?:пользователя\s+)?(?:есть|имеет)\s+(?:сын|дочь|дети|ребёнок|ребенок)`
  ),
  uRx(String.raw`\b(?:сын|дочь|дети|ребёнок|ребенок)\b`),
  uRx(
    String.raw`\b(?:муж|жена|партн[ёе]р|бывш(?:ий|ая)\s+муж|мама|папа|бабушка|дедушка)\b`
  ),
  uRx(String.raw`\b(?:собака|кот|кошка|питомец)\b`),
  uRx(String.raw`\bкрис\b`),
  uRx(String.raw`\b(?:живёт|живет|проживает)\s+(?:одн|с\s+|отдельно|раздельно)`),
  uRx(String.raw`\b(?:не\s+жив(?:ёт|ет)\s+вместе|раздельно\s+жив)`),
  uRx(String.raw`\b(?:живём|живем)\s+вместе\b`),
  uRx(String.raw`\b(?:работает\s+над|разрабатывает|создаёт|создает)\b`),
  uRx(String.raw`\b(?:автор|основатель)\b`),
  uRx(String.raw`\b(?:staysee|стэйси|stay\s*see)\b`),
  uRx(String.raw`\b(?:приложени[ея])\b.*\b(?:staysee|стэйси)`),
];

const COMMUNICATION_CATEGORY_RES = [
  uRx(String.raw`\b(?:женск(?:ом|ому|ой|ая)\s+род)`),
  uRx(String.raw`\b(?:мужск(?:ом|ому|ой|ая)\s+род)`),
  uRx(String.raw`\b(?:обращаться|обращайся).*(?:женск|мужск)`),
  uRx(
    String.raw`\b(?:не\s+нужн(?:ы|о)|не\s+хочу|я\s+не\s+хочу)\s+(?:пуст(?:ые|ых)\s+слов|совет\w*)`
  ),
  uRx(
    String.raw`\b(?:присутствие|прям(?:от|ота|оту|отой)|прямо|по\s+делу|предпочита(?:ет|ю).*прям|без\s+совет)`
  ),
  uRx(String.raw`\b(?:не\s+теря(?:й|ть)\s+(?:нить|нитку))`),
  uRx(String.raw`\b(?:коротк(?:ие|их)\s+ответ|меньше\s+вопрос)`),
  uRx(String.raw`\b(?:не\s+спеш|без\s+пустых\s+успок)`),
];

/** Remove repeated display labels from stored cross-memory text. */
export function stripCrossMemoryDisplayPrefixes(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of DISPLAY_PREFIX_RES) {
      if (re.test(t)) {
        t = t.replace(re, "").trim();
        changed = true;
      }
    }
  }
  return t;
}

export function isBrokenCrossMemoryFragment(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 8) return true;
  if (/\.\.$/u.test(t)) return true;
  if (/^[а-яёa-z]{1,14}\.\.$/iu.test(t)) return true;
  if (/^[\p{L}]{1,12}$/u.test(t)) return true;
  return false;
}

export function normalizeCrossMemoryContent(text: string): string {
  let t = stripCrossMemoryDisplayPrefixes(text);
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, 420);
}

export function isBlockedCrossMemoryContent(content: string): boolean {
  const t = normalizeCrossMemoryContent(content);
  if (!t) return true;
  if (isBrokenCrossMemoryFragment(t)) return true;
  if (/,?\s*сейчас\s+в\s+армии/iu.test(t)) return false;
  return BLOCKED_CROSS_MEMORY_RES.some((re) => re.test(t));
}

export function classifyCrossMemoryCategory(
  content: string
): AllowedCrossMemoryType | null {
  const t = normalizeCrossMemoryContent(content);
  if (!t || isBlockedCrossMemoryContent(t)) return null;

  if (COMMUNICATION_CATEGORY_RES.some((re) => re.test(t))) {
    return "communication";
  }
  if (LIFE_CONTEXT_CATEGORY_RES.some((re) => re.test(t))) {
    return "life_context";
  }

  if (
    uRx(
      String.raw`\b(?:важно|предпочитает|нужно)\b.*\b(?:диалог|общени|контакт|staysee|стэйси)`
    ).test(t)
  ) {
    return "preference";
  }

  return null;
}

export interface PromoteCrossMemoryOptions {
  /** Explicit «запомни» bypasses repetition only — not category/safety. */
  explicitRemember?: boolean;
}

export function isPromotableToCrossMemory(
  memoryType: string,
  content: string,
  _opts?: PromoteCrossMemoryOptions
): boolean {
  if (!ALLOWED_CROSS_MEMORY_TYPES.has(memoryType)) return false;

  const normalized = normalizeCrossMemoryContent(content);
  if (!normalized || isBlockedCrossMemoryContent(normalized)) return false;

  const category = classifyCrossMemoryCategory(normalized);
  if (!category) return false;

  if (memoryType === "preference" || memoryType === "communication") {
    return category === "communication" || category === "preference";
  }
  return category === "life_context";
}

/** @deprecated use isPromotableToCrossMemory — no length ≥40 rule. */
export function isStableLifeFact(text: string): boolean {
  return isPromotableToCrossMemory("life_context", text);
}

/** people field → cross only if classifies as life_context. */
export function isStablePeopleFact(text: string): boolean {
  const normalized = normalizeCrossMemoryContent(text);
  if (!normalized || isBlockedCrossMemoryContent(normalized)) return false;
  return classifyCrossMemoryCategory(normalized) === "life_context";
}

/** Normalize short people bullets into stable life_context sentences. */
export function normalizePeopleFieldToLifeContext(text: string): string | null {
  let bare = stripCrossMemoryDisplayPrefixes(text).replace(/\s+/g, " ").trim();
  if (!bare) return null;
  bare = bare.replace(/[.!?…]+$/u, "").trim();

  const tryContent = (phrase: string): string | null => {
    const normalized = normalizeCrossMemoryContent(phrase);
    if (normalized && isPromotableToCrossMemory("life_context", normalized)) {
      return normalized;
    }
    return null;
  };

  if (/^у\s+пользователя\b/i.test(bare) || /^пользователь\b/i.test(bare)) {
    return tryContent(bare);
  }

  const sonAge = bare.match(/^сыну\s+(\d{1,2})$/iu);
  if (sonAge) {
    return tryContent(`сын, ${sonAge[1]} лет`);
  }

  const petNamed = bare.match(/^собаку\s+зовут\s+([\p{L}][\p{L}-]{0,30})$/iu);
  if (petNamed) {
    return tryContent(`есть собака ${petNamed[1]}`);
  }

  if (/^(?:живём|живем)\s+вместе/i.test(bare)) {
    return tryContent(/партн/i.test(bare) ? bare : "живём вместе с партнёром");
  }

  if (/^мы\s+съехались$/iu.test(bare) || /^съехались$/iu.test(bare)) {
    return tryContent("живём вместе с партнёром");
  }

  if (/^у\s+меня\s+есть\s+сын$/iu.test(bare)) {
    return tryContent("есть сын");
  }

  if (/^у\s+меня\s+есть\s+собака$/iu.test(bare)) {
    return tryContent("есть собака");
  }

  const familyPet =
    /^(?:сын|дочь|дети|ребёнок|ребенок)(?:$|[\s,.!?])/iu.test(`${bare} `) ||
    /^(?:собака|кот|кошка|питомец)(?:$|[\s,.!?])/iu.test(`${bare} `) ||
    /\bкрис\b/i.test(bare);

  if (familyPet) {
    const body = bare.replace(/^есть\s+/i, "").trim();
    const singleToken = /^[\p{L}]+$/u.test(body);
    if (singleToken) {
      return tryContent(`У пользователя есть ${body}`);
    }
    return tryContent(body);
  }

  return tryContent(bare);
}

export function isAllowedCrossMemoryType(
  memoryType: string,
  mode: "inject" | "promote"
): boolean {
  if (ALLOWED_CROSS_MEMORY_TYPES.has(memoryType)) return true;
  if (mode === "promote") return false;
  return false;
}

export function filterCrossMemoryCandidate(
  candidate: CrossMemoryCandidateLike
): CrossMemoryCandidateLike | null {
  if (!isAllowedCrossMemoryType(candidate.memory_type, "promote")) {
    return null;
  }
  const content = normalizeCrossMemoryContent(candidate.content);
  if (!content) return null;
  if (!isPromotableToCrossMemory(candidate.memory_type, content)) return null;
  return { memory_type: candidate.memory_type, content };
}

export function filterCrossMemoryCandidates(
  candidates: CrossMemoryCandidateLike[]
): CrossMemoryCandidateLike[] {
  const out: CrossMemoryCandidateLike[] = [];
  for (const c of candidates) {
    const kept = filterCrossMemoryCandidate(c);
    if (kept) out.push(kept);
  }
  return out;
}

export interface CrossMemoryRowLike {
  memory_type: string;
  content: string;
}

export function filterCrossMemoryRowsForInjection<T extends CrossMemoryRowLike>(
  rows: T[]
): T[] {
  const filtered = rows.filter((row) => {
    if (!isAllowedCrossMemoryType(row.memory_type, "inject")) return false;
    const content = normalizeCrossMemoryContent(row.content);
    if (!content) return false;
    return isPromotableToCrossMemory(row.memory_type, content);
  });
  return collapseEvolvedLifeContextRows(filtered);
}

export type CrossMemoryAuditVerdict = "keep" | "hide" | "delete";

export function auditCrossMemoryRow(row: CrossMemoryRowLike): CrossMemoryAuditVerdict {
  if (DEPRECATED_CROSS_MEMORY_TYPES.has(row.memory_type)) {
    return "delete";
  }
  if (!isAllowedCrossMemoryType(row.memory_type, "inject")) {
    return "delete";
  }
  const content = normalizeCrossMemoryContent(row.content);
  if (!content || !isPromotableToCrossMemory(row.memory_type, content)) {
    return "delete";
  }
  return "keep";
}

/** Evaluate explicit «запомни» for cross-memory (category gate still applies). */
export function evaluateExplicitRememberForCrossMemory(message: string): {
  allowed: boolean;
  memoryType?: AllowedCrossMemoryType;
  content?: string;
} {
  const m = message.match(/(?:^|[\s,.!?—–-])запомни[,:\s]+(.+)/iu);
  let payload = m?.[1]?.trim();
  if (!payload) return { allowed: false };
  payload = payload.replace(/^что\s+/i, "").trim();

  const content = normalizeCrossMemoryContent(payload);
  if (!content || isBlockedCrossMemoryContent(content)) {
    return { allowed: false };
  }

  for (const type of ["communication", "preference", "life_context"] as const) {
    if (isPromotableToCrossMemory(type, content, { explicitRemember: true })) {
      return { allowed: true, memoryType: type, content };
    }
  }
  return { allowed: false };
}
