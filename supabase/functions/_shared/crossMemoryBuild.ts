/**
 * Rule-based cross-memory candidate builder (no Supabase / Deno deps).
 */

import {
  classifyCrossMemoryCategory,
  filterCrossMemoryCandidates,
  isBlockedCrossMemoryContent,
  isPromotableToCrossMemory,
  normalizeCrossMemoryContent,
  normalizePeopleFieldToLifeContext,
} from "./crossMemoryPolicy.ts";
import { isFactEvolutionCandidateText } from "./factEvolution.ts";

function itemTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function itemsSimilar(a: string, b: string): boolean {
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

export interface CrossMemoryBuildInput {
  people: string[];
  preferences: string[];
  themes?: string[];
  important_events?: string[];
}

export const CROSS_MEMORY_MAX_CHARS = 420;

export type CrossMemoryType =
  | "preference"
  | "communication"
  | "life_context";

export interface CrossMemoryCandidate {
  memory_type: CrossMemoryType;
  content: string;
  importance: number;
}

/**
 * How important a new row is by its type (the column allows 1..5): a way of talking or a preference 5, a fact about a person 4.
 * The only table: the builders, the model parser and the write all read it. Types that are no longer allowed are not here on purpose.
 */
export const CROSS_MEMORY_TYPE_IMPORTANCE: Record<CrossMemoryType, number> = {
  communication: 5,
  preference: 5,
  life_context: 4,
};

/**
 * The importance to write for a candidate: its own when it is a whole number from 1 to 5, otherwise the one of its type.
 * Never left empty: an empty value would be filled by the column default (3), which is not a decision anyone made.
 */
export function resolveCandidateImportance(candidate: {
  memory_type: string;
  importance?: unknown;
}): number {
  const own = candidate.importance;
  if (typeof own === "number" && Number.isInteger(own) && own >= 1 && own <= 5) return own;
  return CROSS_MEMORY_TYPE_IMPORTANCE[candidate.memory_type as CrossMemoryType] ?? 3;
}

function normalizeSentence(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, CROSS_MEMORY_MAX_CHARS);
}

function dedupeCrossMemoryCandidates(
  candidates: CrossMemoryCandidate[]
): CrossMemoryCandidate[] {
  const out: CrossMemoryCandidate[] = [];
  for (const c of candidates) {
    const content = normalizeCrossMemoryContent(c.content);
    if (!content) continue;
    const dup = out.some(
      (o) =>
        o.memory_type === c.memory_type &&
        (o.content.toLowerCase() === content.toLowerCase() ||
          itemsSimilar(o.content, content))
    );
    if (dup) continue;
    out.push({ ...c, content });
  }
  return out;
}

/** Promote important_events only when they parse as a stable fact-evolution slot. */
export function eventToFactEvolutionCandidate(
  eventText: string
): CrossMemoryCandidate | null {
  const normalized = normalizePeopleFieldToLifeContext(eventText);
  const probe = normalized ?? eventText.replace(/\s+/g, " ").trim();
  if (!probe || !isFactEvolutionCandidateText(probe)) return null;

  const content = normalized ?? normalizeCrossMemoryContent(probe);
  if (!content || isBlockedCrossMemoryContent(content)) return null;
  if (!isPromotableToCrossMemory("life_context", content)) return null;

  return { memory_type: "life_context", content, importance: CROSS_MEMORY_TYPE_IMPORTANCE.life_context };
}

/** Rule-based: one candidate per allowed people/preference item. */
export function buildCrossMemoryCandidates(
  memory: CrossMemoryBuildInput
): CrossMemoryCandidate[] {
  const out: CrossMemoryCandidate[] = [];

  for (const raw of memory.people) {
    const content = normalizePeopleFieldToLifeContext(raw);
    if (!content || isBlockedCrossMemoryContent(content)) continue;
    out.push({ memory_type: "life_context", content, importance: CROSS_MEMORY_TYPE_IMPORTANCE.life_context });
  }

  for (const raw of memory.important_events ?? []) {
    const candidate = eventToFactEvolutionCandidate(raw);
    if (candidate) out.push(candidate);
  }

  for (const raw of memory.preferences) {
    const content = normalizeSentence(normalizeCrossMemoryContent(raw));
    if (!content || isBlockedCrossMemoryContent(content)) continue;
    const category = classifyCrossMemoryCategory(content);
    if (!category || category === "life_context") continue;
    const memory_type =
      category === "preference" ? "preference" : "communication";
    if (!isPromotableToCrossMemory(memory_type, content)) continue;
    out.push({ memory_type, content, importance: CROSS_MEMORY_TYPE_IMPORTANCE[memory_type] });
  }

  return dedupeCrossMemoryCandidates(
    filterCrossMemoryCandidates(out)
  );
}
