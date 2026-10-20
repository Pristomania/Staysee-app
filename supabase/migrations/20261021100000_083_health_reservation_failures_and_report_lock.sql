-- Two fixes found by an independent review on 2026-10-20.
--
-- 1. The hourly health check (memory_v3_health_snapshot, migration 080) counted only the two run tables. A
--    reservation that fails writes to memory_v3_reservation_failures and never creates a run (reserve() is what
--    would have created it), so a pipeline whose reservations all failed looked healthy after a single success.
--    The failed reservations inside the window are now counted as failures of their pipeline, under the code
--    'reservation_failed'. Everything else in the snapshot is unchanged.
--
-- 2. record_over_limit_hit (migration 082) checks "no report in the last ten seconds" and then inserts, without
--    a lock: parallel calls from one person all saw no recent report and all wrote one (reproduced with 60
--    parallel calls: two rows instead of one). A per-person advisory lock, held until the transaction ends,
--    makes the check and the insert one step.

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
  v_dialogue_reservation_failed bigint;
  v_lifecycle_reservation_failed bigint;
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

  SELECT
    pg_catalog.count(*) FILTER (WHERE f.kind = 'dialogue'),
    pg_catalog.count(*) FILTER (WHERE f.kind = 'lifecycle')
  INTO v_dialogue_reservation_failed, v_lifecycle_reservation_failed
  FROM public.memory_v3_reservation_failures f
  WHERE f.created_at >= v_since;

  IF v_dialogue_reservation_failed > 0 THEN
    v_dialogue := pg_catalog.jsonb_set(
      v_dialogue, '{failed}',
      pg_catalog.to_jsonb((v_dialogue->>'failed')::bigint + v_dialogue_reservation_failed));
    v_dialogue := pg_catalog.jsonb_set(
      v_dialogue, '{failedByCode,reservation_failed}',
      pg_catalog.to_jsonb(
        COALESCE((v_dialogue->'failedByCode'->>'reservation_failed')::bigint, 0) + v_dialogue_reservation_failed));
  END IF;

  IF v_lifecycle_reservation_failed > 0 THEN
    v_lifecycle := pg_catalog.jsonb_set(
      v_lifecycle, '{failed}',
      pg_catalog.to_jsonb((v_lifecycle->>'failed')::bigint + v_lifecycle_reservation_failed));
    v_lifecycle := pg_catalog.jsonb_set(
      v_lifecycle, '{failedByCode,reservation_failed}',
      pg_catalog.to_jsonb(
        COALESCE((v_lifecycle->'failedByCode'->>'reservation_failed')::bigint, 0) + v_lifecycle_reservation_failed));
  END IF;

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

CREATE OR REPLACE FUNCTION public.record_over_limit_hit(p_char_count integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_char_count IS NULL OR p_char_count <= 10000 OR p_char_count > 10000000 THEN
    RAISE EXCEPTION 'invalid character count';
  END IF;
  -- One person's reports are checked and written one at a time.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.message_length_events
    WHERE user_id = v_user AND kind = 'over_limit'
      AND created_at > pg_catalog.now() - pg_catalog.make_interval(secs => 10)
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.message_length_events (user_id, kind, char_count)
  VALUES (v_user, 'over_limit', p_char_count);
END;
$$;

REVOKE ALL ON FUNCTION public.record_over_limit_hit(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_over_limit_hit(integer) TO authenticated;
