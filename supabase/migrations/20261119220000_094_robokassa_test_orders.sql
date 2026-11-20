-- Isolated TEST ledger. No paid history, access, quota or plan changes in this migration.
-- Do not deploy from this branch until reconciled with parallel migration work.
CREATE TABLE public.robokassa_test_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id bigint GENERATED ALWAYS AS IDENTITY (START WITH 1000000000000) UNIQUE NOT NULL
    CHECK (invoice_id > 0 AND invoice_id <= 9007199254740991),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  merchant_login text NOT NULL CHECK (merchant_login ~ '^[A-Za-z0-9_-]{1,100}$'),
  idempotency_key uuid NOT NULL,
  mode text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  product_id text NOT NULL CHECK (product_id IN ('basic','premium','pack100')),
  amount_kopecks integer NOT NULL CHECK (amount_kopecks > 0),
  product_name text NOT NULL,
  receipt_json text NOT NULL CHECK (length(receipt_json)<=2048),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','test_paid','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '1 hour'),
  paid_at timestamptz,
  UNIQUE (user_id,merchant_login,idempotency_key),
  CHECK ((status IN ('pending','expired') AND paid_at IS NULL) OR (status='test_paid' AND paid_at IS NOT NULL))
);
CREATE INDEX robokassa_test_orders_user_created ON public.robokassa_test_orders(user_id,created_at);
COMMENT ON TABLE public.robokassa_test_orders IS 'Test-only payment ledger. Successful test callbacks NEVER grant real access or mark an account as previously paid.';
ALTER TABLE public.robokassa_test_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.robokassa_test_orders FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.robokassa_test_orders_invoice_id_seq FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.robokassa_test_orders TO service_role;
-- Service-only cleanup of disposable test fixtures; never a customer permission.
GRANT DELETE ON public.robokassa_test_orders TO service_role;
-- No authenticated table read policy: even removed/suspended testers must use the gated status handler.

CREATE FUNCTION public.robokassa_test_order_json(p public.robokassa_test_orders)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT jsonb_build_object('invoiceId',p.invoice_id::text,'userId',p.user_id,'merchantLogin',p.merchant_login,
    'mode',p.mode,'productId',p.product_id,'amountKopecks',p.amount_kopecks,'status',p.status,
    'productName',p.product_name,'receiptJson',p.receipt_json);
$$;
REVOKE ALL ON FUNCTION public.robokassa_test_order_json(public.robokassa_test_orders) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.create_robokassa_test_order(p_user_id uuid,p_product_id text,p_idempotency_key uuid,p_merchant_login text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_suspended boolean;
  v_order public.robokassa_test_orders%ROWTYPE;
  v_amount integer;
  v_name text;
BEGIN
  IF p_idempotency_key IS NULL OR p_merchant_login IS NULL OR p_merchant_login !~ '^[A-Za-z0-9_-]{1,100}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_order';
  END IF;
  CASE p_product_id
    WHEN 'basic' THEN v_amount:=199000;v_name:='StaySee AI: Базовый, 30 дней';
    WHEN 'premium' THEN v_amount:=490000;v_name:='StaySee AI: Премиум, 30 дней';
    WHEN 'pack100' THEN v_amount:=59000;v_name:='StaySee AI: 100 сообщений';
    ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='unknown_product';
  END CASE;
  -- Serializes retries/rate-limit checks per user without changing the usage row.
  SELECT is_suspended INTO v_suspended FROM public.user_usage_tiers WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_suspended IS DISTINCT FROM false
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_user_id AND room_deletion_requested_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='account_unavailable';
  END IF;
  -- Expire abandoned test checkouts; retain their IDs/receipt so a delayed signed result can still be recorded.
  UPDATE public.robokassa_test_orders SET status='expired'
    WHERE user_id=p_user_id AND status='pending' AND expires_at<=now();
  SELECT * INTO v_order FROM public.robokassa_test_orders
    WHERE user_id=p_user_id AND merchant_login=p_merchant_login AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_order.product_id<>p_product_id THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='idempotency_conflict';END IF;
    RETURN public.robokassa_test_order_json(v_order);
  END IF;
  IF p_product_id IN ('basic','premium') AND EXISTS (
    SELECT 1 FROM public.robokassa_test_orders WHERE user_id=p_user_id AND merchant_login=p_merchant_login
      AND status='pending' AND product_id IN ('basic','premium')
  ) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='monthly_order_pending';END IF;
  IF (SELECT count(*) FROM public.robokassa_test_orders WHERE user_id=p_user_id AND created_at>now()-interval '1 minute')>=3
    OR (SELECT count(*) FROM public.robokassa_test_orders WHERE user_id=p_user_id AND created_at>now()-interval '1 hour')>=10
    OR (SELECT count(*) FROM public.robokassa_test_orders WHERE user_id=p_user_id AND status='pending')>=3 THEN
    RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='too_many_orders';
  END IF;
  INSERT INTO public.robokassa_test_orders(user_id,merchant_login,idempotency_key,product_id,amount_kopecks,product_name,receipt_json)
    VALUES(p_user_id,p_merchant_login,p_idempotency_key,p_product_id,v_amount,v_name,
      jsonb_build_object('sno','usn_income','items',jsonb_build_array(jsonb_build_object(
        'name',v_name,'quantity',1,'sum',v_amount/100.0,'payment_method','full_prepayment','payment_object','service','tax','none'
      )))::text) RETURNING * INTO v_order;
  RETURN public.robokassa_test_order_json(v_order);
END;
$$;

CREATE FUNCTION public.settle_robokassa_test_order(p_invoice_id bigint,p_amount_kopecks integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_order public.robokassa_test_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.robokassa_test_orders WHERE invoice_id=p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='unknown_order';END IF;
  IF p_amount_kopecks IS NULL OR p_amount_kopecks<>v_order.amount_kopecks THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='amount_mismatch';
  END IF;
  IF v_order.status='test_paid' THEN RETURN jsonb_build_object('status','test_paid','duplicate',true);END IF;
  -- This is deliberately the ONLY state changed. Never call entitlement-grant functions here.
  UPDATE public.robokassa_test_orders SET status='test_paid',paid_at=now() WHERE id=v_order.id;
  RETURN jsonb_build_object('status','test_paid','duplicate',false);
END;
$$;
REVOKE ALL ON FUNCTION public.create_robokassa_test_order(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_robokassa_test_order(bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_robokassa_test_order(uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_robokassa_test_order(bigint,integer) TO service_role;
