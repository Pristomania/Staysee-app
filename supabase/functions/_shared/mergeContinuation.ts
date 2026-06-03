/**
 * Merge continuation chunks without repeating overlapping text at the boundary.
 * Word/prefix only — no short character-level overlap (breaks Cyrillic).
 */

import { sanitizeProfanityInReply } from "./languageGuard.ts";
import { cleanReplyEnding } from "./responseBudget.ts";

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const CONTINUE_LEAD_RE =
  /^(дальше|продолжение|продолжаю|continued|continue)[.!…:,\s-]*/iu;

function stripContinuationPrefix(s: string): string {
  let t = s.replace(/^(\.{2,}|…)\s*/u, "").trimStart();
  while (CONTINUE_LEAD_RE.test(t)) {
    t = t.replace(CONTINUE_LEAD_RE, "").trimStart();
  }
  return t;
}

/** Remove orphan «дальше» the model inserts between continuation chunks. */
export function stripOrphanContinueMarkers(text: string): string {
  return text
    .replace(/([—–-])\s*\n+\s*дальше[.!…:]*\s*\n+\s*/giu, "$1 ")
    .replace(/\n{2,}\s*дальше[.!…:]*\s*\n{2,}/giu, "\n\n")
    .replace(/(^|\n)\s*дальше[.!…:]*\s*(?=\n)/giu, "$1")
    .replace(/\s+дальше[.!…:]*\s+(?=[а-яё])/giu, " ")
    .trim();
}

function endsWithSentence(s: string): boolean {
  return /[.!?…]["')\]]*\s*$/.test(s.trimEnd());
}

/** Suffix of A equals prefix of B — at least two words, or one long word (≥8 chars). */
function mergeAtWordBoundary(a: string, b: string): string | null {
  const aWords = a.split(/\s+/).filter(Boolean);
  const bWords = b.split(/\s+/).filter(Boolean);
  if (!aWords.length || !bWords.length) return null;

  const lastA = aWords[aWords.length - 1] ?? "";
  const firstB = bWords[0] ?? "";
  if (
    lastA.length >= 4 &&
    firstB.startsWith(lastA) &&
    firstB !== lastA &&
    firstB.length <= lastA.length + 24
  ) {
    return [...aWords.slice(0, -1), firstB, ...bWords.slice(1)].join(" ").trim();
  }

  for (let n = Math.min(12, aWords.length, bWords.length); n >= 2; n--) {
    const suffix = aWords.slice(-n).join(" ");
    const prefix = bWords.slice(0, n).join(" ");
    if (suffix === prefix) {
      const head = aWords.slice(0, -n).join(" ");
      const tail = bWords.slice(n).join(" ");
      return [head, tail].filter(Boolean).join(" ").trim();
    }
  }
  return null;
}

/** Safe merge for model continuation (partA + partB). */
export function mergeContinuationWithoutOverlap(partA: string, partB: string): string {
  const a = partA.trimEnd();
  const rawB = partB.trimStart();
  const b = stripContinuationPrefix(rawB);
  if (!a) return b || rawB;
  if (!b) return a;

  if (b.startsWith(a)) return b;
  const aNorm = normalizeForCompare(a);
  const bNorm = normalizeForCompare(b);
  if (bNorm.startsWith(aNorm) && b.length >= a.length) return b;

  const wordMerged = mergeAtWordBoundary(a, b);
  if (wordMerged) return wordMerged;

  if (b.length >= 24 && aNorm.includes(bNorm)) return a;

  if (!endsWithSentence(a)) {
    const joined = `${a} ${b}`.trim();
    return stripOrphanContinueMarkers(joined);
  }
  const joined = `${a}\n\n${b}`.trim();
  return stripOrphanContinueMarkers(joined);
}

function paragraphExtendsPrevious(prev: string, next: string): boolean {
  const p = stripContinuationPrefix(next.trim());
  const pr = prev.trim();
  if (!p || !pr) return false;
  if (/^(\.{2,}|…)/.test(p)) return true;
  if (p.startsWith(pr) || normalizeForCompare(p).startsWith(normalizeForCompare(pr))) {
    return true;
  }
  const prTail = pr.slice(-Math.min(pr.length, 60));
  return (
    p.length < pr.length + 80 &&
    normalizeForCompare(p).startsWith(normalizeForCompare(prTail))
  );
}

/** Normal path: profanity filter only — do not trim sentences (breaks good replies). */
export function polishAssistantOutput(text: string): string {
  return sanitizeProfanityInReply(text.trim());
}

/** Dedupe continuation paragraphs only when next clearly extends previous. */
export function polishMergedReply(text: string): string {
  const cleaned = stripOrphanContinueMarkers(text);
  const paragraphs = cleaned.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) {
    return polishAssistantOutput(paragraphs[0] ?? text);
  }

  const out: string[] = [];
  for (const p of paragraphs) {
    if (out.length === 0) {
      out.push(p);
      continue;
    }
    const prev = out[out.length - 1];
    if (paragraphExtendsPrevious(prev, p)) {
      out[out.length - 1] = mergeContinuationWithoutOverlap(prev, p);
    } else {
      out.push(p);
    }
  }
  return polishAssistantOutput(stripOrphanContinueMarkers(out.join("\n\n")));
}
