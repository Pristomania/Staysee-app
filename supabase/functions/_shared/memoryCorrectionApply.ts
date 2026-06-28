/**
 * Apply durable memory corrections to structured memory and cross-memory candidates.
 */

import {
  COHABIT_CONFLICT_RE,
  COHABIT_SEPARATE_RE,
  MEMORY_CORRECTION_SUBJECTS,
  RELATIONSHIP_STATUS_RE,
  type MemoryCorrectionSubjectKey,
} from "./memoryCorrectionSubjects.ts";

export interface MemoryCorrectionStructuredMemory {
  people: string[];
  themes: string[];
  emotional_state: string[];
  important_events: string[];
  preferences: string[];
  risks: string[];
  open_loops: string[];
  last_updated: string;
}

export interface DurableMemoryCorrection {
  subject_key: string;
  correction_text: string;
  display_text: string;
  old_text?: string | null;
  scope: "conversation" | "global";
}

const MEMORY_CONTENT_FIELDS: Array<keyof Omit<MemoryCorrectionStructuredMemory, "last_updated">> = [
  "people",
  "themes",
  "emotional_state",
  "important_events",
  "preferences",
  "risks",
  "open_loops",
];

function itemTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function memoryItemsSimilar(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (x === y) return true;
  const minLen = Math.min(x.length, y.length);
  if (minLen >= 10 && (x.includes(y) || y.includes(x))) return true;
  const ax = itemTokens(a);
  const bx = itemTokens(b);
  if (!ax.size || !bx.size) return false;
  let overlap = 0;
  for (const w of ax) {
    if (bx.has(w)) overlap++;
  }
  return overlap / Math.min(ax.size, bx.size) >= 0.65 && overlap >= 3;
}

function dedupeItems(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.replace(/\s+/g, " ").trim();
    if (!item || item === "—") continue;
    if (out.some((o) => memoryItemsSimilar(o, item))) continue;
    out.push(item);
  }
  return out;
}

/** Normalize for conservative delete_fact substring matching (Cyrillic, punctuation, whitespace). */
export function normalizeForDeleteMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'`„“”]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function itemMatchesDeleteTarget(item: string, target: string): boolean {
  const il = normalizeForDeleteMatch(item);
  const tl = normalizeForDeleteMatch(target);
  if (!tl) return false;
  if (il.includes(tl)) return true;
  if (tl.length >= 8 && il.length >= tl.length && tl.includes(il)) return true;
  return memoryItemsSimilar(item, target);
}

function stripCohabitationConflict(items: string[]): string[] {
  return items.filter((item) => !COHABIT_CONFLICT_RE.test(item));
}

function stripTogetherStatus(items: string[]): string[] {
  return items.filter(
    (item) =>
      !COHABIT_CONFLICT_RE.test(item) &&
      !/(?:мы\s+)?(?:вместе|пара|отношения)\b/i.test(item)
  );
}

function applySubjectToMemory<T extends MemoryCorrectionStructuredMemory>(
  mem: T,
  correction: DurableMemoryCorrection
): T {
  const m = { ...mem };

  switch (correction.subject_key as MemoryCorrectionSubjectKey) {
    case MEMORY_CORRECTION_SUBJECTS.cohabitation: {
      for (const field of MEMORY_CONTENT_FIELDS) {
        m[field] = dedupeItems(stripCohabitationConflict(m[field]));
      }
      const override = correction.display_text || "Не живут вместе (раздельное проживание).";
      if (
        !m.important_events.some(
          (e) => COHABIT_SEPARATE_RE.test(e) || /раздельн|не вместе/i.test(e)
        )
      ) {
        m.important_events = dedupeItems([...m.important_events, override]);
      }
      m.people = m.people.map((p) => {
        if (COHABIT_CONFLICT_RE.test(p)) {
          return p.replace(COHABIT_CONFLICT_RE, "живут раздельно").trim();
        }
        return p;
      });
      break;
    }
    case MEMORY_CORRECTION_SUBJECTS.status: {
      for (const field of MEMORY_CONTENT_FIELDS) {
        m[field] = dedupeItems(stripTogetherStatus(m[field]));
      }
      const line = correction.display_text;
      if (!m.important_events.some((e) => RELATIONSHIP_STATUS_RE.test(e))) {
        m.important_events = dedupeItems([...m.important_events, line]);
      }
      break;
    }
    case MEMORY_CORRECTION_SUBJECTS.deleteFact: {
      const target = correction.old_text?.trim() ?? "";
      if (!target) break;
      for (const field of MEMORY_CONTENT_FIELDS) {
        m[field] = m[field].filter((item) => !itemMatchesDeleteTarget(item, target));
      }
      break;
    }
    default:
      break;
  }

  return m;
}

/** Apply all active durable corrections in stable order (delete last). */
export function applyDurableCorrections<T extends MemoryCorrectionStructuredMemory>(
  mem: T,
  corrections: DurableMemoryCorrection[]
): T {
  if (!corrections.length) return mem;

  const ordered = [...corrections].sort((a, b) => {
    const rank = (k: string) =>
      k === MEMORY_CORRECTION_SUBJECTS.deleteFact ? 2 : 1;
    return rank(a.subject_key) - rank(b.subject_key);
  });

  let out = mem;
  for (const c of ordered) {
    out = applySubjectToMemory(out, c);
  }
  return out;
}

export function durableCorrectionsToHintStrings(
  corrections: DurableMemoryCorrection[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of corrections) {
    const line = c.display_text.trim();
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}

/** True if cross-memory sentence contradicts an active correction. */
export function crossMemoryContradictsCorrection(
  content: string,
  corrections: DurableMemoryCorrection[]
): boolean {
  const t = content.trim();
  if (!t) return false;

  for (const c of corrections) {
    switch (c.subject_key) {
      case MEMORY_CORRECTION_SUBJECTS.cohabitation:
        if (COHABIT_CONFLICT_RE.test(t) && !COHABIT_SEPARATE_RE.test(t)) return true;
        break;
      case MEMORY_CORRECTION_SUBJECTS.status:
        if (
          COHABIT_CONFLICT_RE.test(t) ||
          (/(?:мы\s+)?(?:вместе|пара)\b/i.test(t) && !RELATIONSHIP_STATUS_RE.test(t))
        ) {
          return true;
        }
        break;
      case MEMORY_CORRECTION_SUBJECTS.deleteFact: {
        const target = c.old_text?.trim();
        if (target && itemMatchesDeleteTarget(t, target)) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}
