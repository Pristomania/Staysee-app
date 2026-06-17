/**
 * OpenRouter usage logging + analytics helpers (server-side only).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ContextPacket } from "./context.ts";
import {
  getConversationSummary,
  injectSummaryIntoPrompt,
} from "./memory.ts";
import { estimateArchiveTokens } from "./conversationRetrieval.ts";
import { formatCrossMemoryForPrompt } from "./userLifeMemory.ts";
import { estimateTokens } from "./cost.ts";
import {
  calculateCostFromTokens,
  resolveRequestCost,
  type OpenRouterUsagePayload,
} from "./openRouterPricing.ts";

export type { OpenRouterUsagePayload };

/** Safe generation audit metadata — no user/assistant message text. */
export interface UsageAuditFields {
  requestId?: string | null;
  finishReason?: string | null;
  latencyMs?: number | null;
  wasTruncated?: boolean;
  autoContinueUsed?: boolean;
  finalizeUsed?: boolean;
  promptVersion?: string | null;
  constitutionVersion?: string | null;
  cognitiveSignatureVersion?: string | null;
  memoryVersion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  generationStatus?: string | null;
}

export interface UsageLogRow extends UsageAuditFields {
  userId: string;
  conversationId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  memoryTokens: number;
  summaryTokens: number;
  cost: number;
}

export interface PromptTokenBreakdown {
  /** Cross-conversation user_memory block */
  memoryTokens: number;
  /** conversation_summary + corrections in context */
  summaryTokens: number;
}

/** Estimate memory vs summary tokens injected into system prompt. */
export function estimatePromptTokenBreakdown(
  packet: ContextPacket | null
): PromptTokenBreakdown {
  if (!packet) return { memoryTokens: 0, summaryTokens: 0 };

  const summaryBlock = injectSummaryIntoPrompt({
    conversationSummary: getConversationSummary(packet.conversationMeta),
    conversationTitle: packet.conversationMeta?.title ?? null,
    emotionalTone: packet.conversationMeta?.emotional_tone ?? null,
    corrections: packet.corrections,
  });
  const archiveTokens = estimateArchiveTokens(packet.archiveExcerpts ?? []);
  const summaryTokens = estimateTokens(summaryBlock) + archiveTokens;

  let memoryTokens = 0;
  if (packet.memoryItems.length > 0) {
    memoryTokens = estimateTokens(formatCrossMemoryForPrompt(packet.memoryItems));
  }

  return { memoryTokens, summaryTokens };
}

export function buildUsageLogRow(input: {
  userId: string;
  conversationId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usage?: OpenRouterUsagePayload;
  packet?: ContextPacket | null;
  /** Override breakdown (e.g. summary-only background job) */
  memoryTokens?: number;
  summaryTokens?: number;
  audit?: UsageAuditFields;
}): UsageLogRow {
  const promptTokens = input.promptTokens;
  const completionTokens = input.completionTokens;
  const totalTokens =
    input.usage?.total_tokens ??
    promptTokens + completionTokens;

  const breakdown =
    input.memoryTokens !== undefined && input.summaryTokens !== undefined
      ? { memoryTokens: input.memoryTokens, summaryTokens: input.summaryTokens }
      : estimatePromptTokenBreakdown(input.packet ?? null);

  const cost = resolveRequestCost(
    input.model,
    input.usage ?? {},
    promptTokens,
    completionTokens
  );

  const audit = input.audit ?? {};

  return {
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    model: input.model,
    promptTokens,
    completionTokens,
    totalTokens,
    memoryTokens: breakdown.memoryTokens,
    summaryTokens: breakdown.summaryTokens,
    cost,
    requestId: audit.requestId ?? null,
    finishReason: audit.finishReason ?? null,
    latencyMs: audit.latencyMs ?? null,
    wasTruncated: audit.wasTruncated ?? false,
    autoContinueUsed: audit.autoContinueUsed ?? false,
    finalizeUsed: audit.finalizeUsed ?? false,
    promptVersion: audit.promptVersion ?? null,
    constitutionVersion: audit.constitutionVersion ?? null,
    cognitiveSignatureVersion: audit.cognitiveSignatureVersion ?? null,
    memoryVersion: audit.memoryVersion ?? null,
    errorCode: audit.errorCode ?? null,
    errorMessage: audit.errorMessage ?? null,
    generationStatus: audit.generationStatus ?? null,
  };
}

