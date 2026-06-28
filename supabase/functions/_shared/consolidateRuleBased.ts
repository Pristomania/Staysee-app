/**
 * Rule-based cross-memory consolidation (no Supabase / Deno deps — testable in Node).
 */

import {
  classifyCrossMemoryCategory,
  filterCrossMemoryCandidates,
  isBrokenCrossMemoryFragment,
  isPromotableToCrossMemory,
  normalizeCrossMemoryContent,
} from "./crossMemoryPolicy.ts";
import {
  CROSS_MEMORY_MAX_CHARS,
  type CrossMemoryType,
} from "./crossMemoryBuild.ts";

export interface ConsolidateRowInput {
  memory_type: string;
  content: string;
}

function normalizeSentence(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, CROSS_MEMORY_MAX_CHARS);
}

function normalizeForDedupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/g, "")
    .trim();
}

/** Collapse exact/near-exact duplicates within the same memory_type only. */
function rowsSimilar(a: string, b: string): boolean {
  const x = normalizeForDedupe(a);
  const y = normalizeForDedupe(b);
  if (x === y) return true;
  const minLen = Math.min(x.length, y.length);
  if (minLen >= 12 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

/** One output row per distinct allowed input row; no cross-type merge. */
export function consolidateRowsRuleBased(
  rows: ConsolidateRowInput[]
): Array<{ memory_type: CrossMemoryType; content: string }> {
  const out: Array<{ memory_type: CrossMemoryType; content: string }> = [];
  for (const r of rows) {
    const content = normalizeSentence(normalizeCrossMemoryContent(r.content));
    if (!content || isBrokenCrossMemoryFragment(content)) continue;

    let memoryType = r.memory_type as CrossMemoryType;
    const category = classifyCrossMemoryCategory(content);
    if (!category) continue;
    if (category === "communication" || category === "preference") {
      memoryType = category;
    } else {
      memoryType = "life_context";
    }
    if (!isPromotableToCrossMemory(memoryType, content)) continue;
    if (out.some((o) => o.memory_type === memoryType && rowsSimilar(o.content, content))) {
      continue;
    }
    out.push({ memory_type: memoryType, content });
  }
  return filterCrossMemoryCandidates(out) as Array<{
    memory_type: CrossMemoryType;
    content: string;
  }>;
}
