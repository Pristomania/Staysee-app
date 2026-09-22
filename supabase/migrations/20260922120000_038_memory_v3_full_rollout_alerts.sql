-- Production safety boundary for the all-account Memory V3 lifecycle rollout.

CREATE TABLE public.memory_v3_alert_windows (
  alert_key text NOT NULL,
  window_start timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (alert_key, window_start),
  CONSTRAINT memory_v3_alert_windows_key_check CHECK (alert_key IN (
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
    'write:unknown_failure'
  ))
);

ALTER TABLE public.memory_v3_alert_windows ENABLE ROW LEVEL SECURITY;

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
    'write:unknown_failure'
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

REVOKE ALL ON TABLE public.memory_v3_alert_windows
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_memory_v3_alert_window(text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_alert_window(text)
TO service_role;

-- Restore the production lifecycle allowance to one reservation per UTC day
-- per account before enabling the lifecycle writer for all accounts.
CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_daily_count integer;
  v_claimed boolean;
  v_head public.memory_v3_lifecycle_shadow_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
BEGIN
  IF p_pipeline_version <> 'memory-v3-lifecycle-shadow-v1' OR p_model <> 'google/gemini-3.7-flash' THEN
    RAISE EXCEPTION 'invalid lifecycle reservation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.id = p_conversation_id AND c.user_id = p_user_id
      AND m.id = p_source_last_message_id AND m.created_at = p_source_last_created_at
  ) THEN RAISE EXCEPTION 'invalid lifecycle reservation' USING ERRCODE = '42501'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':' || ((pg_catalog.now() AT TIME ZONE 'UTC')::date)::text, 0));

  IF EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_identities
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_daily_count
  FROM public.memory_v3_lifecycle_shadow_runs
  WHERE user_id = p_user_id
    AND created_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_daily_count >= 1 THEN
    result := 'daily_cap'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO public.memory_v3_lifecycle_shadow_identities(user_id, conversation_id, pipeline_version, input_hash)
  VALUES (p_user_id, p_conversation_id, p_pipeline_version, p_input_hash)
  ON CONFLICT (user_id, conversation_id, pipeline_version, input_hash) DO NOTHING
  RETURNING true INTO v_claimed;
  IF v_claimed IS DISTINCT FROM true THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO public.memory_v3_lifecycle_shadow_heads(user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_head FROM public.memory_v3_lifecycle_shadow_heads
  WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle head is missing'; END IF;

  SELECT pg_catalog.count(*)::integer INTO v_evidence_count
  FROM public.memory_v3_lifecycle_shadow_evidence WHERE user_id = p_user_id;
  IF (SELECT pg_catalog.count(*) FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id) > 100
     OR v_evidence_count > 500 THEN RAISE EXCEPTION 'lifecycle state too large'; END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
      'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative,
      'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
      'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
        'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
        'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
        ORDER BY e.conversation_id, e.source_message_id, e.relation COLLATE "C")
        FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key), '[]'::jsonb)
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_items
  FROM public.memory_v3_lifecycle_shadow_items i WHERE i.user_id = p_user_id;

  state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_items);
  expected_state_revision := v_head.state_revision;
  INSERT INTO public.memory_v3_lifecycle_shadow_runs(
    user_id, conversation_id, pipeline_version, input_hash, extractor_version,
    reconciler_version, model, status, source_last_message_id, source_last_created_at,
    message_count, user_message_count, expected_state_revision)
  VALUES (p_user_id, p_conversation_id, p_pipeline_version, p_input_hash, p_extractor_version,
    p_reconciler_version, p_model, 'reserved', p_source_last_message_id, p_source_last_created_at,
    p_message_count, p_user_message_count, expected_state_revision)
  RETURNING id INTO run_id;
  result := 'reserved'; RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer
) TO service_role;
