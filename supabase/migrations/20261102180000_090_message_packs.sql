-- 090_message_packs
-- Bought messages: a pack of messages that a person adds to any plan, the free one included.
--
-- A pack is spent only after the messages of the plan are used up. A pack lives 12 months from the purchase and is
-- spent in the order it ends: the oldest first. Each pack also carries a small allowance of money that is added to the
-- quiet ceiling while the pack still has messages, so that a person who paid for messages is not stopped by the ceiling
-- of a plan they have already used up (and, with the plan's messages still left, a person who hit the ceiling goes on
-- as a plan message, the pack untouched). The person sees messages only, never money. The free plan's idle renewal
-- clock (last_request_at) moves with every answered message, a bought one too: "three months after the last message".
--
-- Nothing here takes payment: a pack is added by the service (grant_message_pack), which the payment code will call
-- when there is a payment. A payment reference is required and never granted twice (and never for another person).
-- A pack that is refunded is voided by the service (void_message_pack). The visible numbers of a pack are in
-- supabase/functions/_shared/plans.ts (PACK).
--
-- Additive: one table, two service-only functions, and reserve_ai_request with the same signature and every check of
-- 088; the only new thing is the pack taking over when the plan has nothing left to give.

CREATE TABLE IF NOT EXISTS public.message_packs (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  messages_total     int           NOT NULL CHECK (messages_total > 0),
  messages_left      int           NOT NULL CHECK (messages_left >= 0 AND messages_left <= messages_total),
  cost_allowance_usd numeric(10,4) NOT NULL CHECK (cost_allowance_usd >= 0),
  purchased_at       timestamptz   NOT NULL DEFAULT now(),
  expires_at         timestamptz   NOT NULL,
  payment_ref        text          NOT NULL UNIQUE,
  voided_at          timestamptz
);

COMMENT ON TABLE public.message_packs IS
  'Bought messages. Spent after the plan''s messages, oldest-ending pack first; 12 months from the purchase. Written only by the service.';
COMMENT ON COLUMN public.message_packs.payment_ref IS
  'The payment this pack was bought with; unique, so a repeated notice of the same payment does not grant a second pack.';

CREATE INDEX IF NOT EXISTS message_packs_open_idx
  ON public.message_packs (user_id, expires_at)
  WHERE messages_left > 0 AND voided_at IS NULL;

ALTER TABLE public.message_packs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own message packs" ON public.message_packs;
CREATE POLICY "Users can read own message packs"
  ON public.message_packs FOR SELECT
  USING (auth.uid() = user_id);

-- A person reads their balance and nothing more: no pack can be added, changed or removed from the app.
REVOKE ALL ON public.message_packs FROM PUBLIC;
REVOKE ALL ON public.message_packs FROM anon;
REVOKE ALL ON public.message_packs FROM authenticated;
GRANT SELECT ON public.message_packs TO authenticated;

-- Adds a pack to a person. 100 messages by default, valid 12 months, with 0.035 USD of quiet allowance per message.
-- The payment reference is required (a manual grant names itself, for example 'manual-<reason>'): without one a retried
-- payment notice could not be told from a new payment. A reference that was already granted to the same person returns
-- the first pack and grants nothing; one that belongs to somebody else is an error.
CREATE OR REPLACE FUNCTION public.grant_message_pack(
  p_user_id     uuid,
  p_messages    int  DEFAULT 100,
  p_payment_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now     timestamptz := now();
  v_pack_id uuid;
  v_owner   uuid;
BEGIN
  IF p_messages IS NULL OR p_messages < 1 OR p_messages > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_pack_size';
  END IF;

  IF p_payment_ref IS NULL OR btrim(p_payment_ref) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'payment_ref_required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_usage_tiers WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unknown_user';
  END IF;

  INSERT INTO public.message_packs (user_id, messages_total, messages_left, cost_allowance_usd, purchased_at, expires_at, payment_ref)
  VALUES (p_user_id, p_messages, p_messages, round(p_messages * 0.035, 4), v_now, v_now + interval '12 months', p_payment_ref)
  ON CONFLICT (payment_ref) DO NOTHING
  RETURNING id INTO v_pack_id;

  IF v_pack_id IS NULL THEN
    SELECT id, user_id INTO v_pack_id, v_owner FROM public.message_packs WHERE payment_ref = p_payment_ref;
    IF v_owner <> p_user_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'payment_ref_taken';
    END IF;
    RETURN jsonb_build_object('granted', false, 'duplicate', true, 'pack_id', v_pack_id);
  END IF;

  RETURN jsonb_build_object('granted', true, 'duplicate', false, 'pack_id', v_pack_id, 'messages', p_messages);
END;
$$;

-- Voids what is left of a pack (a refund). Says how many messages were bought and how many were still unused, so that
-- the refund can be worked out from it. Voiding twice does nothing.
CREATE OR REPLACE FUNCTION public.void_message_pack(p_pack_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pack public.message_packs%ROWTYPE;
BEGIN
  SELECT * INTO v_pack FROM public.message_packs WHERE id = p_pack_id FOR UPDATE;

  IF NOT FOUND OR v_pack.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('voided', false);
  END IF;

  UPDATE public.message_packs SET messages_left = 0, voided_at = now() WHERE id = p_pack_id;

  RETURN jsonb_build_object(
    'voided', true,
    'bought_messages', v_pack.messages_total,
    'unused_messages', v_pack.messages_left
  );
END;
$$;

REVOKE ALL ON FUNCTION public.grant_message_pack(uuid, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_message_pack(uuid, int, text) FROM anon;
REVOKE ALL ON FUNCTION public.grant_message_pack(uuid, int, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grant_message_pack(uuid, int, text) TO service_role;

REVOKE ALL ON FUNCTION public.void_message_pack(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_message_pack(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.void_message_pack(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.void_message_pack(uuid) TO service_role;

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
  IF v_has_limits AND v_limits.period_kind = 'month' AND v_now - v_period_start > interval '30 days' THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  -- A plan that renews by idleness (the free one): N calendar months after the last message the count
  -- and the money start again. A person with no message yet counts from the period start.
  IF v_has_limits
     AND v_limits.renew_after_idle_months IS NOT NULL
     AND v_now >= coalesce(v_row.last_request_at, v_row.period_started_at)
                  + make_interval(months => v_limits.renew_after_idle_months) THEN
    v_period_used := 0;
    v_period_start := v_now;
  END IF;

  IF v_has_limits THEN
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
      SELECT count(*), coalesce(sum(cost_allowance_usd), 0)
      INTO v_open_packs, v_allowance
      FROM public.message_packs
      WHERE user_id = p_user_id
        AND voided_at IS NULL
        AND messages_left > 0
        AND expires_at > v_now;

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
