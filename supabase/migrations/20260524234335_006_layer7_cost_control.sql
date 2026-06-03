/*
  # Layer 7: Cost Control and API Usage Protection

  Adds tables for internal usage tracking, rate limiting, and future
  subscription tier management. No data is ever exposed in the UI.

  ## New Tables

  ### ai_usage_log
  - Stores one row per AI request for internal monitoring.
  - Tracks: user, conversation, provider, model, estimated tokens,
    response time, safety category, and tier snapshot.
  - RLS: users can only read their own rows (no write from client).

  ### user_usage_tiers
  - One row per user, defines their current tier and daily/monthly quotas.
  - Tiers: free | basic | premium
  - daily_requests_used / monthly_tokens_used are reset externally.
  - RLS: users can read their own row; only service role may write.

  ## Security
  - Both tables have RLS enabled.
  - Client-side writes are blocked; writes go through edge function
    using service-role key.
  - user_usage_tiers is read-only from the client.
*/

-- ── ai_usage_log ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id   uuid,
  provider          text        NOT NULL DEFAULT '',
  model             text        NOT NULL DEFAULT '',
  prompt_tokens     int         NOT NULL DEFAULT 0,
  completion_tokens int         NOT NULL DEFAULT 0,
  total_tokens      int         NOT NULL DEFAULT 0,
  response_ms       int         NOT NULL DEFAULT 0,
  safety_category   text        NOT NULL DEFAULT 'normal',
  tier_snapshot     text        NOT NULL DEFAULT 'free',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_user_created
  ON ai_usage_log (user_id, created_at DESC);

ALTER TABLE ai_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own usage log"
  ON ai_usage_log FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── user_usage_tiers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_usage_tiers (
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

ALTER TABLE user_usage_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own tier"
  ON user_usage_tiers FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Auto-create a free tier row on signup
CREATE OR REPLACE FUNCTION create_usage_tier_for_new_user()
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
  FOR EACH ROW EXECUTE FUNCTION create_usage_tier_for_new_user();
