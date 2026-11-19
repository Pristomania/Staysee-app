import {
  APPROVED_MODEL_DEEPSEEK_V4_PRO,
  APPROVED_MODEL_KIMI_K26,
  normalizeApprovedModelId,
} from "./approvedModels.ts";
import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";

export interface ChatModelParameters {
  temperature?: number;
  reasoning?: { effort: "low"; exclude: true };
  /** DeepSeek V4 Pro on Cloud.ru: "none" switches the thinking off. */
  reasoning_effort?: "none";
  /** Kimi K2.6 on Cloud.ru: its own switch for the thinking. */
  chat_template_kwargs?: { thinking: false };
}

/**
 * The parameters of the model for a chat reply.
 * Sol requires reasoning and does not accept the legacy temperature setting.
 * Each Cloud.ru model has its own switch for the thinking (measured 17.11.2026): without it the thinking is billed as output
 * and, on Kimi, leaks into the text.
 */
export function buildChatModelParameters(model: string, temperature: number): ChatModelParameters {
  if (model === "openai/gpt-6.1-sol") return { reasoning: { effort: "low", exclude: true } };
  const id = normalizeApprovedModelId(model);
  if (id === APPROVED_MODEL_DEEPSEEK_V4_PRO) return { temperature, reasoning_effort: "none" };
  if (id === APPROVED_MODEL_KIMI_K26) return { temperature, chat_template_kwargs: { thinking: false } };
  return { temperature };
}

/** Global Azure is capacity-limited; explicitly opt into the EU endpoint (10% premium). */
export function buildChatModelProviderRoute(model: string) {
  return model === "openai/gpt-6.1-sol"
    ? { ...OPENROUTER_PRIVATE_ROUTE, order: ["azure/eu"], allow_fallbacks: false, max_price: { prompt: 2.2, completion: 11 } }
    : OPENROUTER_PRIVATE_ROUTE;
}
