import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";
/** Sol requires reasoning and does not accept the legacy temperature setting. */
export function buildChatModelParameters(model: string, temperature: number): {
  temperature?: number;
  reasoning?: { effort: "low"; exclude: true };
} {
  return model === "openai/gpt-6.1-sol"
    ? { reasoning: { effort: "low", exclude: true } }
    : { temperature };
}

/** Global Azure is capacity-limited; explicitly opt into the EU endpoint (10% premium). */
export function buildChatModelProviderRoute(model: string) {
  return model === "openai/gpt-6.1-sol"
    ? { ...OPENROUTER_PRIVATE_ROUTE, order: ["azure/eu"], allow_fallbacks: false, max_price: { prompt: 2.2, completion: 11 } }
    : OPENROUTER_PRIVATE_ROUTE;
}
