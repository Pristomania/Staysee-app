-- Authenticated self-only verification. No grants, quota reservation or payment writes on reads.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_my_live_payment_status(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC' AS $$
DECLARE v_uid uuid:=auth.uid(); v_usage public.user_usage_tiers%ROWTYPE;
  v_order public.billing_live_orders%ROWTYPE; v_billing jsonb; v_now timestamptz;
  v_until timestamptz; v_current boolean:=false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='42501'; END IF;
  -- Same serialization order as payment confirmation; never lock another user's usage.
  SELECT * INTO v_usage FROM public.user_usage_tiers WHERE user_id=v_uid FOR UPDATE;
  IF NOT FOUND OR v_usage.is_suspended OR NOT EXISTS(
    SELECT 1 FROM public.profiles WHERE id=v_uid AND room_deletion_requested_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT * INTO v_order FROM public.billing_live_orders WHERE id=p_order_id AND user_id=v_uid AND mode='live';
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_billing:=public.get_my_billing_snapshot();
  IF v_billing IS NULL THEN RETURN NULL; END IF;
  v_now:=(v_billing->>'serverNow')::timestamptz;
  IF v_order.status='applied' AND v_order.product_id IN('basic','premium') THEN
    v_until:=v_order.applied_at+interval '30 days';
    v_current:=v_usage.access_source='purchase' AND NOT v_usage.unlimited_usage
      AND v_usage.tier=v_order.product_id AND v_usage.period_started_at=v_order.applied_at
      AND v_usage.paid_access_until=v_until AND v_until>v_now;
  END IF;
  RETURN jsonb_build_object('version',1,'currentGrant',v_current,'billing',v_billing,
    'order',jsonb_build_object('id',v_order.id,'productId',v_order.product_id,
      'purchaseKind',v_order.purchase_kind,'amountKopecks',v_order.amount_kopecks,
      'status',CASE WHEN v_order.status='pending' AND v_order.expires_at<=v_now THEN 'expired' ELSE v_order.status END,
      'expiresAt',v_order.expires_at,'paidAt',v_order.paid_at,'appliedAt',v_order.applied_at,'paidUntil',v_until));
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_live_payment_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_my_live_payment_status(uuid) TO authenticated;
-- Both ends of the contract mean30*24 hours, independent of a caller/session's DST rules.
-- This binding must ship with the read RPC; a reader alone cannot repair a differently calculated grant.
ALTER FUNCTION public.confirm_billing_live_order(uuid,integer) SET timezone='UTC';
COMMIT;
