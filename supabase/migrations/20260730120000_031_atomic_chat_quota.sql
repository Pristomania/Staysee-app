-- 031_atomic_chat_quota
-- Additive only. Does not alter legacy public.increment_usage.

CREATE OR REPLACE FUNCTION public.reserve_ai_request(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.user_usage_tiers%ROWTYPE;
BEGIN
  SELECT *
  INTO v_row
  FROM public.user_usage_tiers
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', 'free',
      'reason', 'missing_tier'
    );
  END IF;

  IF v_row.is_suspended THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'suspended'
    );
  END IF;

  IF v_now - v_row.day_reset_at > interval '24 hours' THEN
    UPDATE public.user_usage_tiers
    SET
      daily_requests_used = 1,
      day_reset_at = v_now,
      updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'allowed', true,
      'tier', v_row.tier
    );
  END IF;

  IF v_row.daily_requests_used >= v_row.daily_request_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'daily_limit'
    );
  END IF;

  UPDATE public.user_usage_tiers
  SET
    daily_requests_used = daily_requests_used + 1,
    updated_at = v_now
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'tier', v_row.tier
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.add_ai_token_usage(p_user_id uuid, p_tokens integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RAISE EXCEPTION 'p_tokens must be non-null and non-negative';
  END IF;

  UPDATE public.user_usage_tiers
  SET
    monthly_tokens_used = CASE
      WHEN v_now - month_reset_at > interval '30 days' THEN p_tokens
      ELSE monthly_tokens_used + p_tokens
    END,
    month_reset_at = CASE
      WHEN v_now - month_reset_at > interval '30 days' THEN v_now
      ELSE month_reset_at
    END,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing user_usage_tiers row for %', p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_request(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.add_ai_token_usage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_ai_token_usage(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.add_ai_token_usage(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.add_ai_token_usage(uuid, integer) TO service_role;
