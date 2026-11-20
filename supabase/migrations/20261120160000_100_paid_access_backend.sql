-- 095: isolated backend foundation. Do NOT deploy/enable sales before UI, archive locks and provider acceptance.
-- No existing account is reclassified as purchased. Test ledger/callback094 remains untouched.
ALTER TABLE public.user_usage_tiers
  ADD COLUMN IF NOT EXISTS access_source text NOT NULL DEFAULT 'manual' CHECK (access_source IN ('manual','purchase')),
  ADD COLUMN IF NOT EXISTS paid_access_until timestamptz,
  ADD COLUMN IF NOT EXISTS first_real_purchase_at timestamptz;
ALTER TABLE public.user_usage_tiers ADD CONSTRAINT usage_purchase_deadline
  CHECK ((access_source='purchase' AND paid_access_until IS NOT NULL) OR (access_source='manual' AND paid_access_until IS NULL));

-- Funding belongs to the accounting period, not only to currently spendable messages.
-- A consumed pack keeps its funded cost in that period; on a new period only its carried remainder funds it.
ALTER TABLE public.message_packs
  ADD COLUMN IF NOT EXISTS cost_budget_period_at timestamptz,
  ADD COLUMN IF NOT EXISTS cost_budget_usd numeric(10,4) NOT NULL DEFAULT 0 CHECK(cost_budget_usd>=0);

CREATE TABLE public.billing_live_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  create_enabled boolean NOT NULL DEFAULT false
);
INSERT INTO public.billing_live_settings(singleton) VALUES(true);
ALTER TABLE public.billing_live_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_live_settings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.billing_live_settings TO service_role;
GRANT UPDATE(create_enabled) ON public.billing_live_settings TO service_role;

CREATE TABLE public.billing_live_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id bigint GENERATED ALWAYS AS IDENTITY (START WITH 2000000000000) UNIQUE CHECK(invoice_id>0 AND invoice_id<=9007199254740991),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  merchant_login text NOT NULL CHECK(merchant_login ~ '^[A-Za-z0-9_-]{1,100}$'),
  mode text NOT NULL DEFAULT 'live' CHECK(mode='live'),
  product_id text NOT NULL CHECK(product_id IN ('basic','premium','pack100')),
  amount_kopecks integer NOT NULL CHECK(amount_kopecks>0 AND amount_kopecks<=1000000000),
  product_name text NOT NULL CHECK(length(product_name) BETWEEN 1 AND 160),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','paid_unfulfilled')),
  fulfillment_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
  paid_at timestamptz,
  applied_at timestamptz,
  UNIQUE(user_id,merchant_login,idempotency_key),
  CHECK((status='pending' AND paid_at IS NULL AND applied_at IS NULL AND fulfillment_reason IS NULL)
     OR (status='applied' AND paid_at IS NOT NULL AND applied_at IS NOT NULL AND fulfillment_reason IS NULL)
     OR (status='paid_unfulfilled' AND paid_at IS NOT NULL AND applied_at IS NULL AND fulfillment_reason IS NOT NULL))
);
CREATE INDEX billing_live_user_created ON public.billing_live_orders(user_id,created_at);
ALTER TABLE public.billing_live_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_live_orders FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.billing_live_orders_invoice_id_seq FROM PUBLIC,anon,authenticated,service_role;
-- No direct service writes: all lifecycle mutations go through the fixed functions below.
GRANT SELECT ON public.billing_live_orders TO service_role;

