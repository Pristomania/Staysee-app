-- 087_plan_features
-- Conversations per plan, enforced by the database, and the premium plan's limits.
--
--   free    : 1 conversation   (deleting it opens the place for a new one)
--   basic   : 3 conversations
--   premium : 6 conversations, 1000 messages per 30 days, hidden spending ceiling 24 USD (about 2 200 RUB at 90)
--
-- Until now the limit of conversations (5) lived only in the app. The database now refuses a new active
-- conversation when the person already has as many as the plan allows, so the app is a convenience and not the guard.
-- Existing conversations are never touched: a person who moves to a lower plan keeps what they have and just cannot
-- add more until they are under the limit.
--
-- A person can be given another number by hand (max_conversations_override): the founders' accounts and the technical
-- test user. Numbers per plan live here and in supabase/functions/_shared/plans.ts (a test compares them).
-- Additive: two columns, one row, one trigger.

ALTER TABLE public.usage_tier_limits
  ADD COLUMN IF NOT EXISTS max_conversations int NOT NULL DEFAULT 1 CHECK (max_conversations > 0);

COMMENT ON COLUMN public.usage_tier_limits.max_conversations IS
  'Active conversations a person on this plan may have at the same time.';

UPDATE public.usage_tier_limits SET max_conversations = 1 WHERE tier = 'free';
UPDATE public.usage_tier_limits SET max_conversations = 3 WHERE tier = 'basic';

INSERT INTO public.usage_tier_limits (tier, period_kind, period_request_limit, cost_cap_usd, max_conversations)
VALUES ('premium', 'month', 1000, 24.00, 6)
ON CONFLICT (tier) DO NOTHING;

ALTER TABLE public.user_usage_tiers
  ADD COLUMN IF NOT EXISTS max_conversations_override int CHECK (max_conversations_override > 0);

COMMENT ON COLUMN public.user_usage_tiers.max_conversations_override IS
  'A number of conversations given to this person by hand instead of the plan''s. NULL = the plan''s number.';

-- The founders' accounts had no limit in the app (src/lib/roomLimits.ts); they keep it.
UPDATE public.user_usage_tiers
SET max_conversations_override = 100
WHERE user_id IN (
  'cff5913e-10d2-4168-82de-ec0c0ff48929',
  'ad52b415-875a-45e9-9f6b-be4d25a2c0e0',
  '0acde6d0-2741-4992-b876-d77eab0f6d15'
);

CREATE OR REPLACE FUNCTION public.enforce_conversation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit int;
  v_count int;
BEGIN
  -- An inactive row takes no place.
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- The row of the person is locked, so two conversations created at the same moment cannot both slip under the limit.
  SELECT coalesce(u.max_conversations_override, l.max_conversations)
  INTO v_limit
  FROM public.user_usage_tiers AS u
  LEFT JOIN public.usage_tier_limits AS l ON l.tier = u.tier
  WHERE u.user_id = NEW.user_id
  FOR UPDATE OF u;

  -- No row for the person, or a plan without a row here: the strictest number, never an open door.
  v_limit := coalesce(v_limit, 1);

  SELECT count(*)
  INTO v_count
  FROM public.conversations AS c
  WHERE c.user_id = NEW.user_id
    AND c.is_active IS TRUE;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'conversation_limit_reached';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_conversation_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_conversation_limit ON public.conversations;

CREATE TRIGGER enforce_conversation_limit
BEFORE INSERT ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_conversation_limit();
