import type { MemoryFieldKey, StructuredMemory } from './memoryUi';

/** UI-only section ids — backend field keys unchanged. */
export type MemoryDisplaySectionId =
  | 'people'
  | 'happening'
  | 'important'
  | 'touching'
  | 'open';

export interface MemoryDisplaySection {
  id: MemoryDisplaySectionId;
  label: string;
  fields: MemoryFieldKey[];
  defaultOpen: boolean;
}

export const MEMORY_DISPLAY_SECTIONS: MemoryDisplaySection[] = [
  { id: 'people', label: 'Люди', fields: ['people'], defaultOpen: true },
  {
    id: 'happening',
    label: 'Что сейчас происходит',
    fields: ['themes', 'important_events'],
    defaultOpen: true,
  },
  { id: 'important', label: 'Что важно', fields: ['preferences'], defaultOpen: false },
  {
    id: 'touching',
    label: 'Что задевает',
    fields: ['emotional_state', 'risks'],
    defaultOpen: false,
  },
  {
    id: 'open',
    label: 'Незавершённые темы',
    fields: ['open_loops'],
    defaultOpen: false,
  },
];

/** Target field when user adds via a display section. */
export const ADD_FIELD_FOR_SECTION: Record<MemoryDisplaySectionId, MemoryFieldKey> = {
  people: 'people',
  happening: 'themes',
  important: 'preferences',
  touching: 'emotional_state',
  open: 'open_loops',
};

export interface MemoryListItemRef {
  fieldKey: MemoryFieldKey;
  index: number;
  text: string;
}

export function normalizeDedupKey(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .trim()
    .toLowerCase();
}

/** Hide near-duplicates on display only — DB unchanged. */
export function dedupeMemoryItems(items: MemoryListItemRef[]): MemoryListItemRef[] {
  const sorted = [...items].sort((a, b) => b.text.length - a.text.length);
  const winners: MemoryListItemRef[] = [];

  for (const item of sorted) {
    const key = normalizeDedupKey(item.text);
    const subsumed = winners.some((w) => {
      const wk = normalizeDedupKey(w.text);
      return wk === key || (wk.length > key.length && wk.includes(key));
    });
    if (subsumed) continue;

    const next = winners.filter((w) => {
      const wk = normalizeDedupKey(w.text);
      return wk !== key && !(key.length > wk.length && key.includes(wk));
    });
    next.push(item);
    winners.length = 0;
    winners.push(...next);
  }

  const winnerKeys = new Set(winners.map((w) => `${w.fieldKey}:${w.index}`));
  return items.filter((i) => winnerKeys.has(`${i.fieldKey}:${i.index}`));
}

export function collectSectionItems(
  mem: StructuredMemory,
  fields: MemoryFieldKey[],
): MemoryListItemRef[] {
  const items: MemoryListItemRef[] = [];
  for (const fieldKey of fields) {
    mem[fieldKey].forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed) items.push({ fieldKey, index, text: trimmed });
    });
  }
  return dedupeMemoryItems(items);
}

export function initialSectionOpenState(): Record<MemoryDisplaySectionId, boolean> {
  return Object.fromEntries(
    MEMORY_DISPLAY_SECTIONS.map((s) => [s.id, s.defaultOpen]),
  ) as Record<MemoryDisplaySectionId, boolean>;
}
