-- Hourly health check for the Memory V3 pipelines (memory-health-check function).
--
-- 1. Two new alert keys, 'health:failure_rate' and 'health:silent', in the same
--    closed list migration 079 extended: the check reuses the existing
--    one-alert-per-key-per-hour deduplication. DROP+ADD on the CHECK constraint
--    and CREATE OR REPLACE on the function, exactly as 079 did; every key the
--    old list accepted is still accepted.
-- 2. memory_v3_health_snapshot(): aggregate counts of recent memory runs for
--    both pipelines, plus how many user messages arrived. Counts only -- no
--    account, conversation or message text -- and executable by the service role
--    alone, so the function that sends the alert never reads raw rows.

ALTER TABLE public.memory_v3_alert_windows
  DROP CONSTRAINT memory_v3_alert_windows_key_check;

ALTER TABLE public.memory_v3_alert_windows
  ADD CONSTRAINT memory_v3_alert_windows_key_check CHECK (alert_key IN (
    'read:load_failed',
    'read:invalid_shape',
    'read:too_large',
    'write:invalid_source',
    'write:state_too_large',
    'write:extractor_transport_failed',
    'write:extractor_parse_invalid',
    'write:extractor_shape_invalid',
    'write:extractor_contract_invalid',
    'write:reconciler_request_too_large',
    'write:reconciler_transport_failed',
    'write:reconciler_parse_invalid',
    'write:reconciler_shape_invalid',
    'write:reconciler_contract_invalid',
    'write:state_conflict',
    'write:state_write_failed',
    'write:reservation_failed',
    'write:unknown_failure',
    'write:forced_skip',
    'health:failure_rate',
    'health:silent'
  ));

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_alert_window(
  p_alert_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_inserted boolean;
  v_window_start timestamptz;
BEGIN
  IF p_alert_key IS NULL OR p_alert_key NOT IN (
    'read:load_failed',
    'read:invalid_shape',
    'read:too_large',
    'write:invalid_source',
    'write:state_too_large',
    'write:extractor_transport_failed',
    'write:extractor_parse_invalid',
    'write:extractor_shape_invalid',
    'write:extractor_contract_invalid',
    'write:reconciler_request_too_large',
    'write:reconciler_transport_failed',
    'write:reconciler_parse_invalid',
    'write:reconciler_shape_invalid',
    'write:reconciler_contract_invalid',
    'write:state_conflict',
    'write:state_write_failed',
    'write:reservation_failed',
    'write:unknown_failure',
    'write:forced_skip',
    'health:failure_rate',
    'health:silent'
  ) THEN
    RAISE EXCEPTION 'invalid memory v3 alert key';
  END IF;

  v_window_start :=
    pg_catalog.date_trunc('hour', pg_catalog.now() AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC';

  DELETE FROM public.memory_v3_alert_windows
  WHERE window_start < pg_catalog.now() - INTERVAL '14 days';

  INSERT INTO public.memory_v3_alert_windows(alert_key, window_start)
  VALUES (p_alert_key, v_window_start)
  ON CONFLICT (alert_key, window_start) DO NOTHING
  RETURNING true INTO v_inserted;

  RETURN COALESCE(v_inserted, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_alert_window(text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_alert_window(text)
TO service_role;

-- A run still 'reserved' after this long was started and never finished
-- (the function died mid-run, so no failure was recorded).
CREATE OR REPLACE FUNCTION public.memory_v3_health_snapshot(
  p_window_minutes integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_since timestamptz;
  v_stuck_before timestamptz;
  v_user_messages bigint;
  v_dialogue jsonb;
  v_lifecycle jsonb;
BEGIN
  IF p_window_minutes IS NULL OR p_window_minutes < 10 OR p_window_minutes > 1440 THEN
    RAISE EXCEPTION 'invalid health window';
  END IF;
  v_since := pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes);
  v_stuck_before := pg_catalog.now() - INTERVAL '15 minutes';

  SELECT pg_catalog.count(*) INTO v_user_messages
  FROM public.messages m
  WHERE m.sender = 'user' AND m.created_at >= v_since;

  SELECT pg_catalog.jsonb_build_object(
    'succeeded', pg_catalog.count(*) FILTER (WHERE r.status = 'succeeded'),
    'failed', pg_catalog.count(*) FILTER (WHERE r.status = 'failed'),
    'stuck', pg_catalog.count(*) FILTER (WHERE r.status = 'reserved' AND r.created_at < v_stuck_before),
    'failedByCode', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(c.diagnostic_code, c.n)
      FROM (
        SELECT f.diagnostic_code, pg_catalog.count(*) AS n
        FROM public.memory_v3_dialogue_runs f
        WHERE f.status = 'failed' AND f.created_at >= v_since
        GROUP BY f.diagnostic_code
      ) c
    ), '{}'::jsonb))
  INTO v_dialogue
  FROM public.memory_v3_dialogue_runs r
  WHERE r.created_at >= v_since;

  SELECT pg_catalog.jsonb_build_object(
    'succeeded', pg_catalog.count(*) FILTER (WHERE r.status = 'succeeded'),
    'failed', pg_catalog.count(*) FILTER (WHERE r.status = 'failed'),
    'stuck', pg_catalog.count(*) FILTER (WHERE r.status = 'reserved' AND r.created_at < v_stuck_before),
    'failedByCode', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(c.diagnostic_code, c.n)
      FROM (
        SELECT f.diagnostic_code, pg_catalog.count(*) AS n
        FROM public.memory_v3_lifecycle_shadow_runs f
        WHERE f.status = 'failed' AND f.created_at >= v_since
        GROUP BY f.diagnostic_code
      ) c
    ), '{}'::jsonb))
  INTO v_lifecycle
  FROM public.memory_v3_lifecycle_shadow_runs r
  WHERE r.created_at >= v_since;

  RETURN pg_catalog.jsonb_build_object(
    'windowMinutes', p_window_minutes,
    'userMessages', v_user_messages,
    'dialogue', v_dialogue,
    'lifecycle', v_lifecycle
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.memory_v3_health_snapshot(integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_v3_health_snapshot(integer)
TO service_role;
