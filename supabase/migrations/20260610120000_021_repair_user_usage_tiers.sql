/*
  # Repair: user_usage_tiers stack (migration 006/007 drift)

  Context: migrations 006 and 007 are marked applied on production, but
  user_usage_tiers, increment_usage(), and the signup trigger are missing.

  Idempotent repair only — safe to run on environments where objects already exist.

  Does NOT touch: ai_usage_log, memory, messages, staysee-chat edge code.
*/

-- ── user_usage_tiers table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_usage_tiers (
  user_id               uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier                  text        NOT NULL DEFAULT 'free',
  daily_request_limit   int         NOT NULL DEFAULT 50,
  monthly_token_limit   int         NOT NULL DEFAULT 500000,
  daily_requests_used   int         NOT NULL DEFAULT 0,
  monthly_tokens_used   int         NOT NULL DEFAULT 0,
  day_reset_at          timestamptz NOT NULL DEFAULT now(),
  month_reset_at        timestamptz NOT NULL DEFAULT now(),
  is_suspended          boolean     NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_usage_tiers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_usage_tiers'
      AND policyname = 'Users can read own tier'
  ) THEN
    CREATE POLICY "Users can read own tier"
      ON public.user_usage_tiers FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── Signup trigger: auto-create free tier row ────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_usage_tier_for_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_usage_tiers (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_usage_tier ON auth.users;
CREATE TRIGGER on_auth_user_created_usage_tier
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.create_usage_tier_for_new_user();

-- ── increment_usage RPC (edge function, service role) ─────────────────────────

CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id uuid, p_tokens int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  INSERT INTO public.user_usage_tiers (
    user_id,
    daily_requests_used,
    monthly_tokens_used,
    day_reset_at,
    month_reset_at,
    updated_at
  )
  VALUES (p_user_id, 1, p_tokens, v_now, v_now, v_now)
  ON CONFLICT (user_id) DO UPDATE SET
    daily_requests_used = CASE
      WHEN v_now - user_usage_tiers.day_reset_at > interval '24 hours'
      THEN 1
      ELSE user_usage_tiers.daily_requests_used + 1
    END,
    day_reset_at = CASE
      WHEN v_now - user_usage_tiers.day_reset_at > interval '24 hours'
      THEN v_now
      ELSE user_usage_tiers.day_reset_at
    END,
    monthly_tokens_used = CASE
      WHEN v_now - user_usage_tiers.month_reset_at > interval '30 days'
      THEN p_tokens
      ELSE user_usage_tiers.monthly_tokens_used + p_tokens
    END,
    month_reset_at = CASE
      WHEN v_now - user_usage_tiers.month_reset_at > interval '30 days'
      THEN v_now
      ELSE user_usage_tiers.month_reset_at
    END,
    updated_at = v_now;
END;
$$;

-- ── Backfill: existing auth.users without a tier row ─────────────────────────

INSERT INTO public.user_usage_tiers (user_id)
SELECT u.id
FROM auth.users AS u
LEFT JOIN public.user_usage_tiers AS t ON t.user_id = u.id
WHERE t.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;
