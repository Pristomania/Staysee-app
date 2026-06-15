import type { MemoryFieldKey, StructuredMemory } from './memoryUi';
import { emptyMemory, parseConversationMemory } from './memoryUi';
import {
  dedupeMemoryItems,
  normalizeDedupKey,
  type MemoryListItemRef,
} from './memoryDisplay';

export const MEMORY_EMPTY_DISPLAY_MESSAGE =
  'Память пока собирается. Здесь будут только устойчивые факты и важные ориентиры, а не все детали диалогов.';

const MAX_THEMES = 7;
const MAX_OPEN_LOOPS = 5;
const MAX_FACTS = 10;
const MAX_PREFERENCES = 10;
const MAX_PEOPLE = 12;
const MAX_ITEM_LENGTH = 180;

const EMOTIONAL_NARRATIVE_RE =
  /страх|предательств|кризис|тревог|больно|\bад\b|сепарац|плачу|рыдаю|паник|суицид|навредить|умер|смерть|одинок|депресс|насили/i;

const TECHNICAL_OR_HIDDEN_RE =
  /\b(insight|tension|weekly|note|shift|step|progress_entries?|emotion|emotional_state|open_loops?|conversation_summary|user_memory)\b/i;

const NARRATIVE_EVENT_RE =
  /(?:вчера|сегодня|потом|когда|сказал[аи]?|чувствует|устал[аи]?|злюсь|плачу|боюсь|не\s+знаю)/i;