CREATE OR REPLACE FUNCTION public.expire_purchased_access(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.user_usage_tiers%ROWTYPE; v_now timestamptz:=now();
BEGIN
  SELECT * INTO v_row FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.unlimited_usage THEN RETURN; END IF;
  IF v_row.access_source='purchase' AND v_row.paid_access_until<=v_now AND v_row.tier<>'free' THEN
    -- Trial was forfeited on tariff purchase. Start cost accounting for the new free/pack phase once,
    -- not on every request, so past paid spending cannot block unused purchased packages forever.
    UPDATE public.user_usage_tiers SET tier='free',daily_request_limit=50,
      period_requests_used=50,period_started_at=v_now,updated_at=v_now WHERE user_id=p_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_billing_live_order(p_user_id uuid,p_product_id text,p_idempotency_key uuid,p_merchant_login text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.user_usage_tiers%ROWTYPE; v_order public.billing_live_orders%ROWTYPE;
  v_now timestamptz:=now(); v_amount integer; v_name text;
BEGIN
  IF NOT coalesce((SELECT create_enabled FROM public.billing_live_settings WHERE singleton),false) THEN
    RAISE EXCEPTION 'live_creation_disabled' USING ERRCODE='22023';
  END IF;
  IF p_idempotency_key IS NULL OR p_merchant_login IS NULL OR p_merchant_login !~ '^[A-Za-z0-9_-]{1,100}$' THEN
    RAISE EXCEPTION 'invalid_order_input' USING ERRCODE='22023';
  END IF;
  CASE p_product_id
    WHEN 'basic' THEN v_amount:=199000; v_name:='Базовый StaySee AI, 30 дней';
    WHEN 'premium' THEN v_amount:=490000; v_name:='Премиум StaySee AI, 30 дней';
    WHEN 'pack100' THEN v_amount:=59000; v_name:='100 сообщений StaySee AI';
    ELSE RAISE EXCEPTION 'unknown_product' USING ERRCODE='22023';
  END CASE;
  SELECT * INTO v_row FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.is_suspended OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND room_deletion_requested_at IS NULL) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_order FROM public.billing_live_orders
    WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_order.product_id<>p_product_id THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='22023'; END IF;
    RETURN to_jsonb(v_order)-'idempotency_key';
  END IF;
  IF p_product_id<>'pack100' AND (v_row.unlimited_usage OR
    (v_row.tier<>'free' AND NOT(v_row.access_source='purchase' AND v_row.paid_access_until<=v_now))) THEN
    RAISE EXCEPTION 'monthly_plan_not_purchasable' USING ERRCODE='22023';
  END IF;
  IF p_product_id<>'pack100' AND EXISTS(SELECT 1 FROM public.billing_live_orders
    WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND product_id<>'pack100' AND status='pending' AND expires_at>v_now) THEN
    RAISE EXCEPTION 'monthly_order_pending' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM public.billing_live_orders WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND created_at>v_now-interval '1 minute')>=3
    OR (SELECT count(*) FROM public.billing_live_orders WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND created_at>v_now-interval '1 hour')>=10
    OR (SELECT count(*) FROM public.billing_live_orders WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND status='pending' AND expires_at>v_now)>=3 THEN
    RAISE EXCEPTION 'too_many_orders' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.billing_live_orders(user_id,merchant_login,product_id,amount_kopecks,product_name,idempotency_key)
    VALUES(p_user_id,p_merchant_login,p_product_id,v_amount,v_name,p_idempotency_key) RETURNING * INTO v_order;
  RETURN to_jsonb(v_order)-'idempotency_key';
END;
$$;

