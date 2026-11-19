/**
 * OpenRouter model selection by dialogue depth (and safety).
 * Configure via Supabase Edge secrets — no frontend changes.
 */

import {
  APPROVED_MODEL_DEEPSEEK_V4_PRO,
  APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU,
  APPROVED_MODEL_GPT4O,
  APPROVED_MODEL_KIMI_K26,
  APPROVED_MODEL_KIMI_K26_CLOUDRU,
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
  /** Core V2 flat ordinary runtime — gpt-4o primary regardless of depth. */
  flatOrdinary?: boolean;
}

export interface ModelRouteResult {
  model: string;
  source:
    | "request"
    | "brief"
    | "medium"
    | "deep"
    | "default"
    | "flat_ordinary";
  /** Alternate model on the same provider — tried if primary model returns error. */
  fallbackModel?: string;
}

const DEFAULT_BRIEF = APPROVED_MODEL_GPT4O;
const DEFAULT_MEDIUM = APPROVED_MODEL_GPT4O;
const DEFAULT_DEEP = APPROVED_MODEL_SONNET;
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
  const route = resolveChatModelBase(input);
  const reserve = resolveOwnModelFallback(route.model);
  return reserve ? { ...route, fallbackModel: reserve } : route;
}

/**
 * The model that answers when DeepSeek V4 Pro or Kimi K2.6 fails: STAYSEE_CHAT_MODEL_FALLBACK if it is set (and approved), otherwise
 * the other one of the two, on the same host (OpenRouter now, Cloud.ru after the move, so that the words of the person stay with
 * the Russian host). Any other model keeps its own reserve (undefined here).
 */
export function resolveOwnModelFallback(primary: string): string | undefined {
  const id = normalizeApprovedModelId(primary);
  const pair: Record<string, string> = {
    [APPROVED_MODEL_DEEPSEEK_V4_PRO]: APPROVED_MODEL_KIMI_K26,
    [APPROVED_MODEL_KIMI_K26]: APPROVED_MODEL_DEEPSEEK_V4_PRO,
    [APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU]: APPROVED_MODEL_KIMI_K26_CLOUDRU,
    [APPROVED_MODEL_KIMI_K26_CLOUDRU]: APPROVED_MODEL_DEEPSEEK_V4_PRO_CLOUDRU,
  };
  const other = pair[id];
  if (!other) return undefined;
  const forced = envModel("STAYSEE_CHAT_MODEL_FALLBACK");
  return forced && forced !== id ? forced : other;
}

function resolveChatModelBase(input: ModelRouteInput): ModelRouteResult {
  const override = input.requestModel?.trim();
  if (override) {
    assertApprovedRuntimeModel(override, "requestModel");
    return { model: normalizeApprovedModelId(override), source: "request" };
  }

  if (input.flatOrdinary) {
    const model =
      envModel("STAYSEE_CHAT_MODEL_BRIEF") ??
      envModel("STAYSEE_CHAT_MODEL_MEDIUM") ??
      envModel("STAYSEE_CHAT_MODEL") ??
      DEFAULT_BRIEF;
    return { model, source: "flat_ordinary", fallbackModel: DEFAULT_FALLBACK };
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
