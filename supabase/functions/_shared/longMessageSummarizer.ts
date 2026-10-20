import {
  buildLongMessageSummaryRequest,
  parseLongMessageSummaryResponse,
  type LongMessageSummaryResult,
} from "./longMessages.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Makes the short version of a long message with one cheap-model call. It never throws and never waits
 * longer than the time limit: any failure returns null, and the caller then keeps the full text.
 */
export function createLongMessageSummarizer(options: {
  apiKey: string | null | undefined;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): (text: string) => Promise<LongMessageSummaryResult | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (text) => {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildLongMessageSummaryRequest(text)),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return parseLongMessageSummaryResponse(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
