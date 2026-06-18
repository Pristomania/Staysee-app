/**
 * Structured shadow percentage gate — fail-closed rollout control.
 * Pure logic; no Deno / runtime imports.
 */

/** Parse env pct for audit; returns null when missing or invalid. */
export function parseStructuredShadowPct(
  pctEnvValue: string | undefined
): number | null {
  if (pctEnvValue == null) return null;

  const trimmed = pctEnvValue.trim();
  if (trimmed.length === 0) return null;

  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;

  return n;
}

/**
 * Returns true only when pct is in (0, 100] and random() < pct/100.
 * 100 always passes; missing/invalid/0 always false.
 */
export function shouldAttemptShadowByPct(
  pctEnvValue: string | undefined,
  random: () => number = Math.random
): boolean {
  const pct = parseStructuredShadowPct(pctEnvValue);
  if (pct === null || pct === 0) return false;
  if (pct >= 100) return true;
  return random() < pct / 100;
}
