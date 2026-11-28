/**
 * Which models of Cloud.ru may get a request.
 *
 * Cloud.ru hosts some models itself and passes others to partners ("external"): the text then leaves Cloud.ru. The owner's rule:
 * no partner models, except one she allows by name as a reserve for when Cloud.ru's own model is down.
 *
 * The list of its own models is taken from GET https://foundation-models.api.cloud.ru/v1/models (metadata.provider "cloud.ru"),
 * checked on 28.11.2026. To use a new model, check there first and add it here.
 */

export const CLOUDRU_OWN_MODELS = Object.freeze([
  "BAAI/bge-m3",
  "BAAI/bge-reranker-v2-m3",
  "GigaChat/GigaASR",
  "GigaChat/GigaChat-3-Pro",
  "GigaChat/GigaChat-4-37B-A3",
  "GigaChat/GigaChat-4-708B-A41",
  "GigaChat/SaluteSpeech",
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3-Coder-Next",
  "Qwen/Qwen3-Embedding-0.6B",
  "Qwen/Qwen3-Reranker-0.6B",
  "Qwen/Qwen3-VL-Embedding-2B",
  "Qwen/Qwen3-VL-Embedding-8B",
  "Qwen/Qwen3-VL-Reranker-2B",
  "Qwen/Qwen3-VL-Reranker-8B",
  "Qwen/Qwen3.5-397B-A17B",
  "Qwen/Qwen3.6-35B-A3B",
  "ai-sage/Giga-Embeddings-instruct-3B",
  "ai-sage/Giga-Embeddings-instruct-480M",
  "ai-sage/GigaChat3-10B-A1.8B",
  "ai-sage/GigaChat3.5-432B-A28B",
  "deepseek-ai/DeepSeek-OCR-2",
  "deepseek-ai/DeepSeek-V4-Pro",
  "hivetrace/HiveTraceGuard-Pro",
  "moonshotai/Kimi-K2.6",
  "openai/gpt-oss-120b",
  "openai/whisper-large-v3",
  "zai-org/GLM-5.1",
]);

/** Partner models the owner allowed as a reserve, one by one. Empty until she picks one. */
export const CLOUDRU_ALLOWED_PARTNER_RESERVES = Object.freeze([]);

const allowed = new Set([...CLOUDRU_OWN_MODELS, ...CLOUDRU_ALLOWED_PARTNER_RESERVES].map((name) => name.toLowerCase()));

export function isAllowedCloudruModel(model) {
  return typeof model === "string" && allowed.has(model.toLowerCase());
}

export function isCloudruAddress(address) {
  return /^https:\/\/foundation-models\.api\.cloud\.ru\//i.test(address);
}
