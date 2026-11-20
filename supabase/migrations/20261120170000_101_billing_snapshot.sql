-- Own, consistent, read-only billing projection. Deploy only with095, UI and remaining access protections.
CREATE OR REPLACE FUNCTION public.get_my_billing_snapshot()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid:=auth.uid(); v_row public.user_usage_tiers%ROWTYPE; v_now timestamptz;
  v_expired boolean; v_tier text; v_packs jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_row FROM public.user_usage_tiers WHERE user_id=v_uid FOR UPDATE;
  IF NOT FOUND OR v_row.is_suspended OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=v_uid AND room_deletion_requested_at IS NULL) THEN RETURN NULL; END IF;
  -- After the lock: transaction-start time can be stale after waiting for a concurrent grant.
  v_now:=clock_timestamp();
  v_expired:=v_row.access_source='purchase' AND NOT v_row.unlimited_usage AND v_row.paid_access_until<=v_now;
  v_tier:=CASE WHEN v_expired OR v_row.tier NOT IN('free','basic','premium') THEN 'free' ELSE v_row.tier END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('messages_left',messages_left,'expires_at',expires_at,'voided_at',voided_at) ORDER BY expires_at,purchased_at,id),'[]'::jsonb)
    INTO v_packs FROM public.message_packs WHERE user_id=v_uid AND voided_at IS NULL AND messages_left>0 AND expires_at>v_now;
  RETURN jsonb_build_object('version',1,'userId',v_uid,'serverNow',v_now,'usage',jsonb_build_object(
    'tier',v_tier,'period_requests_used',CASE WHEN v_expired THEN 50 ELSE v_row.period_requests_used END,
    'period_started_at',v_row.period_started_at,'last_request_at',v_row.last_request_at,
    'unlimited_usage',v_row.unlimited_usage,'max_conversations_override',v_row.max_conversations_override,
    'access_source',v_row.access_source,'paid_access_until',v_row.paid_access_until,'first_real_purchase_at',v_row.first_real_purchase_at
  ),'packs',v_packs);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_billing_snapshot() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_my_billing_snapshot() TO authenticated;

-- reserve095 is carried forward below with response metadata only; quota/funding/locking algorithm unchanged.
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
  v_spent        numeric := 0;
  v_limit_hit    boolean := false;
  v_cap_hit      boolean := false;
  v_pack_id      uuid;
  v_use_pack     boolean := false;
  v_open_packs   int;
  v_allowance    numeric;