function cleanLine(text: string): string {
  return text
    .replace(/^[-•*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateItem(text: string): string {
  const t = cleanLine(text);
  if (t.length <= MAX_ITEM_LENGTH) return t;
  const cut = t.slice(0, MAX_ITEM_LENGTH - 1).trim();
  return `${cut}…`;
}

function isBlankOrNoise(text: string): boolean {
  const t = cleanLine(text);
  if (!t || t.length < 2) return true;
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (TECHNICAL_OR_HIDDEN_RE.test(t)) return true;
  return false;
}

function isEmotionalNarrative(text: string): boolean {
  return EMOTIONAL_NARRATIVE_RE.test(text);
}

function isLikelyPersonEntity(text: string): boolean {
  const t = cleanLine(text);
  if (!t || isEmotionalNarrative(t)) return false;
  if (t.length > 72) return false;
  if (NARRATIVE_EVENT_RE.test(t) && t.length > 36) return false;
  return true;
}

function isStableFact(text: string): boolean {
  const t = cleanLine(text);
  if (!t || isEmotionalNarrative(t)) return false;
  if (NARRATIVE_EVENT_RE.test(t) && !/живёт|работает|есть\s+сын|есть\s+дочь|замужем|разведен/i.test(t)) {
    return false;
  }
  return t.length >= 4;
}

function isDisplayablePreference(text: string): boolean {
  const t = cleanLine(text);
  if (!t || isEmotionalNarrative(t)) return false;
  return t.length >= 4;
}

function isDisplayableTheme(text: string): boolean {
  const t = cleanLine(text);
  if (!t || isEmotionalNarrative(t)) return false;
  if (t.length > 120) return false;
  return true;
}

function isLiveOpenLoop(text: string, themeKeys: Set<string>): boolean {
  const t = cleanLine(text);
  if (!t || isEmotionalNarrative(t)) return false;
  const key = normalizeDedupKey(t);
  if (themeKeys.has(key)) return false;
  return t.length >= 4 && t.length <= 140;
}

function dedupeStrings(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const text = truncateItem(raw);
    if (isBlankOrNoise(text)) continue;
    const key = normalizeDedupKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** Best-effort: messy plain-text summary → structured shell for display only. */
export function legacyRawToDisplayMemory(raw: string): StructuredMemory {
  const parsed = parseConversationMemory(raw);
  if (parsed) return parsed;

  const lines = raw
    .split(/\n+/)
    .map(cleanLine)
    .filter((l) => l.length > 2 && !l.startsWith('{'));

  const base = emptyMemory();
  for (const line of lines) {
    if (isLikelyPersonEntity(line) && line.length < 50) {
      base.people.push(line);
    } else if (isStableFact(line)) {
      base.important_events.push(line);
    } else if (isDisplayableTheme(line)) {
      base.themes.push(line);
    }
  }
  return base;
}

/**
 * UI-only normalization — does not mutate DB payload.
 * Hides emotional/crisis/narrative noise; caps list sizes; dedupes across sections.
 */
export function normalizeMemoryForDisplay(mem: StructuredMemory): StructuredMemory {
  const people = dedupeStrings(
    mem.people.filter(isLikelyPersonEntity).map(truncateItem),
    MAX_PEOPLE,
  );

  const facts = dedupeStrings(
    mem.important_events.filter(isStableFact).map(truncateItem),
    MAX_FACTS,
  );

  const preferences = dedupeStrings(
    mem.preferences.filter(isDisplayablePreference).map(truncateItem),
    MAX_PREFERENCES,
  );

  const themes = dedupeStrings(
    mem.themes.filter(isDisplayableTheme).map(truncateItem),
    MAX_THEMES,
  );

  const themeKeys = new Set(themes.map(normalizeDedupKey));
  const open_loops = dedupeStrings(
    mem.open_loops.filter((t) => isLiveOpenLoop(t, themeKeys)).map(truncateItem),
    MAX_OPEN_LOOPS,
  );

  return {
    people,
    themes,
    emotional_state: [],
    important_events: facts,
    preferences,
    risks: [],
    open_loops,
    last_updated: mem.last_updated,
  };
}

export function displayMemoryHasContent(mem: StructuredMemory): boolean {
  const keys: MemoryFieldKey[] = [
    'people',
    'themes',
    'important_events',
    'preferences',
    'open_loops',
  ];
  return keys.some((k) => mem[k].length > 0);
}

const FIELD_LIMITS: Partial<Record<MemoryFieldKey, number>> = {
  people: MAX_PEOPLE,
  important_events: MAX_FACTS,
  preferences: MAX_PREFERENCES,
  themes: MAX_THEMES,
  open_loops: MAX_OPEN_LOOPS,
};

function passesFieldFilter(
  fieldKey: MemoryFieldKey,
  text: string,
  themeKeys: Set<string>,
): boolean {
  if (isBlankOrNoise(text)) return false;
  switch (fieldKey) {
    case 'people':
      return isLikelyPersonEntity(text);
    case 'important_events':
      return isStableFact(text);
    case 'preferences':
      return isDisplayablePreference(text);
    case 'themes':
      return isDisplayableTheme(text);
    case 'open_loops':
      return isLiveOpenLoop(text, themeKeys);
    default:
      return false;
  }
}

function themeKeysFromSource(source: StructuredMemory): Set<string> {
  const keys = new Set<string>();
  for (const raw of source.themes) {
    const text = truncateItem(raw);
    if (!isDisplayableTheme(text)) continue;
    const key = normalizeDedupKey(text);
    if (key) keys.add(key);
    if (keys.size >= MAX_THEMES) break;
  }
  return keys;
}

/** Display items with original DB indices so edits still patch source memory. */
export function collectDisplaySectionItems(
  source: StructuredMemory,
  fieldKey: MemoryFieldKey,
): MemoryListItemRef[] {
  const themeKeys = fieldKey === 'open_loops' ? themeKeysFromSource(source) : new Set<string>();
  const items: MemoryListItemRef[] = [];

  source[fieldKey].forEach((raw, index) => {
    const text = truncateItem(raw);
    if (!passesFieldFilter(fieldKey, text, themeKeys)) return;
    items.push({ fieldKey, index, text });
  });

  const limit = FIELD_LIMITS[fieldKey] ?? items.length;
  return dedupeMemoryItems(items).slice(0, limit);
}
