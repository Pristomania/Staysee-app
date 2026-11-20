-- Full-price purchased Basic -> Premium: replace included quota, preserve separately bought packs.
-- New30day term is issued by the existing grant branch only after verified payment.
BEGIN;

-- Existing pending orders could not have been created as an active-plan upgrade under095.
-- Keep intent to distinguish manual revocation after an upgrade checkout from a normal Free purchase.
ALTER TABLE public.billing_live_orders ADD COLUMN purchase_kind text NOT NULL DEFAULT 'new_period'
  CHECK(purchase_kind IN ('new_period','upgrade'));

CREATE OR REPLACE FUNCTION public.create_billing_live_order(p_user_id uuid,p_product_id text,p_idempotency_key uuid,p_merchant_login text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.user_usage_tiers%ROWTYPE; v_order public.billing_live_orders%ROWTYPE;
  v_now timestamptz; v_amount integer; v_name text;
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
  v_now:=clock_timestamp();
  IF NOT FOUND OR v_row.is_suspended OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND room_deletion_requested_at IS NULL) THEN
    RAISE EXCEPTION 'account_inactive' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_order FROM public.billing_live_orders
    WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_order.product_id<>p_product_id THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='22023'; END IF;
    RETURN to_jsonb(v_order)-'idempotency_key';
  END IF;
  IF p_product_id<>'pack100' AND NOT (p_product_id='premium' AND v_row.tier='basic' AND v_row.access_source='purchase'
    AND NOT v_row.unlimited_usage AND v_row.paid_access_until>v_now) AND (v_row.unlimited_usage OR
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
  INSERT INTO public.billing_live_orders(user_id,merchant_login,product_id,amount_kopecks,product_name,idempotency_key,created_at,expires_at,purchase_kind)
    VALUES(p_user_id,p_merchant_login,p_product_id,v_amount,v_name,p_idempotency_key,v_now,v_now+interval '1 hour',
      CASE WHEN p_product_id='premium' AND v_row.tier='basic' AND v_row.access_source='purchase'
        AND NOT v_row.unlimited_usage AND v_row.paid_access_until>v_now THEN 'upgrade' ELSE 'new_period' END) RETURNING * INTO v_order;
  RETURN to_jsonb(v_order)-'idempotency_key';
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_billing_live_order(p_order_id uuid,p_amount_kopecks integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_order public.billing_live_orders%ROWTYPE; v_row public.user_usage_tiers%ROWTYPE;
  v_owner uuid; v_now timestamptz; v_reason text; v_pack jsonb;
BEGIN
  -- Nonlocking owner lookup only; ownership can become NULL on auth deletion, but is never reassigned.
  SELECT user_id INTO v_owner FROM public.billing_live_orders WHERE id=p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF v_owner IS NOT NULL THEN
    SELECT * INTO v_row FROM public.user_usage_tiers WHERE user_id=v_owner FOR UPDATE;
  END IF;
  SELECT * INTO v_order FROM public.billing_live_orders WHERE id=p_order_id FOR UPDATE;
  -- Eligibility and the full term start after both serialization locks, not at transaction start.
  v_now:=clock_timestamp();
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
    IF v_order.purchase_kind='upgrade' AND v_row.access_source='manual' THEN
      v_reason:='manual_access';
    ELSIF v_order.product_id<>'pack100' AND NOT (v_order.product_id='premium' AND v_row.tier='basic' AND v_row.access_source='purchase'
    AND NOT v_row.unlimited_usage AND v_row.paid_access_until>v_now) AND (v_row.unlimited_usage OR
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

REVOKE ALL ON FUNCTION public.create_billing_live_order(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.confirm_billing_live_order(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_billing_live_order(uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_billing_live_order(uuid,integer) TO service_role;
COMMIT;

