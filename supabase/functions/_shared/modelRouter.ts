/**
 * Model selection. The model is the configured one (Supabase Edge secrets), the same for every message: nothing here is decided by
 * the words of the message (owner's rule, 20.11.2026). The older choice by "depth" and safety category is gone.
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

export interface ModelRouteInput {
  /** Explicit override from request body (dev / A-B only). */
  requestModel?: string;
}

export interface ModelRouteResult {
  model: string;
  source: "request" | "configured";
  /** Alternate model on the same provider — tried if primary model returns error. */
  fallbackModel?: string;
}

const DEFAULT_BRIEF = APPROVED_MODEL_GPT4O;
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

  const model =
    envModel("STAYSEE_CHAT_MODEL_BRIEF") ??
    envModel("STAYSEE_CHAT_MODEL_MEDIUM") ??
    envModel("STAYSEE_CHAT_MODEL") ??
    DEFAULT_BRIEF;
  return { model, source: "configured", fallbackModel: DEFAULT_FALLBACK };
}
