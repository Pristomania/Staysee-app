-- 089_set_user_plan
-- Changing a person's plan starts a fresh period.
--
-- The counters and the start of the period belong to the plan the person had. Without a reset, a person who moves from
-- free to basic starts with the messages already used on the free plan, the money those messages cost counts against
-- the paid ceiling (it is summed from the start of the period), and the other way round a person who falls back to
-- free would find the free messages already spent by a paid month. So every change goes through this function: the
-- payment code, when it exists, and anyone changing a plan by hand.
--
-- It leaves alone what is not the plan's: the unlimited mark, the number of conversations given by hand, the
-- suspension and the time of the last message (the free messages come back three months after it).
-- Only the service may call it: a person must not change their own plan.

CREATE OR REPLACE FUNCTION public.set_user_plan(p_user_id uuid, p_tier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now   timestamptz := now();
  v_daily int;
BEGIN
  IF p_tier IS NULL OR p_tier NOT IN ('free', 'basic', 'premium') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unknown_plan';
  END IF;

  -- The daily guard of each plan, as in the chat's TIER_CONFIG (supabase/functions/_shared/cost.ts).
  v_daily := CASE p_tier WHEN 'free' THEN 50 WHEN 'basic' THEN 200 ELSE 1000 END;

  UPDATE public.user_usage_tiers
  SET
    tier = p_tier,
    daily_request_limit = v_daily,
    daily_requests_used = 0,
    day_reset_at = v_now,
    period_requests_used = 0,
    period_started_at = v_now,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'missing_tier';
  END IF;

  RETURN jsonb_build_object('tier', p_tier, 'period_started_at', v_now);
END;
$$;

-- The unlimited mark (migration 088) is switched through a function too. While it is on, the counters keep running
-- (the usage stays visible) but nothing refuses, so they may be far past any plan's numbers and the money spent since the
-- start of the period may be large. Switching it OFF therefore starts a fresh period, as a change of plan does; switching it
-- on leaves everything as it is.
CREATE OR REPLACE FUNCTION public.set_unlimited_usage(p_user_id uuid, p_on boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_on IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unknown_value';
  END IF;

  UPDATE public.user_usage_tiers
  SET
    unlimited_usage = p_on,
    period_requests_used = CASE WHEN p_on THEN period_requests_used ELSE 0 END,
    period_started_at = CASE WHEN p_on THEN period_started_at ELSE v_now END,
    daily_requests_used = CASE WHEN p_on THEN daily_requests_used ELSE 0 END,
    day_reset_at = CASE WHEN p_on THEN day_reset_at ELSE v_now END,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'missing_tier';
  END IF;

  RETURN jsonb_build_object('unlimited_usage', p_on);
END;
$$;

REVOKE ALL ON FUNCTION public.set_unlimited_usage(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_unlimited_usage(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.set_unlimited_usage(uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_unlimited_usage(uuid, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.set_user_plan(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_user_plan(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_user_plan(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_plan(uuid, text) TO service_role;
