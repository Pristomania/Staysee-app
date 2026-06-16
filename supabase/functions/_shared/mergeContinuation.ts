/**
 * Merge continuation chunks without repeating overlapping text at the boundary.
 * Cyrillic-safe: full-word overlap, partial-word continuation, list dedupe.
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

function capitalizeFirstLetter(text: string): string {
  const t = text.trimStart();
  if (!t) return text;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export type MergeStrategy =
  | "only_b"
  | "full_prefix_b"
  | "norm_prefix_b"
  | "word_overlap"
  | "duplicate_word"
  | "partial_word"
  | "list_dedupe"
  | "paragraph_sep"
  | "contains_b";

export interface MergeContinuationResult {
  text: string;
  strategy: MergeStrategy;
  overlapWords: number;
}

/** Map normalized compare index → original string offset. */
function normalizedIndexToCharOffset(original: string, normIdx: number): number {
  let norm = "";
  for (let i = 0; i < original.length; i++) {
    if (norm.length >= normIdx) return i;
    const ch = original[i];
    if (/\s/u.test(ch)) {
      if (!norm.endsWith(" ")) norm += " ";
    } else {
      norm += ch.toLowerCase();
    }
  }
  return original.length;
}

interface WordRun {
  head: string;
  letters: string;
  trailingPunct: string;
}

function parseLastWordRun(text: string): WordRun | null {
  const t = text.trimEnd();
  const m = t.match(/^(.*?)([а-яёa-z]+)([.!?…,;:]{0,3})$/iu);
  if (!m?.[2]) return null;
  return { head: m[1], letters: m[2], trailingPunct: m[3] ?? "" };
}

function parseFirstWordRun(text: string): { letters: string; punct: string; rest: string } | null {
  const m = text.trimStart().match(/^([а-яёa-z]+)([,.!?…:;]{0,3})?(.*)$/isu);
  if (!m?.[1]) return null;
  return { letters: m[1], punct: m[2] ?? "", rest: m[3] ?? "" };
}

/** False sentence end: short fragment + period (e.g. «изб.»). */
function isFalseSentenceEnd(run: WordRun): boolean {
  return run.trailingPunct === "." && run.letters.length <= 5;
}

/**
 * Mid-word join: «момен» + «т,» → «момент,»; «изб.» + «ранных» → «избранных».
 */
function mergeAtPartialWordBoundary(a: string, b: string): MergeContinuationResult | null {
  const last = parseLastWordRun(a);
  const first = parseFirstWordRun(b);
  if (!last || !first) return null;

  const { head, letters: partial, trailingPunct } = last;
  const { letters: cont, punct: bPunct, rest: bRest } = first;

  if (cont.length < 1 || cont.length > 8) return null;
  if (!/^[а-яёa-z]/u.test(cont)) return null;

  const midWord = trailingPunct === "" || isFalseSentenceEnd(last);
  if (!midWord) return null;

  if (trailingPunct === "" && endsWithSentence(a)) return null;
  if (partial.length >= 8 && trailingPunct === ".") return null;

  const mergedWord = partial + cont;
  if (mergedWord.length > 40) return null;

  const afterFirst = b.trimStart().slice(first.letters.length + bPunct.length);
  const spacer =
    head.length > 0 && !/\s$/u.test(head) && !afterFirst.startsWith(",") ? " " : "";
  const text = `${head}${spacer}${mergedWord}${bPunct}${afterFirst}`.trim();

  return { text, strategy: "partial_word", overlapWords: 0 };
}

/**
 * B repeats A's tail with a fuller version — drop truncated tail, keep B.
 */
function mergeRepeatedContinuation(a: string, b: string): MergeContinuationResult | null {
  const bClean = stripContinuationPrefix(b.trim());
  const aNorm = normalizeForCompare(a);
  const bNorm = normalizeForCompare(bClean);
  if (bNorm.length < 24) return null;

  for (let probe = Math.min(100, bNorm.length); probe >= 20; probe -= 1) {
    const marker = bNorm.slice(0, probe);
    const idx = aNorm.lastIndexOf(marker);
    if (idx < 0) continue;

    const aTail = aNorm.slice(idx);
    if (!bNorm.startsWith(aTail) && aNorm.slice(idx + probe).length > 35) continue;

    const aAfterMarker = aNorm.slice(idx + probe);
    if (aAfterMarker.length > 40) continue;

    const cutPos = normalizedIndexToCharOffset(a, idx);
    let head = a.slice(0, cutPos).trimEnd();
    head = head.replace(/[—–-]\s*$/u, "").trimEnd();

    const joined = head ? `${head}\n\n${bClean}` : bClean;
    return {
      text: stripOrphanContinueMarkers(joined),
      strategy: "list_dedupe",
      overlapWords: 0,
    };
  }

  return null;
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
  const bOut = startsWithLowercase(b) && endsWithSentence(a)
    ? capitalizeFirstLetter(b)
    : b;

  if (endsWithSentence(a)) {
    joined = `${a}\n\n${bOut}`;
  } else if (endsWithClauseConnector(a)) {
    joined = `${a} ${b}`;
  } else if (startsWithLowercase(b)) {
    joined = `${a} ${b}`;
  } else {
    joined = `${a}.\n\n${bOut}`;
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

  const listDedupe = mergeRepeatedContinuation(a, b);
  if (listDedupe) return listDedupe;

  const partialWord = mergeAtPartialWordBoundary(a, b);
  if (partialWord) {
    return {
      text: stripOrphanContinueMarkers(partialWord.text),
      strategy: partialWord.strategy,
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

const LONG_REPLY_MIN_CHARS = 1200;
const NUMBERED_BLOCK_RE = /(?<!\n\n)(\s)(?=\d+\.\s+(?:[А-ЯA-ZЁ«"(\[]|[A-Z"(\[]))/gu;
const PRO_HEADER_RE = /(?<!\n\n)(\.\s+)(?=Про\s+[а-яёa-z])/giu;

/**
 * Insert paragraph breaks in long wall-of-text replies (no prompt change).
 * Only when text is long and has almost no existing `\n\n`.
 */
export function normalizeLongReplyParagraphs(text: string): string {
  const t = text.trim();
  if (t.length < LONG_REPLY_MIN_CHARS) return t;

  const paraBreaks = (t.match(/\n\n/g) ?? []).length;
  if (paraBreaks >= 3) return t;
  if (paraBreaks >= 1 && t.length < 2000) return t;

  let out = t.replace(NUMBERED_BLOCK_RE, "\n\n");
  out = out.replace(PRO_HEADER_RE, ".\n\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Normal path: profanity filter + optional long-reply paragraph normalization. */
export function polishAssistantOutput(text: string): string {
  const cleaned = sanitizeProfanityInReply(text.trim());
  return normalizeLongReplyParagraphs(cleaned);
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
