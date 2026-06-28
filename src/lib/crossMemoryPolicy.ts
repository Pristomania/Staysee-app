/**
 * Client mirror of cross-memory admission policy v1
 * (see supabase/functions/_shared/crossMemoryPolicy.ts).
 */

import type { UserMemory } from '../types';

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
    String.raw`\b(?:присутствие|прям(?:от|ота|оту|отой)|предпочита(?:ет|ю).*прям|без\s+совет)`
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

interface PromoteCrossMemoryOptions {
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

export function isAllowedCrossMemoryType(
  memoryType: string,
  mode: "inject" | "promote"
): boolean {
  if (ALLOWED_CROSS_MEMORY_TYPES.has(memoryType)) return true;
  if (mode === "promote") return false;
  return false;
}


export function isAllowedForCrossMemoryUI(row: UserMemory): boolean {
  if (!ALLOWED_CROSS_MEMORY_TYPES.has(row.memory_type)) return false;
  const content = normalizeCrossMemoryContent(row.content);
  if (!content) return false;
  return isPromotableToCrossMemory(row.memory_type, content);
}

export type CrossMemoryAuditVerdict = 'keep' | 'hide' | 'delete';

export function auditCrossMemoryRow(row: UserMemory): CrossMemoryAuditVerdict {
  if (DEPRECATED_CROSS_MEMORY_TYPES.has(row.memory_type)) {
    return 'delete';
  }
  if (!ALLOWED_CROSS_MEMORY_TYPES.has(row.memory_type)) {
    return 'delete';
  }
  const content = normalizeCrossMemoryContent(row.content);
  if (!content || !isPromotableToCrossMemory(row.memory_type, content)) {
    return 'delete';
  }
  return 'keep';
}

export function partitionCrossMemoryRows(rows: UserMemory[]): {
  active: UserMemory[];
  deprecated: UserMemory[];
} {
  const active: UserMemory[] = [];
  const deprecated: UserMemory[] = [];
  for (const row of rows) {
    if (isAllowedForCrossMemoryUI(row)) {
      active.push(row);
    } else {
      deprecated.push(row);
    }
  }
  return { active, deprecated };
}

export const CROSS_MEMORY_UI_GROUP_LABELS: Record<string, string> = {
  life_context: 'Факты профиля',
  communication: 'Стиль общения',
  preference: 'Что помогает в контакте',
};

export const CROSS_MEMORY_DEPRECATED_HINT =
  'Эти записи больше не используются в чате — они относились к динамике отдельных бесед. Можно удалить вручную.';
