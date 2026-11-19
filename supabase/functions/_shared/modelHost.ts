/**
 * Which host answers a model: the host follows the model.
 *
 * DeepSeek V4 Pro (main) and Kimi K2.6 (reserve) are chosen for StaySee. Now they are asked through OpenRouter, on the private
 * route (the OpenRouter ids: "deepseek/deepseek-v4-pro", "moonshotai/kimi-k2.6"). When the move to Russia comes, the same two models
 * are asked of Cloud.ru (OpenAI-compatible API, ids "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6", secret CLOUDRU_API_KEY):
 * only the model names in the secrets change. Every other approved model goes through OpenRouter, as before.
 */

import {
  APPROVED_MODEL_DEEPSEEK_V4_PRO,
  APPROVED_MODEL_KIMI_K26,
  CLOUDRU_RUNTIME_MODELS,
  normalizeApprovedModelId,
} from "./approvedModels.ts";

export type ModelHost = "cloudru" | "openrouter";

export const CLOUDRU_BASE_URL = "https://foundation-models.api.cloud.ru/v1";
/** The name of the secret that holds the Cloud.ru API key. */
export const CLOUDRU_API_KEY_ENV = "CLOUDRU_API_KEY";

export function hostForModel(model: string): ModelHost {
  return CLOUDRU_RUNTIME_MODELS.has(normalizeApprovedModelId(model)) ? "cloudru" : "openrouter";
}

/** DeepSeek V4 Pro or Kimi K2.6 asked through OpenRouter (the models of today). */
export function isOwnModelOnOpenRouter(model: string): boolean {
  const id = normalizeApprovedModelId(model);
  return id === APPROVED_MODEL_DEEPSEEK_V4_PRO || id === APPROVED_MODEL_KIMI_K26;
}