BEGIN
  PERFORM public.expire_purchased_access(p_user_id);
  SELECT *
  INTO v_row
  FROM public.user_usage_tiers
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', false,
      'tier', 'free',
      'reason', 'missing_tier'
    );
  END IF;

  IF v_row.is_suspended THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'suspended'
    );
  END IF;

  v_day_expired := v_now - v_row.day_reset_at > interval '24 hours';

  -- Unlimited: let through before any limit; the counters and the clock still run.
  IF v_row.unlimited_usage THEN
    UPDATE public.user_usage_tiers
    SET
      daily_requests_used = CASE WHEN v_day_expired THEN 1 ELSE daily_requests_used + 1 END,
      day_reset_at = CASE WHEN v_day_expired THEN v_now ELSE day_reset_at END,
      period_requests_used = period_requests_used + 1,
      last_request_at = v_now,
      updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', true,
      'tier', v_row.tier
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
  IF v_row.access_source <> 'purchase' AND v_has_limits AND v_limits.period_kind = 'month' AND v_now - v_period_start > interval '30 days' THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  -- A plan that renews by idleness (the free one): N calendar months after the last message the count
  -- and the money start again. A person with no message yet counts from the period start.
  IF v_has_limits AND v_row.first_real_purchase_at IS NULL
     AND v_limits.renew_after_idle_months IS NOT NULL
     AND v_now >= coalesce(v_row.last_request_at, v_row.period_started_at)
                  + make_interval(months => v_limits.renew_after_idle_months) THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  IF v_has_limits THEN
    -- Serialize on usage (held above), then snapshot each pack's share in this accounting phase once.
    -- Do not drop already-funded spending merely because the pack's message balance became zero.
    UPDATE public.message_packs SET cost_budget_period_at=v_period_start,
      cost_budget_usd=CASE
        WHEN voided_at IS NOT NULL THEN 0
        WHEN purchased_at>=v_period_start THEN cost_allowance_usd
        WHEN expires_at>v_now THEN round(cost_allowance_usd*messages_left/messages_total,4)
        ELSE 0 END
      WHERE user_id=p_user_id AND cost_budget_period_at IS DISTINCT FROM v_period_start;
    -- The visible limit and the quiet ceiling (the money already spent on this person in the period).
    v_limit_hit := v_limits.period_request_limit IS NOT NULL AND v_period_used >= v_limits.period_request_limit;

    IF v_limits.cost_cap_usd IS NOT NULL THEN
      SELECT coalesce(sum(cost), 0)
      INTO v_spent
      FROM public.ai_usage_logs
      WHERE user_id = p_user_id
        AND created_at >= v_period_start;

      v_cap_hit := v_spent >= v_limits.cost_cap_usd;
    END IF;

    IF v_limit_hit OR v_cap_hit THEN
      -- The plan has nothing more to give, or the quiet ceiling is reached: only bought messages can go on.
      SELECT count(*) FILTER(WHERE voided_at IS NULL AND messages_left>0 AND expires_at>v_now),
        coalesce(sum(cost_budget_usd), 0)
      INTO v_open_packs, v_allowance
      FROM public.message_packs
      WHERE user_id = p_user_id AND cost_budget_period_at=v_period_start;

      IF v_open_packs = 0 THEN
        RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
          'allowed', false,
          'tier', v_row.tier,
          'reason', CASE WHEN v_limit_hit THEN 'period_limit' ELSE 'cost_cap' END
        );
      END IF;

      -- The bought messages raise the quiet ceiling by their allowance.
      IF v_limits.cost_cap_usd IS NOT NULL AND v_spent >= v_limits.cost_cap_usd + v_allowance THEN
        RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
          'allowed', false,
          'tier', v_row.tier,
          'reason', 'cost_cap'
        );
      END IF;

      -- A pack is spent only when the plan's own messages are out, the one that ends first goes first. With plan
      -- messages left (only the ceiling was reached) this message is a plan message and the pack stays whole.
      IF v_limit_hit THEN
        SELECT id
        INTO v_pack_id
        FROM public.message_packs
        WHERE user_id = p_user_id
          AND voided_at IS NULL
          AND messages_left > 0
          AND expires_at > v_now
        ORDER BY expires_at, purchased_at
        LIMIT 1
        FOR UPDATE;

        IF v_pack_id IS NULL THEN
          RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
            'allowed', false,
            'tier', v_row.tier,
            'reason', 'period_limit'
          );
        END IF;

        v_use_pack := true;
      END IF;
    END IF;
  END IF;

  IF NOT v_day_expired AND v_row.daily_requests_used >= v_row.daily_request_limit THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'daily_limit'
    );
  END IF;

  IF v_use_pack THEN
    UPDATE public.message_packs
    SET messages_left = messages_left - 1
    WHERE id = v_pack_id;
  END IF;

  -- Only here, for an allowed message, the clock of the last message moves. A message taken from a pack does not
  -- count against the plan's own messages.
  UPDATE public.user_usage_tiers
  SET
    daily_requests_used = CASE WHEN v_day_expired THEN 1 ELSE daily_requests_used + 1 END,
    day_reset_at = CASE WHEN v_day_expired THEN v_now ELSE day_reset_at END,
    period_requests_used = CASE WHEN v_use_pack THEN v_period_used ELSE v_period_used + 1 END,
    period_started_at = v_period_start,
    last_request_at = v_now,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF v_use_pack THEN
    RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
      'allowed', true,
      'tier', v_row.tier,
      'from_pack', true
    );
  END IF;

  RETURN jsonb_build_object(
      'can_renew_messages', coalesce(v_row.access_source <> 'purchase' AND (v_row.tier <> 'free' OR v_row.first_real_purchase_at IS NULL),false),
    'allowed', true,
    'tier', v_row.tier
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_request(uuid) TO service_role;



