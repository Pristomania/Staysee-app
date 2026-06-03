import { supabase } from './supabase';

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
