/**
 * Client mirror of cross-memory policy (see supabase/functions/_shared/crossMemoryPolicy.ts).
 */

import type { UserMemory } from '../types';

export const ALLOWED_CROSS_MEMORY_TYPES = new Set([
  'life_context',
  'communication',
  'preference',
]);

export const DEPRECATED_CROSS_MEMORY_TYPES = new Set([
  'theme',
  'emotion',
  'insight',
]);

const DYNAMIC_CONTENT_RE = [
  /страх/i,
  /тревог/i,
  /истощ/i,
  /кризис/i,
  /предательств/i,
  /сепарац/i,
  /эмоциональн/i,
  /пережива/i,
  /боится/i,
  /боитесь/i,
  /боль/i,
  /страдан/i,
  /повторяющиеся жизненные темы/i,
  /эмоциональный фон/i,
  /конфликт/i,
  /напряжен/i,
  /незаверш/i,
  /саморазрушен/i,
  /выгоран/i,
  /изоляц/i,
  /не\s+доверя/i,
  /сложная и эмоционально/i,
  /потер[яи]\s+контрол/i,
];

const NARRATIVE_EVENT_RE = [
  /сказала,\s*что/i,
  /разговор\s+с/i,
  /не\s+попытал/i,
  /съехали/i,
  /стали\s+парой/i,
  /жила\s+втроем/i,
  /почти\s+месяц/i,
  /обследован/i,
  /намек\s+на/i,
  /нестандартн/i,
  /съемн/i,
];

export function isBlockedCrossMemoryContent(content: string): boolean {
  const t = content.trim();
  if (!t) return true;
  return DYNAMIC_CONTENT_RE.some((re) => re.test(t));
}

export function isStableLifeFact(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  if (isBlockedCrossMemoryContent(t)) return false;
  if (NARRATIVE_EVENT_RE.some((re) => re.test(t))) return false;
  return true;
}

export function isStablePeopleFact(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isBlockedCrossMemoryContent(t)) return false;
  return true;
}

function isAllowedLifeContextContent(content: string): boolean {
  const t = content.trim();
  if (t.length < 40) return isStablePeopleFact(t);
  return isStableLifeFact(t);
}

export function isAllowedForCrossMemoryUI(row: UserMemory): boolean {
  if (!ALLOWED_CROSS_MEMORY_TYPES.has(row.memory_type)) return false;
  if (isBlockedCrossMemoryContent(row.content)) return false;
  if (row.memory_type === 'life_context' && !isAllowedLifeContextContent(row.content)) {
    return false;
  }
  return true;
}

export type CrossMemoryAuditVerdict = 'keep' | 'hide' | 'delete';

export function auditCrossMemoryRow(row: UserMemory): CrossMemoryAuditVerdict {
  if (DEPRECATED_CROSS_MEMORY_TYPES.has(row.memory_type)) {
    return 'delete';
  }
  if (!ALLOWED_CROSS_MEMORY_TYPES.has(row.memory_type)) {
    return 'delete';
  }
  if (isBlockedCrossMemoryContent(row.content)) {
    return 'delete';
  }
  if (row.memory_type === 'life_context' && !isAllowedLifeContextContent(row.content)) {
    return 'hide';
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
