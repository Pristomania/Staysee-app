/**
 * Where the search in the past (the small model before it, the reranker after it) asks when Cloud.ru does not answer.
 *
 * Cloud.ru is the main host of both. When it refuses (the key is rejected, or the balance is empty: on 21.11.2026 an empty balance
 * answered 403 «Project not found», not 402) the app asks OpenRouter, where there is a reserve balance, and keeps doing so for a few
 * minutes without trying Cloud.ru on every message (a refused call costs time). After the pause it asks Cloud.ru again, and goes back
 * to it as soon as it answers. The state lives in the running copy of the function (a new copy starts by asking Cloud.ru).
 *
 * The OpenRouter requests carry the private route (no collection of data, zero retention): the same one as the chat itself.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_RERANK_URL = `${OPENROUTER_BASE_URL}/rerank`;
/** An open model, measured on 21.11.2026 on the made-up conversation of nine months: at the threshold 0.01 it is not worse than the main reranker. */
export const FALLBACK_RERANK_MODEL = "qwen/qwen3-reranker-8b";
/**
 * The score above which a line counts as an answer for the reserve reranker. Its scores are sharper than those of the main one (a wrong line
 * stands near 0.0001, a right one near 0.5-0.9): measured, 0.01 finds 26 of 28 right lines with 1.0 wrong lines per question, 0.03 finds 23.
 */
export const FALLBACK_RERANK_THRESHOLD = 0.01;
/** How long Cloud.ru is left alone after it refused. */
export const CLOUDRU_PAUSE_MS = 5 * 60_000;

export function resolveFallbackRerankThreshold(raw: string | undefined | null): number {
  const value = Number(raw);
  if (raw && Number.isFinite(value) && value > 0 && value < 1) return value;
  return FALLBACK_RERANK_THRESHOLD;
}

let cloudruRefusedAt: number | null = null;
let cloudruLastRefusal: 401 | 402 | 403 | undefined;

/** True while Cloud.ru is left alone because it refused a moment ago. */
export function cloudruIsPaused(now: number = Date.now()): boolean {
  return cloudruRefusedAt !== null && now - cloudruRefusedAt < CLOUDRU_PAUSE_MS;
}

export function pauseCloudru(now: number = Date.now(), status?: 401 | 402 | 403): void {
  cloudruRefusedAt = now;
  if (status) cloudruLastRefusal = status;
}

/** The last refusal of Cloud.ru (401, 402 or 403), for the alert when the reserve cannot answer either. */
export function cloudruLastRefusalStatus(): 401 | 402 | 403 | undefined {
  return cloudruLastRefusal;
}

export function resumeCloudru(): void {
  cloudruRefusedAt = null;
}

/** Test hook: forget what was seen. */
export function resetSearchProvidersForTests(): void {
  cloudruRefusedAt = null;
  cloudruLastRefusal = undefined;
}

/** The OpenRouter key and the headers it wants (the same ones the chat sends). */
export interface OpenRouterAccess {
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

/** Why the reserve was used: Cloud.ru refused now, was left alone after a refusal, or simply did not answer (a timeout, a server error). */
export type SwitchReason = "refused" | "paused" | "unavailable";
