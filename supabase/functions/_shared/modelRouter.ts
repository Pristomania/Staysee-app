/**
 * OpenRouter model selection by dialogue depth (and safety).
 * Configure via Supabase Edge secrets — no frontend changes.
 */

import type { ResponseDepth } from "./responseBudget.ts";
import type { SafetyCategory } from "./safety.ts";

export interface ModelRouteInput {
  depth: ResponseDepth;
  safetyCategory: SafetyCategory;
  /** Explicit override from request body (dev / A-B only). */
  requestModel?: string;
}

export interface ModelRouteResult {
  model: string;
  source: "request" | "crisis" | "brief" | "medium" | "deep" | "default";
}

const DEFAULT_BRIEF = "openai/gpt-4o";
const DEFAULT_MEDIUM = "openai/gpt-4o";
const DEFAULT_DEEP = "anthropic/claude-sonnet-4-5";
const DEFAULT_CRISIS = "openai/gpt-4o";
const DEFAULT_FALLBACK = "anthropic/claude-sonnet-4-5";

function envModel(key: string): string | undefined {
  const v = Deno.env.get(key)?.trim();
  return v || undefined;
}

/**
 * Picks OpenRouter model id for this turn.
 * All routes use the same OpenRouter API key; `model` is the OpenRouter slug.
 */
export function resolveChatModel(input: ModelRouteInput): ModelRouteResult {
  const override = input.requestModel?.trim();
  if (override) {
    return { model: override, source: "request" };
  }

  if (input.safetyCategory === "crisis") {
    const model =
      envModel("STAYSEE_CHAT_MODEL_CRISIS") ??
      envModel("STAYSEE_CHAT_MODEL_DEEP") ??
      envModel("STAYSEE_CHAT_MODEL") ??
      DEFAULT_CRISIS;
    return { model, source: "crisis" };
  }

  const legacy = envModel("STAYSEE_CHAT_MODEL");

  switch (input.depth) {
    case "brief": {
      const model =
        envModel("STAYSEE_CHAT_MODEL_BRIEF") ?? legacy ?? DEFAULT_BRIEF;
      return { model, source: "brief" };
    }
    case "medium": {
      const model =
        envModel("STAYSEE_CHAT_MODEL_MEDIUM") ?? legacy ?? DEFAULT_MEDIUM;
      return { model, source: "medium" };
    }
    case "deep": {
      const model =
        envModel("STAYSEE_CHAT_MODEL_DEEP") ?? legacy ?? DEFAULT_DEEP;
      return { model, source: "deep" };
    }
    default: {
      const model = legacy ?? DEFAULT_FALLBACK;
      return { model, source: "default" };
    }
  }
}
