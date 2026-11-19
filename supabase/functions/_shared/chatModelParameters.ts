import {
  APPROVED_MODEL_DEEPSEEK_V4_PRO,
  APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU,
  APPROVED_MODEL_KIMI_K26,
  APPROVED_MODEL_KIMI_K26_CLOUDRU,
  normalizeApprovedModelId,
} from "./approvedModels.ts";
import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";

export interface ChatModelParameters {
  temperature?: number;
  /** Sol requires its reasoning (hidden); DeepSeek V4 Pro and Kimi K2.6 on OpenRouter get "none": no thinking. */
  reasoning?: { effort: "low"; exclude: true } | { effort: "none" };
  /** DeepSeek V4 Pro on Cloud.ru: "none" switches the thinking off. */
  reasoning_effort?: "none";
  /** Kimi K2.6 on Cloud.ru: its own switch for the thinking. */
  chat_template_kwargs?: { thinking: false };
}

/**
 * The parameters of the model for a chat reply.
 * Sol requires reasoning and does not accept the legacy temperature setting.
 * DeepSeek V4 Pro and Kimi K2.6 are used without thinking (measured 17-19.11.2026): with it the thinking is billed as output, and
 * on some hosts it leaks into the text. On OpenRouter the switch is reasoning.effort "none" (clean on every host but Venice,
 * which is left out in the route below); on Cloud.ru each model has its own switch.
 */
export function buildChatModelParameters(model: string, temperature: number): ChatModelParameters {
  if (model === "openai/gpt-6.1-sol") return { reasoning: { effort: "low", exclude: true } };
  const id = normalizeApprovedModelId(model);
  if (id === APPROVED_MODEL_DEEPSEEK_V4_PRO || id === APPROVED_MODEL_KIMI_K26) return { temperature, reasoning: { effort: "none" } };
  if (id === APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU) return { temperature, reasoning_effort: "none" };
  if (id === APPROVED_MODEL_KIMI_K26_CLOUDRU) return { temperature, chat_template_kwargs: { thinking: false } };
  return { temperature };
}

/** Global Azure is capacity-limited; explicitly opt into the EU endpoint (10% premium). */
export function buildChatModelProviderRoute(model: string) {
  if (model === "openai/gpt-6.1-sol") {
    return { ...OPENROUTER_PRIVATE_ROUTE, order: ["azure/eu"], allow_fallbacks: false, max_price: { prompt: 2.2, completion: 11 } };
  }
  // Venice answers with the thinking of Kimi K2.6 written into the reply (3 of 3, 19.11.2026): never send it there.
  if (normalizeApprovedModelId(model) === APPROVED_MODEL_KIMI_K26) return { ...OPENROUTER_PRIVATE_ROUTE, ignore: ["Venice"] };
  return OPENROUTER_PRIVATE_ROUTE;
}
