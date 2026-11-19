/**
 * Which host answers a model: the host follows the model.
 *
 * The models chosen for StaySee (DeepSeek V4 Pro as the main one, Kimi K2.6 as the reserve) are hosted by Cloud.ru in Russia,
 * through an OpenAI-compatible API. Every other approved model goes through OpenRouter, as before.
 */

import { CLOUDRU_RUNTIME_MODELS, normalizeApprovedModelId } from "./approvedModels.ts";

export type ModelHost = "cloudru" | "openrouter";

export const CLOUDRU_BASE_URL = "https://foundation-models.api.cloud.ru/v1";
/** The name of the secret that holds the Cloud.ru API key. */
export const CLOUDRU_API_KEY_ENV = "CLOUDRU_API_KEY";

export function hostForModel(model: string): ModelHost {
  return CLOUDRU_RUNTIME_MODELS.has(normalizeApprovedModelId(model)) ? "cloudru" : "openrouter";
}
