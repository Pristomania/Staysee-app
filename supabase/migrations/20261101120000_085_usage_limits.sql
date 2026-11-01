-- 085_usage_limits
-- Message limits per plan and a hidden spending ceiling per person.
--
--   free    : 50 messages in total (a trial, it does not renew), ceiling 2.50 USD (about 225 RUB at 90)
--   basic   : 400 messages per 30 days, ceiling 10 USD (about 900 RUB at 90)
--   premium : not priced yet, no row here, so only the daily guard applies
--
-- The person sees only the message limit. The ceiling is a quiet second line: if the money spent on one person
-- (answers, memory work, pictures) reaches it first, for example in very long chats, the person gets the same
-- "messages used up" text. The money is summed from ai_usage_logs, the OpenRouter cost of every call.
--
-- Numbers live in a table, so one UPDATE changes a plan without a deploy.
-- Additive: one new table and two new columns. reserve_ai_request keeps its signature and its checks
-- (missing_tier, suspended, daily_limit) and gains two more: period_limit and cost_cap.

CREATE TABLE IF NOT EXISTS public.usage_tier_limits (
  tier                 text           PRIMARY KEY,
  period_kind          text           NOT NULL CHECK (period_kind IN ('lifetime', 'month')),
  -- NULL means "no limit of this kind".
  period_request_limit int            CHECK (period_request_limit > 0),
  cost_cap_usd         numeric(10, 4) CHECK (cost_cap_usd > 0)
);

COMMENT ON TABLE public.usage_tier_limits IS
  'Per plan: messages per period and a hidden spending ceiling (USD). Read only by reserve_ai_request.';

ALTER TABLE public.usage_tier_limits ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: people must not read the ceiling.
REVOKE ALL ON public.usage_tier_limits FROM anon, authenticated;

INSERT INTO public.usage_tier_limits (tier, period_kind, period_request_limit, cost_cap_usd)
VALUES
  ('free',  'lifetime', 50,  2.50),
  ('basic', 'month',    400, 10.00)
ON CONFLICT (tier) DO NOTHING;

-- Counters per person. Existing accounts start counting from the moment this migration runs.
ALTER TABLE public.user_usage_tiers
  ADD COLUMN IF NOT EXISTS period_requests_used int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_started_at    timestamptz NOT NULL DEFAULT now();

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

  -- A month plan starts a new period after 30 days. A lifetime plan (the free trial) never does.
  IF v_has_limits AND v_limits.period_kind = 'month' AND v_now - v_period_start > interval '30 days' THEN
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

  UPDATE public.user_usage_tiers
  SET
    daily_requests_used = CASE WHEN v_day_expired THEN 1 ELSE daily_requests_used + 1 END,
    day_reset_at = CASE WHEN v_day_expired THEN v_now ELSE day_reset_at END,
    period_requests_used = v_period_used + 1,
    period_started_at = v_period_start,
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
