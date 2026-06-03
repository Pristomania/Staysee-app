export interface StructuredMemory {
  people: string[];
  themes: string[];
  emotional_state: string[];
  important_events: string[];
  preferences: string[];
  risks: string[];
  open_loops: string[];
  last_updated: string;
}

export type MemoryFieldKey = keyof Omit<StructuredMemory, 'last_updated'>;

export const MEMORY_FIELD_LABELS: Record<MemoryFieldKey, string> = {
  people: 'Люди',
  themes: 'Темы и сюжет',
  emotional_state: 'Состояние',
  important_events: 'Важные события',
  preferences: 'Предпочтения',
  risks: 'Безопасность',
  open_loops: 'Открытые темы',
};

export const GLOBAL_MEMORY_TYPE_LABELS: Record<string, string> = {
  communication: 'Как говорить с человеком',
  preference: 'Предпочтения',
  life_context: 'Контекст жизни',
  insight: 'Важное',
  theme: 'Жизненные темы',
  emotion: 'Эмоциональный фон',
};

export const GLOBAL_MEMORY_PLACEHOLDER =
  'Цельное предложение: контекст жизни, стиль общения, что важно помнить между беседами';

export const GLOBAL_MEMORY_HINT =
  'Сквозная память — связные фразы о вас, а не отдельные слова. Память беседы остаётся короче и привязана к одному чату.';

export function emptyMemory(): StructuredMemory {
  return {
    people: [],
    themes: [],
    emotional_state: [],
    important_events: [],
    preferences: [],
    risks: [],
    open_loops: [],
    last_updated: new Date().toISOString(),
  };
}

export function parseConversationMemory(raw: string | null | undefined): StructuredMemory | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  if (!t.startsWith('{')) return null;
  try {
    const p = JSON.parse(t) as Partial<StructuredMemory>;
    return {
      people: p.people ?? [],
      themes: p.themes ?? [],
      emotional_state: p.emotional_state ?? [],
      important_events: p.important_events ?? [],
      preferences: p.preferences ?? [],
      risks: p.risks ?? [],
      open_loops: p.open_loops ?? [],
      last_updated: p.last_updated ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function serializeConversationMemory(mem: StructuredMemory): string {
  return JSON.stringify({
    ...mem,
    last_updated: new Date().toISOString(),
  });
}

export function memoryHasContent(mem: StructuredMemory): boolean {
  return (Object.keys(MEMORY_FIELD_LABELS) as MemoryFieldKey[]).some(
    (k) => mem[k].length > 0,
  );
}

/** JSON exists but all fields are empty (failed auto-update). */
export function isEmptyMemoryShell(raw: string | null | undefined): boolean {
  const parsed = parseConversationMemory(raw);
  if (!parsed) return false;
  return !memoryHasContent(parsed);
}
