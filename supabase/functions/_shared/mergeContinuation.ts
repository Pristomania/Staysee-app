/**
 * Merge continuation chunks without repeating overlapping text at the boundary.
 * Cyrillic-safe: only full-word overlap; on doubt use paragraph separator.
 */

import { sanitizeProfanityInReply } from "./languageGuard.ts";

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

/** True if text ends on a sentence boundary (RU/EN punctuation + optional closers). */
function endsWithSentence(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  return /[.!?…](?:["')\]»]|\p{Extended_Pictographic})*\s*$/u.test(t);
}

/** partA ends mid-clause — comma, colon, or dash (continue with space). */
function endsWithClauseConnector(text: string): boolean {
  return /[—–:,]\s*$/u.test(text.trimEnd());
}

function startsWithLowercase(text: string): boolean {
  return /^[а-яёa-z]/u.test(text.trimStart());
}

export type MergeStrategy =
  | "only_b"
  | "full_prefix_b"
  | "norm_prefix_b"
  | "word_overlap"
  | "duplicate_word"
  | "paragraph_sep"
  | "contains_b";

export interface MergeContinuationResult {
  text: string;
  strategy: MergeStrategy;
  overlapWords: number;
}

/** Exact full-word suffix/prefix overlap only (no partial Cyrillic prefix). */
function mergeAtFullWordBoundary(a: string, b: string): MergeContinuationResult | null {
  const aWords = a.split(/\s+/).filter(Boolean);
  const bWords = b.split(/\s+/).filter(Boolean);
  if (!aWords.length || !bWords.length) return null;

  const lastA = aWords[aWords.length - 1] ?? "";
  const firstB = bWords[0] ?? "";
  if (lastA === firstB && lastA.length >= 2) {
    const head = aWords.slice(0, -1).join(" ");
    const tail = bWords.slice(1).join(" ");
    const text = [head, tail].filter(Boolean).join(" ").trim();
    return { text, strategy: "duplicate_word", overlapWords: 1 };
  }

  for (let n = Math.min(12, aWords.length, bWords.length); n >= 2; n--) {
    const suffix = aWords.slice(-n).join(" ");
    const prefix = bWords.slice(0, n).join(" ");
    if (suffix === prefix) {
      const head = aWords.slice(0, -n).join(" ");
      const tail = bWords.slice(n).join(" ");
      const text = [head, tail].filter(Boolean).join(" ").trim();
      return { text, strategy: "word_overlap", overlapWords: n };
    }
  }
  return null;
}

function joinWithParagraphSeparator(a: string, b: string): MergeContinuationResult {
  let joined: string;
  if (endsWithSentence(a)) {
    joined = `${a}\n\n${b}`;
  } else if (endsWithClauseConnector(a)) {
    joined = `${a} ${b}`;
  } else if (startsWithLowercase(b)) {
    joined = `${a} ${b}`;
  } else {
    joined = `${a}.\n\n${b}`;
  }
  const text = stripOrphanContinueMarkers(joined.trim());
  return { text, strategy: "paragraph_sep", overlapWords: 0 };
}

/** Safe merge for model continuation (partA + partB). */
export function mergeContinuationWithoutOverlap(
  partA: string,
  partB: string
): MergeContinuationResult {
  const a = partA.trimEnd();
  const rawB = partB.trimStart();
  const b = stripContinuationPrefix(rawB);
  if (!a) {
    return { text: b || rawB, strategy: "only_b", overlapWords: 0 };
  }
  if (!b) {
    return { text: a, strategy: "paragraph_sep", overlapWords: 0 };
  }

  if (endsWithSentence(a) && b.startsWith(a)) {
    return {
      text: stripOrphanContinueMarkers(b),
      strategy: "full_prefix_b",
      overlapWords: 0,
    };
  }

  const aNorm = normalizeForCompare(a);
  const bNorm = normalizeForCompare(b);
  if (
    endsWithSentence(a) &&
    bNorm.startsWith(aNorm) &&
    b.length >= a.length
  ) {
    return {
      text: stripOrphanContinueMarkers(b),
      strategy: "norm_prefix_b",
      overlapWords: 0,
    };
  }

  const wordMerged = mergeAtFullWordBoundary(a, b);
  if (wordMerged) {
    return {
      text: stripOrphanContinueMarkers(wordMerged.text),
      strategy: wordMerged.strategy,
      overlapWords: wordMerged.overlapWords,
    };
  }

  if (b.length >= 24 && aNorm.includes(bNorm)) {
    return { text: stripOrphanContinueMarkers(a), strategy: "contains_b", overlapWords: 0 };
  }

  return joinWithParagraphSeparator(a, b);
}

function paragraphExtendsPrevious(prev: string, next: string): boolean {
  const p = stripContinuationPrefix(next.trim());
  const pr = prev.trim();
  if (!p || !pr) return false;
  if (/^(\.{2,}|…)/.test(p)) return true;
  if (!endsWithSentence(pr)) return false;
  if (p.startsWith(pr) || normalizeForCompare(p).startsWith(normalizeForCompare(pr))) {
    return true;
  }
  return false;
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
      out[out.length - 1] = mergeContinuationWithoutOverlap(prev, p).text;
    } else {
      out.push(p);
    }
  }
  return polishAssistantOutput(stripOrphanContinueMarkers(out.join("\n\n")));
}
