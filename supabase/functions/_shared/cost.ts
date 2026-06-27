/**
 * StaySee AI — Cost Control and API Usage Protection (Layer 7)
 *
 * Responsibilities:
 * - Token limit configuration per tier
 * - Rate limit enforcement (requests per user per day)
 * - Fallback provider chain
 * - Usage logging (fire-and-forget, non-blocking)
 * - Context size optimisation helpers
 * - Duplicate request detection via idempotency key
 *
 * All functions are server-side only. Nothing here is exposed to the client.
 *
 * Imported by: supabase/functions/staysee-chat/index.ts
 */

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildUsageLogRow, logOpenRouterUsage } from "./usageAnalytics.ts";

// ── Tier definitions ──────────────────────────────────────────────────────────

export type UsageTier = "free" | "basic" | "premium";

interface TierConfig {
  maxTokensOutput: number;       // max completion tokens per request
  maxContextMessages: number;    // how many history messages to include
  maxMemoryItems: number;        // how many memory items to include
  dailyRequestLimit: number;     // hard cap per day
  monthlyTokenLimit: number;     // soft monthly cap
  temperature: number;           // temperature for this tier
}

export const TIER_CONFIG: Record<UsageTier, TierConfig> = {
  free: {
    // Tier ceiling — deep replies use full budget; auto-continue if still cut.
    maxTokensOutput: 1600,
    maxContextMessages: 18,
    maxMemoryItems: 6,
    dailyRequestLimit: 50,
    monthlyTokenLimit: 200_000,
    temperature: 0.85,
  },
  basic: {
    maxTokensOutput: 1200,
    maxContextMessages: 24,
    maxMemoryItems: 8,
    dailyRequestLimit: 200,
    monthlyTokenLimit: 1_000_000,
    temperature: 0.85,
  },
  premium: {
    maxTokensOutput: 1800,
    maxContextMessages: 32,
    maxMemoryItems: 10,
    dailyRequestLimit: 1000,
    monthlyTokenLimit: 5_000_000,
    temperature: 0.82,
  },
};

// ── Fallback provider chain ───────────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  envKey: string;
  extraHeaders?: Record<string, string>;
}

// Order matters — first available key wins on fallback
export const FALLBACK_CHAIN: Array<{ provider: string; config: ProviderConfig }> = [
  {
    provider: "openrouter",
    config: {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-haiku",  // haiku is available and cheaper
      envKey: "OPENROUTER_API_KEY",
      extraHeaders: { "HTTP-Referer": "https://staysee.app", "X-Title": "StaySee AI" },
    },
  },
  {
    provider: "openai",
    config: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      envKey: "OPENAI_API_KEY",
    },
  },
  {
    provider: "mistral",
    config: {
      baseUrl: "https://api.mistral.ai/v1",
      model: "mistral-small-latest",
      envKey: "MISTRAL_API_KEY",
    },
  },
];

export function findFallbackProvider(
  excludeProviders: string[]
): { provider: string; config: ProviderConfig } | null {
  for (const entry of FALLBACK_CHAIN) {
    if (excludeProviders.includes(entry.provider)) continue;
    const key = Deno.env.get(entry.config.envKey);
    if (key) return entry;
  }
  return null;
}

// ── IP velocity guard (spam / autoclicker protection) ────────────────────────

const ipRequestLog = new Map<string, number[]>();
const IP_WINDOW_MS = 60_000;   // 1 minute window
const IP_MAX_REQUESTS = 10;    // max requests per IP per minute
const MIN_MESSAGE_INTERVAL_MS = 4_000; // min 4s between messages from same IP

export function checkIpVelocity(ip: string): { allowed: boolean; reason?: string } {
  if (!ip || ip === "unknown") return { allowed: true };

  const now = Date.now();
  const timestamps = ipRequestLog.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < IP_WINDOW_MS);

  // Too fast (autoclicker)
  if (recent.length > 0 && now - recent[recent.length - 1] < MIN_MESSAGE_INTERVAL_MS) {
    return { allowed: false, reason: "too_fast" };
  }

  // Too many (flood)
  if (recent.length >= IP_MAX_REQUESTS) {
    return { allowed: false, reason: "ip_flood" };
  }

  recent.push(now);
  ipRequestLog.set(ip, recent);

  // Cleanup stale IPs
  if (ipRequestLog.size > 2000) {
    for (const [k, ts] of ipRequestLog) {
      if (ts.every((t) => now - t > IP_WINDOW_MS)) ipRequestLog.delete(k);
    }
  }

  return { allowed: true };
}

// ── Idempotency / duplicate prevention ───────────────────────────────────────

// In-memory store for recent request hashes (cleared on cold start).
// Keeps the last 200 entries; edge function instances are short-lived.
const recentRequestHashes = new Map<string, number>();
const MAX_HASH_CACHE = 200;
const DEDUP_WINDOW_MS = 5_000; // 5 seconds

