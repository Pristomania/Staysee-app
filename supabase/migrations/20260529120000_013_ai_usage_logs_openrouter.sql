/*
  # OpenRouter usage analytics — ai_usage_logs

  Canonical table for per-request cost tracking (chat + background summary).
  Complements legacy ai_usage_log; new writes go to ai_usage_logs.
*/

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid           NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id   uuid,
  model             text           NOT NULL,
  prompt_tokens     int            NOT NULL DEFAULT 0,
  completion_tokens int            NOT NULL DEFAULT 0,
  total_tokens      int            NOT NULL DEFAULT 0,
  memory_tokens     int            NOT NULL DEFAULT 0,
  summary_tokens    int            NOT NULL DEFAULT 0,
  cost              numeric(14, 8) NOT NULL DEFAULT 0,
  created_at        timestamptz    NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_usage_logs IS 'Per OpenRouter request: tokens, memory breakdown, USD cost';
COMMENT ON COLUMN ai_usage_logs.memory_tokens IS 'Estimated tokens: cross-conversation user_memory in prompt';
COMMENT ON COLUMN ai_usage_logs.summary_tokens IS 'Estimated tokens: conversation_summary block in prompt';
COMMENT ON COLUMN ai_usage_logs.cost IS 'USD; from OpenRouter usage.cost or pricing fallback';

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at
  ON ai_usage_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
  ON ai_usage_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_conversation
  ON ai_usage_logs (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_usage_logs' AND policyname = 'Users can read own usage logs'
  ) THEN
    CREATE POLICY "Users can read own usage logs"
      ON ai_usage_logs FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── Admin / dashboard views (service_role or SQL editor) ─────────────────────

CREATE OR REPLACE VIEW v_analytics_daily_cost AS
SELECT
  date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
  count(*)::bigint AS requests,
  coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
  coalesce(sum(memory_tokens), 0)::bigint AS memory_tokens,
  coalesce(sum(summary_tokens), 0)::bigint AS summary_tokens,
  coalesce(sum(cost), 0)::numeric(14, 8) AS total_cost_usd
FROM ai_usage_logs
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_analytics_cost_by_user AS
SELECT
  user_id,
  count(*)::bigint AS requests,
  coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
  coalesce(sum(memory_tokens), 0)::bigint AS memory_tokens,
  coalesce(sum(summary_tokens), 0)::bigint AS summary_tokens,
  coalesce(sum(cost), 0)::numeric(14, 8) AS total_cost_usd,
  max(created_at) AS last_request_at
FROM ai_usage_logs
GROUP BY user_id
ORDER BY total_cost_usd DESC;

CREATE OR REPLACE VIEW v_analytics_top_conversations AS
SELECT
  conversation_id,
  user_id,
  count(*)::bigint AS requests,
  coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
  coalesce(sum(cost), 0)::numeric(14, 8) AS total_cost_usd,
  max(created_at) AS last_request_at
FROM ai_usage_logs
WHERE conversation_id IS NOT NULL
GROUP BY conversation_id, user_id
ORDER BY total_cost_usd DESC;

CREATE OR REPLACE VIEW v_analytics_memory_system AS
SELECT
  date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
  coalesce(sum(memory_tokens), 0)::bigint AS cross_memory_tokens,
  coalesce(sum(summary_tokens), 0)::bigint AS conversation_summary_tokens,
  coalesce(sum(memory_tokens + summary_tokens), 0)::bigint AS combined_context_tokens,
  coalesce(sum(cost), 0)::numeric(14, 8) AS total_cost_usd
FROM ai_usage_logs
GROUP BY 1
ORDER BY 1 DESC;

-- ── Query helpers (service_role) ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_usage_cost_today()
RETURNS TABLE (
  day date,
  requests bigint,
  total_tokens bigint,
  memory_tokens bigint,
  summary_tokens bigint,
  total_cost_usd numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT day, requests, total_tokens, memory_tokens, summary_tokens, total_cost_usd
  FROM v_analytics_daily_cost
  WHERE day = (now() AT TIME ZONE 'UTC')::date
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_usage_cost_by_users(p_since timestamptz DEFAULT now() - interval '30 days')
RETURNS TABLE (
  user_id uuid,
  requests bigint,
  total_tokens bigint,
  memory_tokens bigint,
  summary_tokens bigint,
  total_cost_usd numeric,
  last_request_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    user_id,
    count(*)::bigint,
    coalesce(sum(total_tokens), 0)::bigint,
    coalesce(sum(memory_tokens), 0)::bigint,
    coalesce(sum(summary_tokens), 0)::bigint,
    coalesce(sum(cost), 0)::numeric(14, 8),
    max(created_at)
  FROM ai_usage_logs
  WHERE created_at >= p_since
  GROUP BY user_id
  ORDER BY sum(cost) DESC;
$$;

CREATE OR REPLACE FUNCTION get_top_expensive_conversations(
  p_limit int DEFAULT 20,
  p_since timestamptz DEFAULT now() - interval '30 days'
)
RETURNS TABLE (
  conversation_id uuid,
  user_id uuid,
  requests bigint,
  total_tokens bigint,
  total_cost_usd numeric,
  last_request_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    conversation_id,
    user_id,
    count(*)::bigint,
    coalesce(sum(total_tokens), 0)::bigint,
    coalesce(sum(cost), 0)::numeric(14, 8),
    max(created_at)
  FROM ai_usage_logs
  WHERE conversation_id IS NOT NULL
    AND created_at >= p_since
  GROUP BY conversation_id, user_id
  ORDER BY sum(cost) DESC
  LIMIT greatest(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION get_memory_token_usage(p_since timestamptz DEFAULT now() - interval '30 days')
RETURNS TABLE (
  cross_memory_tokens bigint,
  conversation_summary_tokens bigint,
  combined_context_tokens bigint,
  total_requests bigint,
  total_cost_usd numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce(sum(memory_tokens), 0)::bigint,
    coalesce(sum(summary_tokens), 0)::bigint,
    coalesce(sum(memory_tokens + summary_tokens), 0)::bigint,
    count(*)::bigint,
    coalesce(sum(cost), 0)::numeric(14, 8)
  FROM ai_usage_logs
  WHERE created_at >= p_since;
$$;

REVOKE ALL ON FUNCTION get_usage_cost_today() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_usage_cost_by_users(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_top_expensive_conversations(int, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_memory_token_usage(timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION get_usage_cost_today() TO service_role;
GRANT EXECUTE ON FUNCTION get_usage_cost_by_users(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION get_top_expensive_conversations(int, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION get_memory_token_usage(timestamptz) TO service_role;
