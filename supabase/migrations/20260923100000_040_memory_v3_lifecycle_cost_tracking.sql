-- Product ask (23.09.2026): a per-account counter of Memory V3 lifecycle
-- checks and their total cost, for future financial management. Cost data
-- for each call was already being discarded (the OpenRouter request never
-- asked for it -- fixed alongside this migration in transport.ts and
-- lifecycleTransport.ts). This reuses the existing general-purpose
-- ai_usage_logs table/analytics infrastructure instead of building a
-- separate one: extractor and reconciler calls are logged there like any
-- other OpenRouter call, tagged by a new call_kind column, with both calls
-- of one check sharing request_id = the lifecycle run id so they can be
-- counted as one check (count(DISTINCT request_id)) or summed individually.

ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS call_kind text NULL;

COMMENT ON COLUMN public.ai_usage_logs.call_kind IS
  'Distinguishes background/system calls (memory_lifecycle_extractor, memory_lifecycle_reconciler) from the main chat reply (NULL = chat reply)';

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_call_kind
  ON public.ai_usage_logs (call_kind)
  WHERE call_kind IS NOT NULL;

CREATE OR REPLACE VIEW public.v_analytics_memory_lifecycle_cost_by_user AS
SELECT
  user_id,
  count(*) FILTER (WHERE call_kind = 'memory_lifecycle_extractor') AS extractor_calls,
  count(*) FILTER (WHERE call_kind = 'memory_lifecycle_reconciler') AS reconciler_calls,
  count(DISTINCT request_id) FILTER (
    WHERE call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
  ) AS lifecycle_checks,
  coalesce(sum(cost) FILTER (
    WHERE call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
  ), 0)::numeric(14, 8) AS total_lifecycle_cost_usd,
  max(created_at) FILTER (
    WHERE call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
  ) AS last_lifecycle_call_at
FROM public.ai_usage_logs
GROUP BY user_id;

CREATE OR REPLACE FUNCTION public.get_memory_lifecycle_cost_by_users(
  p_since timestamptz DEFAULT now() - interval '30 days'
)
RETURNS TABLE (
  user_id uuid,
  extractor_calls bigint,
  reconciler_calls bigint,
  lifecycle_checks bigint,
  total_lifecycle_cost_usd numeric,
  last_lifecycle_call_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    user_id,
    count(*) FILTER (WHERE call_kind = 'memory_lifecycle_extractor'),
    count(*) FILTER (WHERE call_kind = 'memory_lifecycle_reconciler'),
    count(DISTINCT request_id) FILTER (
      WHERE call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
    ),
    coalesce(sum(cost) FILTER (
      WHERE call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
    ), 0)::numeric(14, 8),
    max(created_at) FILTER (
      WHERE call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
    )
  FROM public.ai_usage_logs
  WHERE created_at >= p_since
    AND call_kind IN ('memory_lifecycle_extractor', 'memory_lifecycle_reconciler')
  GROUP BY user_id
  ORDER BY sum(cost) DESC;
$$;

REVOKE ALL ON FUNCTION public.get_memory_lifecycle_cost_by_users(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_memory_lifecycle_cost_by_users(timestamptz) TO service_role;
