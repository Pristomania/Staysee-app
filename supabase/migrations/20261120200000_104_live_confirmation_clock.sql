-- ResultURL confirmation clock only; preserve historical 095 and all grant/ACL contracts.
BEGIN;

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

REVOKE ALL ON FUNCTION public.confirm_billing_live_order(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_billing_live_order(uuid,integer) TO service_role;
COMMIT;

