/**
 * Cross-memory (user_memory) — only stable profile + contact preferences.
 */

export type AllowedCrossMemoryType = "life_context" | "communication" | "preference";
export type DeprecatedCrossMemoryType = "theme" | "emotion" | "insight";

export interface CrossMemoryCandidateLike {
  memory_type: string;
  content: string;
}

/** Types allowed in prompt injection and new promotion. */
export const ALLOWED_CROSS_MEMORY_TYPES = new Set<string>([
  "life_context",
  "communication",
  "preference",
]);

/** Legacy types — keep in DB, do not inject or auto-promote. */
export const DEPRECATED_CROSS_MEMORY_TYPES = new Set<string>([
  "theme",
  "emotion",
  "insight",
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
  /открыт[ао]?\s+линия/i,
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

/** Block dynamic / situational content from cross-memory. */
export function isBlockedCrossMemoryContent(content: string): boolean {
  const t = content.trim();
  if (!t) return true;
  return DYNAMIC_CONTENT_RE.some((re) => re.test(t));
}

/** important_events → cross only if reads like stable profile fact, not chat plot. */
export function isStableLifeFact(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  if (isBlockedCrossMemoryContent(t)) return false;
  if (NARRATIVE_EVENT_RE.some((re) => re.test(t))) return false;
  return true;
}

/** people → cross only without emotional / crisis framing. */
export function isStablePeopleFact(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isBlockedCrossMemoryContent(t)) return false;
  return true;
}

export function isAllowedCrossMemoryType(
  memoryType: string,
  mode: "inject" | "promote"
): boolean {
  if (ALLOWED_CROSS_MEMORY_TYPES.has(memoryType)) {
    return true;
  }
  if (mode === "promote") return false;
  return false;
}

export function filterCrossMemoryCandidate(
  candidate: CrossMemoryCandidateLike
): CrossMemoryCandidateLike | null {
  if (!isAllowedCrossMemoryType(candidate.memory_type, "promote")) {
    return null;
  }
  if (isBlockedCrossMemoryContent(candidate.content)) {
    return null;
  }
  return candidate;
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
  return rows.filter((row) => {
    if (!isAllowedCrossMemoryType(row.memory_type, "inject")) return false;
    if (isBlockedCrossMemoryContent(row.content)) return false;
    if (row.memory_type === "life_context") {
      const t = row.content.trim();
      if (t.length >= 40 && !isStableLifeFact(t)) return false;
    }
    return true;
  });
}

export type CrossMemoryAuditVerdict = "keep" | "hide" | "delete";

export function auditCrossMemoryRow(row: CrossMemoryRowLike): CrossMemoryAuditVerdict {
  if (DEPRECATED_CROSS_MEMORY_TYPES.has(row.memory_type)) {
    return "delete";
  }
  if (!isAllowedCrossMemoryType(row.memory_type, "inject")) {
    return "delete";
  }
  if (isBlockedCrossMemoryContent(row.content)) {
    return "delete";
  }
  return "keep";
}
