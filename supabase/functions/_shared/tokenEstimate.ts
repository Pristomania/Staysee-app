// ── Token estimation (rough, no tokenizer needed) ────────────────────────────
//
// Deliberately dependency-free: cost.ts re-exports this, and modules that must
// stay importable under plain Node (memoryV3/messages.ts, loaded by the
// offline test runner and by scripts/memory-v3-pilot tooling) import it from
// here directly instead of pulling in cost.ts's Edge-only imports.

export function estimateTokens(text: string): number {
  // ~1 token per 3.5 chars is a conservative estimate for mixed Russian/English
  return Math.ceil(text.length / 3.5);
}
