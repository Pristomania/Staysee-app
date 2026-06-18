/**
 * Heuristics to discard paraphrased duplicate continuations before merge.
 */

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstPhrase(text: string, maxLen = 80): string {
  const t = text.trim();
  const m = t.match(/^[^.!?…\n]{1,80}/u);
  return normalizeForCompare(m?.[0] ?? t.slice(0, maxLen));
}

function sharedPrefixRatio(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let same = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) same++;
    else break;
  }
  return same / len;
}

function countRepeatedSentences(accumulated: string, continuation: string): number {
  const aSents = splitSentences(accumulated).map(normalizeForCompare);
  const bSents = splitSentences(continuation).map(normalizeForCompare);
  let matched = 0;
  for (const s of bSents.slice(0, 4)) {
    if (s.length < 25) continue;
    if (aSents.some((as) => as === s || as.includes(s) || s.includes(as))) {
      matched++;
    }
  }
  return matched;
}

/**
 * True when continuation looks like a paraphrased re-write of accumulated text.
 */
export function isDuplicateContinuation(
  accumulated: string,
  continuation: string
): boolean {
  const a = accumulated.trim();
  const b = continuation.trim();
  if (!a || !b) return false;

  const aNorm = normalizeForCompare(a);
  const bNorm = normalizeForCompare(b);

  const aFirst = firstPhrase(a);
  const bFirst = firstPhrase(b);
  if (aFirst.length >= 20 && bFirst.length >= 20 && aFirst === bFirst) {
    return true;
  }
  if (aFirst.length >= 20 && bNorm.startsWith(aFirst)) {
    return true;
  }

  const probeLen = Math.min(200, Math.max(120, Math.floor(bNorm.length * 0.45)));
  if (probeLen >= 80) {
    const bProbe = bNorm.slice(0, probeLen);
    if (aNorm.includes(bProbe)) return true;
    const aProbe = aNorm.slice(0, probeLen);
    if (sharedPrefixRatio(aProbe, bProbe) >= 0.65) return true;
  }

  if (countRepeatedSentences(a, b) >= 2) return true;

  if (bNorm.length >= 100) {
    for (let probe = Math.min(100, bNorm.length); probe >= 40; probe -= 5) {
      const marker = bNorm.slice(0, probe);
      if (aNorm.includes(marker)) return true;
    }
  }

  return false;
}
