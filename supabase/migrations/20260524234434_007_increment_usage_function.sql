/*
  # Increment Usage RPC

  Provides a safe server-side function to atomically increment a user's
  daily_requests_used and monthly_tokens_used counters, with automatic
  day/month reset logic.

  Called from the edge function (service role) — never from the client.
*/

CREATE OR REPLACE FUNCTION increment_usage(p_user_id uuid, p_tokens int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  INSERT INTO public.user_usage_tiers (
    user_id,
    daily_requests_used,
    monthly_tokens_used,
    day_reset_at,
    month_reset_at,
    updated_at
  )
  VALUES (p_user_id, 1, p_tokens, v_now, v_now, v_now)
  ON CONFLICT (user_id) DO UPDATE SET
    -- Reset day counter if 24 h have passed
    daily_requests_used = CASE
      WHEN v_now - user_usage_tiers.day_reset_at > interval '24 hours'
      THEN 1
      ELSE user_usage_tiers.daily_requests_used + 1
    END,
    day_reset_at = CASE
      WHEN v_now - user_usage_tiers.day_reset_at > interval '24 hours'
      THEN v_now
      ELSE user_usage_tiers.day_reset_at
    END,
    -- Reset month counter if 30 days have passed
    monthly_tokens_used = CASE
      WHEN v_now - user_usage_tiers.month_reset_at > interval '30 days'
      THEN p_tokens
      ELSE user_usage_tiers.monthly_tokens_used + p_tokens
    END,
    month_reset_at = CASE
      WHEN v_now - user_usage_tiers.month_reset_at > interval '30 days'
      THEN v_now
      ELSE user_usage_tiers.month_reset_at
    END,
    updated_at = v_now;
END;
$$;
