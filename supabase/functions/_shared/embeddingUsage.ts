/**
 * The cost of embeddings (the vectors for the memory search) goes into ai_usage_logs like every other paid call.
 *
 * Kept free of heavy imports on purpose (no Supabase package, no cost.ts): it can be tested on its own, and embeddings.ts can use it
 * without a cycle. The database client is described by the two calls it needs.
 *
 * The cost is the one the provider reports (usage.cost). When it sends none, it is counted from the price table
 * (openRouterPricing.ts). When it sends no usage at all, the tokens are estimated from the text so that the call is never lost.
 */

import { resolveRequestCost } from "./openRouterPricing.ts";

export interface EmbeddingUsage {
  model: string;
  promptTokens: number;
  totalTokens: number;
  /** USD */
  cost: number;
}

/** A rough count when the provider gives none: three characters a token (Russian text is dense; this errs on the side of counting). */
const ESTIMATED_CHARS_PER_TOKEN = 3;

function wholeTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** What one embeddings answer cost: tokens and USD, from the answer's own usage, else the price table, else an estimate. */
export function readEmbeddingUsage(data: unknown, model: string, inputs: string[]): EmbeddingUsage {
  const usage = (typeof data === "object" && data !== null ? (data as { usage?: unknown }).usage : null) as
    | { prompt_tokens?: unknown; total_tokens?: unknown; cost?: unknown }
    | null
    | undefined;
  const usageObject = typeof usage === "object" && usage !== null ? usage : {};

  const estimated = Math.max(1, Math.ceil(inputs.reduce((sum, text) => sum + text.length, 0) / ESTIMATED_CHARS_PER_TOKEN));
  const promptTokens = wholeTokens(usageObject.prompt_tokens) ?? wholeTokens(usageObject.total_tokens) ?? estimated;
  const totalTokens = wholeTokens(usageObject.total_tokens) ?? promptTokens;

  const reportedCost = typeof usageObject.cost === "number" ? usageObject.cost : undefined;
  const cost = resolveRequestCost(model, { cost: reportedCost }, promptTokens, 0);
  return { model, promptTokens, totalTokens, cost };
}

export interface EmbeddingUsageOwner {
  userId: string;
  conversationId?: string | null;
}

/** The row for ai_usage_logs (the column names of the table). */
export function embeddingUsageInsert(owner: EmbeddingUsageOwner, usage: EmbeddingUsage): Record<string, unknown> {
  return {
    user_id: owner.userId,
    conversation_id: owner.conversationId ?? null,
    model: usage.model,
    prompt_tokens: usage.promptTokens,
    completion_tokens: 0,
    total_tokens: usage.totalTokens,
    memory_tokens: 0,
    summary_tokens: 0,
    cost: usage.cost,
    call_kind: "embedding",
    cost_category: "automatic",
  };
}

/** The two calls of the database client that are needed. */
export interface UsageLogClient {
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error?: { message: string } | null }> };
}

/** Writes the cost of one embeddings call. Never throws: a failing log must not break an answer. */
export async function logEmbeddingUsage(client: UsageLogClient, owner: EmbeddingUsageOwner, usage: EmbeddingUsage): Promise<void> {
  try {
    const { error } = await client.from("ai_usage_logs").insert(embeddingUsageInsert(owner, usage));
    if (error) console.error("[embeddingUsage] insert failed:", error.message);
  } catch (e) {
    console.error("[embeddingUsage] insert threw:", e);
  }
}
