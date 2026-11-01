-- 086_free_tariff_renewal
-- The free messages come back: 3 months after the person's last answered message the count starts again.
--
-- Rule (agreed 01.11.2026): the 3 months are counted from the LAST message the person was answered, not from
-- registration. A refused message (limit reached) does not move the clock, otherwise a person who keeps trying
-- would never get the messages back. When the 3 months pass, the next message finds a fresh count, and the
-- hidden spending ceiling starts from zero together with it (it is counted from the period start).
--
-- Additive: one nullable column per table, one UPDATE of the free plan's row, and reserve_ai_request keeps its
-- signature and all its checks. Paid plans are untouched: they renew by their own 30-day period.

ALTER TABLE public.usage_tier_limits
  ADD COLUMN IF NOT EXISTS renew_after_idle_months int CHECK (renew_after_idle_months > 0);

COMMENT ON COLUMN public.usage_tier_limits.renew_after_idle_months IS
  'NULL = the count never restarts by idleness. N = N calendar months after the last answered message the count restarts.';

-- The time of the last answered message. NULL until the first one: such a person counts from the period start.
ALTER TABLE public.user_usage_tiers
  ADD COLUMN IF NOT EXISTS last_request_at timestamptz;

UPDATE public.usage_tier_limits
SET renew_after_idle_months = 3
WHERE tier = 'free' AND renew_after_idle_months IS NULL;

CREATE OR REPLACE FUNCTION public.reserve_ai_request(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now          timestamptz := now();
  v_row          public.user_usage_tiers%ROWTYPE;
  v_limits       public.usage_tier_limits%ROWTYPE;
  v_has_limits   boolean;
  v_day_expired  boolean;
  v_period_used  int;
  v_period_start timestamptz;
  v_spent        numeric;
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

  SELECT *
  INTO v_limits
  FROM public.usage_tier_limits
  WHERE tier = v_row.tier;
  v_has_limits := FOUND;

  v_period_used := v_row.period_requests_used;
  v_period_start := v_row.period_started_at;

  -- A month plan starts a new period after 30 days.
  IF v_has_limits AND v_limits.period_kind = 'month' AND v_now - v_period_start > interval '30 days' THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  -- A plan that renews by idleness (the free one): N calendar months after the last answered message the count
  -- and the money start again. A person who has not been answered yet counts from the period start.
  IF v_has_limits
     AND v_limits.renew_after_idle_months IS NOT NULL
     AND v_now >= coalesce(v_row.last_request_at, v_row.period_started_at)
                  + make_interval(months => v_limits.renew_after_idle_months) THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  IF v_has_limits THEN
    -- The visible limit first.
    IF v_limits.period_request_limit IS NOT NULL AND v_period_used >= v_limits.period_request_limit THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'tier', v_row.tier,
        'reason', 'period_limit'
      );
    END IF;

    -- The quiet ceiling: money already spent on this person in the period.
    IF v_limits.cost_cap_usd IS NOT NULL THEN
      SELECT coalesce(sum(cost), 0)
      INTO v_spent
      FROM public.ai_usage_logs
      WHERE user_id = p_user_id
        AND created_at >= v_period_start;

      IF v_spent >= v_limits.cost_cap_usd THEN
        RETURN jsonb_build_object(
          'allowed', false,
          'tier', v_row.tier,
          'reason', 'cost_cap'
        );
      END IF;
    END IF;
  END IF;

  v_day_expired := v_now - v_row.day_reset_at > interval '24 hours';

  IF NOT v_day_expired AND v_row.daily_requests_used >= v_row.daily_request_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'daily_limit'
    );
  END IF;

  -- Only here, for an allowed message, the clock of the last message moves.
  UPDATE public.user_usage_tiers
  SET
    daily_requests_used = CASE WHEN v_day_expired THEN 1 ELSE daily_requests_used + 1 END,
    day_reset_at = CASE WHEN v_day_expired THEN v_now ELSE day_reset_at END,
    period_requests_used = v_period_used + 1,
    period_started_at = v_period_start,
    last_request_at = v_now,
    updated_at = v_now
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'tier', v_row.tier
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_request(uuid) TO service_role;
