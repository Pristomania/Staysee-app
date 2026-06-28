/**
 * Approved OpenRouter runtime models for StaySee.
 * Policy: gpt-4o (primary) and claude-sonnet-4-5 (fallback / deep).
 */

export const APPROVED_MODEL_GPT4O = "openai/gpt-4o";
export const APPROVED_MODEL_SONNET = "anthropic/claude-sonnet-4-5";

/** OpenRouter slugs allowed for runtime API calls. */
export const APPROVED_RUNTIME_MODELS = new Set<string>([
  APPROVED_MODEL_GPT4O,
  APPROVED_MODEL_SONNET,
]);

/** Substrings that must not appear as hardcoded runtime defaults. */
export const BANNED_RUNTIME_MODEL_SUBSTRINGS = [
  "gpt-4.1",
  "claude-3.5-haiku",
] as const;

const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o": APPROVED_MODEL_GPT4O,
  "claude-sonnet-4-5": APPROVED_MODEL_SONNET,
};

export function normalizeApprovedModelId(model: string): string {
  const trimmed = model.trim();
  if (MODEL_ALIASES[trimmed]) return MODEL_ALIASES[trimmed];
  return trimmed;
}

export function isApprovedRuntimeModel(model: string): boolean {
  const normalized = normalizeApprovedModelId(model);
  return APPROVED_RUNTIME_MODELS.has(normalized);
}

export function assertApprovedRuntimeModel(model: string, context = "model"): void {
  if (!isApprovedRuntimeModel(model)) {
    throw new Error(`Unauthorized ${context}: ${model}`);
  }
}

export interface ApprovedUtilityModelRoute {
  primary: string;
  fallback: string;
}

/**
 * Utility tasks (summaries, consolidation, weekly reflection, classifiers).
 * Env override must still be an approved model.
 */
export function resolveApprovedUtilityModel(
  envKey = "STAYSEE_SUMMARY_MODEL",
): ApprovedUtilityModelRoute {
  const override =
    typeof Deno !== "undefined" ? Deno.env.get(envKey)?.trim() : undefined;
  if (override) {
    assertApprovedRuntimeModel(override, envKey);
    return {
      primary: normalizeApprovedModelId(override),
      fallback: APPROVED_MODEL_SONNET,
    };
  }
  return {
    primary: APPROVED_MODEL_GPT4O,
    fallback: APPROVED_MODEL_SONNET,
  };
}

export interface OpenRouterUtilityModelConfig {
  baseUrl: string;
  model: string;
  envKey: string;
  fallbackModel: string;
  extraHeaders: Record<string, string>;
}

export function buildOpenRouterUtilityModelConfig(options?: {
  envKey?: string;
  title?: string;
}): OpenRouterUtilityModelConfig {
  const envKey = options?.envKey ?? "STAYSEE_SUMMARY_MODEL";
  const route = resolveApprovedUtilityModel(envKey);
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    model: route.primary,
    envKey: "OPENROUTER_API_KEY",
    fallbackModel: route.fallback,
    extraHeaders: {
      "HTTP-Referer": "https://staysee.app",
      "X-Title": options?.title ?? "StaySee Utility",
    },
  };
}
