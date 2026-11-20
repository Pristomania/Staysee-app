-- 097: creation limit uses actual paid term, without quota settlement or data deletion.
-- Depends on095 metadata. Archive read locks are a separate, still required migration.
CREATE OR REPLACE FUNCTION public.enforce_conversation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usage public.user_usage_tiers%ROWTYPE;
  v_tier text;
  v_limit int;
  v_count int;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active IS TRUE THEN
    RETURN NEW;
  END IF;

  -- Serialize with creation, quota and payment grants on the same usage row.
  -- Read the clock AFTER this lock, not now() frozen at transaction start or before a lock wait.
  SELECT u.* INTO v_usage
  FROM public.user_usage_tiers u
  WHERE u.user_id = NEW.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- A missing usage row is not a known free account: never inherit a larger catalog limit.
    v_limit := 1;
  ELSE
    v_tier := CASE
      WHEN v_usage.unlimited_usage IS TRUE OR v_usage.access_source = 'manual'
        THEN v_usage.tier
      WHEN v_usage.access_source = 'purchase'
        AND v_usage.paid_access_until > pg_catalog.clock_timestamp()
        THEN v_usage.tier
      ELSE 'free'
    END;

    SELECT l.max_conversations INTO v_limit
    FROM public.usage_tier_limits l WHERE l.tier = v_tier;
    v_limit := coalesce(v_usage.max_conversations_override, v_limit, 1);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.conversations c
  WHERE c.user_id = NEW.user_id AND c.is_active IS TRUE;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'conversation_limit_reached';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_conversation_limit() FROM PUBLIC, anon, authenticated;
-- Existing087 BEFORE INSERT OR UPDATE OF is_active trigger invokes the replacement.