/** Fire-and-forget insert into ai_usage_logs. */
export async function logOpenRouterUsage(
  supabase: SupabaseClient,
  row: UsageLogRow
): Promise<void> {
  const { error } = await supabase.from("ai_usage_logs").insert({
    user_id: row.userId,
    conversation_id: row.conversationId,
    model: row.model,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    total_tokens: row.totalTokens,
    memory_tokens: row.memoryTokens,
    summary_tokens: row.summaryTokens,
    cost: row.cost,
    request_id: row.requestId ?? null,
    finish_reason: row.finishReason ?? null,
    latency_ms: row.latencyMs ?? null,
    was_truncated: row.wasTruncated ?? false,
    auto_continue_used: row.autoContinueUsed ?? false,
    finalize_used: row.finalizeUsed ?? false,
    prompt_version: row.promptVersion ?? null,
    constitution_version: row.constitutionVersion ?? null,
    cognitive_signature_version: row.cognitiveSignatureVersion ?? null,
    memory_version: row.memoryVersion ?? null,
    error_code: row.errorCode ?? null,
    error_message: row.errorMessage ?? null,
    generation_status: row.generationStatus ?? null,
  });

  if (error) {
    console.error("[usageAnalytics] logOpenRouterUsage:", error.message);
  } else {
    console.log(
      `[usageAnalytics] logged model=${row.model} tokens=${row.totalTokens} ` +
        `memory=${row.memoryTokens} summary=${row.summaryTokens} cost=$${row.cost}`
    );
  }
}

/** Parse OpenRouter chat/completions JSON usage + cost. */
export function parseOpenRouterUsage(data: {
  usage?: OpenRouterUsagePayload;
}): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
} {
  const u = data.usage ?? {};
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  const totalTokens = u.total_tokens ?? promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost: typeof u.cost === "number" ? u.cost : undefined,
  };
}

/** Log background conversation_summary model call. */
export async function logSummaryGenerationUsage(
  supabase: SupabaseClient,
  input: {
    userId: string;
    conversationId: string;
    model: string;
    summaryPrompt: string;
    modelOutput: string;
    usage?: OpenRouterUsagePayload;
  }
): Promise<void> {
  const promptTokens =
    input.usage?.prompt_tokens ?? estimateTokens(input.summaryPrompt);
  const completionTokens =
    input.usage?.completion_tokens ?? estimateTokens(input.modelOutput);
  const summaryTokens = estimateTokens(input.summaryPrompt);

  const row = buildUsageLogRow({
    userId: input.userId,
    conversationId: input.conversationId,
    model: input.model,
    promptTokens,
    completionTokens,
    usage: input.usage,
    memoryTokens: 0,
    summaryTokens,
  });

  await logOpenRouterUsage(supabase, row);
}

/** Log OpenRouter call for cross-memory synthesis (user_memory background). */
export async function logLifeMemorySynthesisUsage(
  supabase: SupabaseClient,
  input: {
    userId: string;
    conversationId?: string | null;
    model: string;
    synthesisPrompt: string;
    modelOutput: string;
    usage?: OpenRouterUsagePayload;
  }
): Promise<void> {
  const promptTokens =
    input.usage?.prompt_tokens ?? estimateTokens(input.synthesisPrompt);
  const completionTokens =
    input.usage?.completion_tokens ?? estimateTokens(input.modelOutput);
  const memoryTokens = estimateTokens(input.synthesisPrompt);

  const row = buildUsageLogRow({
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    model: input.model,
    promptTokens,
    completionTokens,
    usage: input.usage,
    memoryTokens,
    summaryTokens: 0,
  });

  await logOpenRouterUsage(supabase, row);
}

// ── Analytics queries (service_role client) ─────────────────────────────────

export async function fetchDailyCostToday(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("get_usage_cost_today");
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function fetchCostByUsers(
  supabase: SupabaseClient,
  sinceIso?: string
) {
  const { data, error } = await supabase.rpc("get_usage_cost_by_users", {
    p_since: sinceIso ?? new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  if (error) throw error;
  return data ?? [];
}

export async function fetchTopExpensiveConversations(
  supabase: SupabaseClient,
  limit = 20,
  sinceIso?: string
) {
  const { data, error } = await supabase.rpc("get_top_expensive_conversations", {
    p_limit: limit,
    p_since: sinceIso ?? new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  if (error) throw error;
  return data ?? [];
}

export async function fetchMemoryTokenUsage(
  supabase: SupabaseClient,
  sinceIso?: string
) {
  const { data, error } = await supabase.rpc("get_memory_token_usage", {
    p_since: sinceIso ?? new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Direct view read fallback for admin dashboard. */
export async function fetchDailyCostSeries(
  supabase: SupabaseClient,
  days = 30
) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from("v_analytics_daily_cost")
    .select("*")
    .gte("day", since.slice(0, 10))
    .order("day", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export { calculateCostFromTokens, resolveRequestCost };