export function isDuplicateRequest(key: string): boolean {
  const now = Date.now();

  // Evict stale entries when cache grows
  if (recentRequestHashes.size >= MAX_HASH_CACHE) {
    for (const [k, ts] of recentRequestHashes) {
      if (now - ts > DEDUP_WINDOW_MS) recentRequestHashes.delete(k);
    }
  }

  const last = recentRequestHashes.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;

  recentRequestHashes.set(key, now);
  return false;
}

export function makeRequestKey(userId: string, message: string): string {
  // Simple hash: userId + first 120 chars of message
  return `${userId}::${message.slice(0, 120)}`;
}

// ── Rate limit check (DB-backed) ─────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  tier: UsageTier;
  reason?: string;
}

export async function checkRateLimit(
  supabase: SupabaseClient,
  userId: string
): Promise<RateLimitResult> {
  const { data, error } = await supabase
    .from("user_usage_tiers")
    .select("tier, daily_request_limit, daily_requests_used, month_reset_at, day_reset_at, is_suspended")
    .eq("user_id", userId)
    .maybeSingle();

  // If no row exists yet, treat as free tier and allow
  if (error || !data) return { allowed: true, tier: "free" };

  const tier = (data.tier as UsageTier) ?? "free";

  if (data.is_suspended) {
    return { allowed: false, tier, reason: "suspended" };
  }

  // Check if day has rolled over
  const dayReset = new Date(data.day_reset_at);
  const now = new Date();
  const dayExpired = now.getTime() - dayReset.getTime() > 24 * 60 * 60 * 1000;

  const usedToday = dayExpired ? 0 : (data.daily_requests_used ?? 0);
  const limit = data.daily_request_limit ?? TIER_CONFIG[tier].dailyRequestLimit;

  if (usedToday >= limit) {
    return { allowed: false, tier, reason: "daily_limit" };
  }

  return { allowed: true, tier };
}

// ── Usage counter increment (non-blocking, best-effort) ───────────────────────

export async function incrementUsage(
  supabase: SupabaseClient,
  userId: string,
  tokens: number
): Promise<void> {
  // Upsert — creates row if missing (handles new users before trigger fires)
  const { error } = await supabase.rpc("increment_usage", {
    p_user_id: userId,
    p_tokens: tokens,
  });
  if (error) console.error("[cost] incrementUsage:", error.message);
}

// ── Usage logging (non-blocking) ─────────────────────────────────────────────

export interface UsageLogEntry {
  userId: string;
  conversationId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseMs: number;
  safetyCategory: string;
  tier: UsageTier;
}

/** @deprecated Prefer logOpenRouterUsage from usageAnalytics.ts */
export async function logUsage(
  serviceSupabase: SupabaseClient,
  entry: UsageLogEntry
): Promise<void> {
  const row = buildUsageLogRow({
    userId: entry.userId,
    conversationId: entry.conversationId,
    model: entry.model,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
  });
  await logOpenRouterUsage(serviceSupabase, row);

  const { error } = await serviceSupabase.from("ai_usage_log").insert({
    user_id: entry.userId,
    conversation_id: entry.conversationId ?? null,
    provider: entry.provider,
    model: entry.model,
    prompt_tokens: entry.promptTokens,
    completion_tokens: entry.completionTokens,
    total_tokens: entry.totalTokens,
    response_ms: entry.responseMs,
    safety_category: entry.safetyCategory,
    tier_snapshot: entry.tier,
  });
  if (error) console.error("[cost] logUsage legacy:", error.message);
}

// ── Token estimation (rough, no tokenizer needed) ────────────────────────────

export function estimateTokens(text: string): number {
  // ~1 token per 3.5 chars is a conservative estimate for mixed Russian/English
  return Math.ceil(text.length / 3.5);
}

// ── Context trimming ─────────────────────────────────────────────────────────

export interface TrimmedContext {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  memoryItems: Array<{ id: string; memory_type: string; content: string; importance: number }>;
}

export function trimContextForTier(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  memoryItems: Array<{ id: string; memory_type: string; content: string; importance: number }>,
  tier: UsageTier
): TrimmedContext {
  const cfg = TIER_CONFIG[tier];

  // Keep only the most recent N messages
  const trimmedMessages = messages.slice(-cfg.maxContextMessages);

  // Keep only top-importance memory items up to limit
  const sortedMemory = [...memoryItems]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, cfg.maxMemoryItems);

  return { messages: trimmedMessages, memoryItems: sortedMemory };
}

// ── Service Supabase client (uses service role — only in edge functions) ──────

export function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );
}

// ── Calm user-facing error messages ─────────────────────────────────────────

export const CALM_ERRORS = {
  unavailable: "Сейчас не могу ответить. Попробуй немного позже.",
  /** stop+not_publishable when repair and retry whole both fail — not a provider outage */
  replyNotRecovered:
    "Сейчас ответ не собрался достаточно надёжно. Давай попробуем ещё раз с этого места.",
  rateLimit: "Ты уже много работаешь со мной сегодня. Дай себе немного пространства — завтра я снова здесь.",
  suspended: "Доступ временно ограничен. Если это ошибка, напиши нам.",
  duplicate: "Похоже, запрос уже отправляется. Подожди секунду.",
} as const;
