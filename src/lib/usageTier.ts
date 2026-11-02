import { supabase } from './supabase';
import type { PackRow, UsageRow } from './messageCounter';

export interface UsageTierRow {
  tier: string;
  daily_request_limit: number;
  daily_requests_used: number;
  day_reset_at: string;
  is_suspended: boolean;
}

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  basic: 'Basic',
  premium: 'Premium',
};

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

/**
 * The person's whole usage row, whatever columns the database has (an older one lacks the newer columns, which then
 * simply read as missing). The counter and the plan are worked out from it in the app.
 */
export async function fetchUsageRow(userId: string): Promise<UsageRow | null> {
  const { data, error } = await supabase.from('user_usage_tiers').select('*').eq('user_id', userId).maybeSingle();
  if (error || !data) return null;
  return data as UsageRow;
}

/**
 * The person's bought messages that still have something left (migration 090). null when they could not be read,
 * which is not the same as none: the caller keeps what it knew before.
 */
export async function fetchPackRows(userId: string): Promise<PackRow[] | null> {
  const { data, error } = await supabase
    .from('message_packs')
    .select('messages_left, expires_at, voided_at')
    .eq('user_id', userId)
    .gt('messages_left', 0);
  if (error || !data) return null;
  return data as PackRow[];
}

export async function fetchUsageTier(userId: string): Promise<{
  row: UsageTierRow | null;
  usedToday: number;
  limit: number;
  remaining: number;
}> {
  const { data, error } = await supabase
    .from('user_usage_tiers')
    .select('tier, daily_request_limit, daily_requests_used, day_reset_at, is_suspended')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    return { row: null, usedToday: 0, limit: 50, remaining: 50 };
  }

  const dayReset = new Date(data.day_reset_at);
  const dayExpired = Date.now() - dayReset.getTime() > 24 * 60 * 60 * 1000;
  const usedToday = dayExpired ? 0 : (data.daily_requests_used ?? 0);
  const limit = data.daily_request_limit ?? 50;
  const remaining = Math.max(0, limit - usedToday);

  return {
    row: data as UsageTierRow,
    usedToday,
    limit,
    remaining,
  };
}
