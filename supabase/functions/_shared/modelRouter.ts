/**
 * OpenRouter model selection by dialogue depth (and safety).
 * Configure via Supabase Edge secrets — no frontend changes.
 */

import {
  APPROVED_MODEL_GPT4O,
  APPROVED_MODEL_SONNET,
  assertApprovedRuntimeModel,
  normalizeApprovedModelId,
} from "./approvedModels.ts";
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
  /** Alternate model on the same provider — tried if primary model returns error. */
  fallbackModel?: string;
}

const DEFAULT_BRIEF = APPROVED_MODEL_GPT4O;
const DEFAULT_MEDIUM = APPROVED_MODEL_GPT4O;
const DEFAULT_DEEP = APPROVED_MODEL_SONNET;
const DEFAULT_CRISIS = APPROVED_MODEL_GPT4O;
const DEFAULT_FALLBACK = APPROVED_MODEL_SONNET;

function envModel(key: string): string | undefined {
  const v = Deno.env.get(key)?.trim();
  if (!v) return undefined;
  assertApprovedRuntimeModel(v, key);
  return normalizeApprovedModelId(v);
}

/**
 * Picks OpenRouter model id for this turn.
 * All routes use the same OpenRouter API key; `model` is the OpenRouter slug.
 */
export function resolveChatModel(input: ModelRouteInput): ModelRouteResult {
  const override = input.requestModel?.trim();
  if (override) {
    assertApprovedRuntimeModel(override, "requestModel");
    return { model: normalizeApprovedModelId(override), source: "request" };
  }

  if (input.safetyCategory === "crisis") {
    const model =
      envModel("STAYSEE_CHAT_MODEL_CRISIS") ??
      envModel("STAYSEE_CHAT_MODEL_DEEP") ??
      envModel("STAYSEE_CHAT_MODEL") ??
      DEFAULT_CRISIS;
    return { model, source: "crisis", fallbackModel: DEFAULT_DEEP };
  }

  const legacy = envModel("STAYSEE_CHAT_MODEL");

  switch (input.depth) {
    case "brief": {
      const model =
        envModel("STAYSEE_CHAT_MODEL_BRIEF") ?? legacy ?? DEFAULT_BRIEF;
      return { model, source: "brief", fallbackModel: DEFAULT_DEEP };
    }
    case "medium": {
      const model =
        envModel("STAYSEE_CHAT_MODEL_MEDIUM") ?? legacy ?? DEFAULT_MEDIUM;
      return { model, source: "medium", fallbackModel: DEFAULT_DEEP };
    }
    case "deep": {
      const model =
        envModel("STAYSEE_CHAT_MODEL_DEEP") ?? legacy ?? DEFAULT_DEEP;
      return { model, source: "deep", fallbackModel: DEFAULT_BRIEF };
    }
    default: {
      const model = legacy ?? DEFAULT_FALLBACK;
      return { model, source: "default", fallbackModel: DEFAULT_BRIEF };
    }
  }
}