-- Trusted service adapter only: validate real provider signature/merchant/mode before calling.
-- The current test adapter has no call path to this function. Creation gate is NOT a money-discard gate:
-- a real confirmation for an existing order remains recorded while new checkouts are disabled.
CREATE OR REPLACE FUNCTION public.confirm_billing_live_order(p_order_id uuid,p_amount_kopecks integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_order public.billing_live_orders%ROWTYPE; v_row public.user_usage_tiers%ROWTYPE;
  v_owner uuid; v_now timestamptz:=now(); v_reason text; v_pack jsonb;
BEGIN
  -- Nonlocking owner lookup only; ownership can become NULL on auth deletion, but is never reassigned.
  SELECT user_id INTO v_owner FROM public.billing_live_orders WHERE id=p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF v_owner IS NOT NULL THEN
    SELECT * INTO v_row FROM public.user_usage_tiers WHERE user_id=v_owner FOR UPDATE;
  END IF;
  SELECT * INTO v_order FROM public.billing_live_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF p_amount_kopecks IS NULL OR p_amount_kopecks<>v_order.amount_kopecks THEN RAISE EXCEPTION 'amount_mismatch' USING ERRCODE='22023'; END IF;
  IF v_order.status<>'pending' THEN
    RETURN jsonb_build_object('status',v_order.status,'duplicate',true,'reason',v_order.fulfillment_reason);
  END IF;
  IF v_order.user_id IS NOT NULL AND v_row.user_id IS NOT NULL THEN
    -- The money is real even if fulfillment is refused. Never manufacture a trial on later unblocking.
    UPDATE public.user_usage_tiers SET first_real_purchase_at=coalesce(first_real_purchase_at,v_now) WHERE user_id=v_row.user_id;
  END IF;
  IF v_order.user_id IS NULL OR v_row.user_id IS NULL OR v_row.is_suspended OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=v_order.user_id AND room_deletion_requested_at IS NULL) THEN
    v_reason:='account_inactive';
  ELSE
    IF v_order.product_id<>'pack100' AND (v_row.unlimited_usage OR
      (v_row.tier<>'free' AND NOT(v_row.access_source='purchase' AND v_row.paid_access_until<=v_now))) THEN
      v_reason:=CASE WHEN v_row.access_source='purchase' THEN 'active_plan' ELSE 'manual_access' END;
    ELSIF v_order.product_id='pack100' THEN
      v_pack:=public.grant_message_pack(v_order.user_id,100,'robokassa-live:'||v_order.id::text);
      IF v_pack->>'granted' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'pack_reference_conflict' USING ERRCODE='22023';
      END IF;
    ELSE
      UPDATE public.user_usage_tiers SET tier=v_order.product_id,access_source='purchase',paid_access_until=v_now+interval '30 days',
        period_requests_used=0,period_started_at=v_now,daily_requests_used=0,day_reset_at=v_now,
        daily_request_limit=CASE v_order.product_id WHEN 'basic' THEN 200 ELSE 1000 END,updated_at=v_now
        WHERE user_id=v_order.user_id;
    END IF;
  END IF;
  UPDATE public.billing_live_orders SET paid_at=v_now,status=CASE WHEN v_reason IS NULL THEN 'applied' ELSE 'paid_unfulfilled' END,
    applied_at=CASE WHEN v_reason IS NULL THEN v_now ELSE NULL END,fulfillment_reason=v_reason WHERE id=p_order_id;
  RETURN jsonb_build_object('status',CASE WHEN v_reason IS NULL THEN 'applied' ELSE 'paid_unfulfilled' END,'duplicate',false,'reason',v_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_purchased_access(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_billing_live_order(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.confirm_billing_live_order(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.expire_purchased_access(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_billing_live_order(uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_billing_live_order(uuid,integer) TO service_role;

-- The existing reserve090 and manual setter089 are carried forward below, with explicit paid-source guards.
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
          'allowed', false,
          'tier', v_row.tier,
          'reason', CASE WHEN v_limit_hit THEN 'period_limit' ELSE 'cost_cap' END
        );
      END IF;

      -- The bought messages raise the quiet ceiling by their allowance.
      IF v_limits.cost_cap_usd IS NOT NULL AND v_spent >= v_limits.cost_cap_usd + v_allowance THEN
        RETURN jsonb_build_object(
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
      'allowed', true,
      'tier', v_row.tier,
      'from_pack', true
    );
  END IF;

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
    access_source = 'manual',
    paid_access_until = NULL,
    daily_request_limit = v_daily,
    daily_requests_used = 0,
    day_reset_at = v_now,
    period_requests_used = CASE WHEN p_tier='free' AND first_real_purchase_at IS NOT NULL THEN 50 ELSE 0 END,
    period_started_at = v_now,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'missing_tier';
  END IF;

  RETURN jsonb_build_object('tier', p_tier, 'period_started_at', v_now);
END;
$$;


REVOKE ALL ON FUNCTION public.set_user_plan(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_plan(uuid,text) TO service_role;

