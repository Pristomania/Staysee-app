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
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 3.0 };

export function getModelPricing(model: string): ModelPricing {
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
