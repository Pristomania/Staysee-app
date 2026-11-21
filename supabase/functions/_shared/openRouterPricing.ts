/**
 * OpenRouter pricing fallback (USD per 1M tokens).
 * Updated manually; used when usage.cost is absent from API response.
 * @see https://openrouter.ai/models
 */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** Keys: OpenRouter model id (e.g. anthropic/claude-3.5-haiku) */
export const OPENROUTER_MODEL_PRICING: Record<string, ModelPricing> = {
  "openai/gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "openai/gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "anthropic/claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "anthropic/claude-3.5-haiku": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "anthropic/claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "mistralai/mistral-small": { inputPer1M: 0.2, outputPer1M: 0.6 },
  "mistral-small-latest": { inputPer1M: 0.2, outputPer1M: 0.6 },
  "google/gemini-flash-1.5": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "deepseek/deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
  // Embeddings (the vectors for the memory search): input only, nothing is generated. Without these lines the default price
  // below would be used and overstate the cost fifty times.
  "openai/text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
  "openai/text-embedding-3-large": { inputPer1M: 0.13, outputPer1M: 0 },
  // The model of the search by meaning (open weights, 1024 numbers). OpenRouter, 20.11.2026: $0.01 per 1M input tokens.
  "baai/bge-m3": { inputPer1M: 0.01, outputPer1M: 0 },
  // OpenRouter, 19.11.2026.
  "deepseek/deepseek-v4-pro": { inputPer1M: 0.9, outputPer1M: 1.5 },
  "moonshotai/kimi-k2.6": { inputPer1M: 0.65, outputPer1M: 3.41 },
  // Cloud.ru (Russia), exact capitals: 183 / 732 and 175.68 / 725.9 roubles per 1M tokens, counted at 90 roubles per dollar.
  "deepseek-ai/DeepSeek-V4-Pro": { inputPer1M: 2.033, outputPer1M: 8.133 },
  "moonshotai/Kimi-K2.6": { inputPer1M: 1.952, outputPer1M: 8.066 },
  // Cloud.ru tariff 261029 (20.11.2026), roubles without VAT per 1M tokens counted at 90 roubles per dollar: the model of the vectors
  // (0.50), the reranker that sorts the found lines (0.20), and a small chat model for short checks (13 in / 50 out).
  "BAAI/bge-m3": { inputPer1M: 0.0056, outputPer1M: 0 },
  "BAAI/bge-reranker-v2-m3": { inputPer1M: 0.0022, outputPer1M: 0 },
  "openai/gpt-oss-120b": { inputPer1M: 0.1444, outputPer1M: 0.5556 },
  // The reserve of the search on OpenRouter (the host states the cost itself; these are for when it does not): 21.11.2026.
  "openai/gpt-oss-120b@openrouter": { inputPer1M: 0.09, outputPer1M: 0.36 },
  "qwen/qwen3-reranker-8b": { inputPer1M: 0.2, outputPer1M: 0 },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 3.0 };

export function getModelPricing(model: string): ModelPricing {
  const exact = OPENROUTER_MODEL_PRICING[model.trim()];
  if (exact) return exact;
  const key = model.trim().toLowerCase();
  if (OPENROUTER_MODEL_PRICING[key]) return OPENROUTER_MODEL_PRICING[key];
  const slash = key.split("/").pop();
  if (slash && OPENROUTER_MODEL_PRICING[slash]) return OPENROUTER_MODEL_PRICING[slash];
  return DEFAULT_PRICING;
}

export function calculateCostFromTokens(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const p = getModelPricing(model);
  const cost =
    (promptTokens * p.inputPer1M + completionTokens * p.outputPer1M) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

export interface OpenRouterUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

/** Prefer OpenRouter usage.cost (USD credits); fallback to model pricing. */
export function resolveRequestCost(
  model: string,
  usage: OpenRouterUsagePayload,
  promptTokens: number,
  completionTokens: number
): number {
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return Math.round(usage.cost * 1e8) / 1e8;
  }
  return calculateCostFromTokens(model, promptTokens, completionTokens);
}
