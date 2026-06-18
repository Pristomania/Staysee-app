/**
 * Structured turn model allowlist — fail-closed gate for PR3b-3+.
 * Pure logic; no Deno / runtime imports.
 */

const STRUCTURED_TURN_MODEL_ALLOWLIST = new Set([
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
]);

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Returns true only for exact allowlisted OpenAI models after trim + lowercase.
 * Unknown, empty, or unsupported models → false.
 */
export function supportsStructuredTurn(
  modelId: string | null | undefined
): boolean {
  if (modelId == null) return false;

  const normalized = normalizeModelId(modelId);
  if (normalized.length === 0) return false;

  return STRUCTURED_TURN_MODEL_ALLOWLIST.has(normalized);
}

/** Exposed for tests and audit documentation. */
export function getStructuredTurnModelAllowlist(): readonly string[] {
  return [...STRUCTURED_TURN_MODEL_ALLOWLIST].sort();
}
