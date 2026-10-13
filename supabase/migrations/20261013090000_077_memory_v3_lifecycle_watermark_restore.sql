-- Migration 069 (07.10.2026) copied this function's body from a stale
-- pre-053 reference while fixing an unrelated topic-field regression on the
-- dialogue function in the same file -- it silently reverted lifecycle's
-- reservation gate from migration 053's per-conversation "10 new messages
-- since last run" watermark back to a plain "1 run per user per day,
-- regardless of status" cap. Live in production since 07.10.2026.
--
-- Restores 053's watermark, with one additional fix migration 053 itself
-- never had: the watermark query now requires status = 'succeeded', so a
-- failed run's source_last_created_at can never count as "already
-- processed" -- a transient failure no longer silently skips those
-- messages forever.
--
-- Adds a second, new gate on top (product decision, 13.10.2026): even once
-- 10 new messages accumulate, never run this paid check more than once per
-- calendar day for a given user across all of their conversations --
-- lifecycle state is shared account-wide, so a second success the same day
-- from a different busy conversation would just re-spend money re-deriving
-- a near-identical picture. Only a 'succeeded' run counts toward this cap;
-- a failed attempt must not use up today's slot, so the system keeps
-- retrying on the user's next message until it actually succeeds.
--
-- CREATE OR REPLACE is enough here: the parameter list, return shape, and
-- every other clause (topic field, replaces/replacedBy link fields, the
-- exception handler, the best-effort failure log) are unchanged from
-- migration 074 -- only the gate-check section differs.

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_last_cursor timestamptz;
  v_new_message_count integer;
  v_daily_success_count integer;
  v_claimed boolean;
  v_head public.memory_v3_lifecycle_shadow_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
BEGIN
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

    SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor
    FROM public.memory_v3_lifecycle_shadow_runs
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND status = 'succeeded';

    IF v_last_cursor IS NOT NULL THEN
      SELECT pg_catalog.count(*)::integer INTO v_new_message_count
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE c.user_id = p_user_id AND c.id = p_conversation_id AND m.created_at > v_last_cursor;
      -- Result stays 'daily_cap' for wire compatibility with existing
      -- callers; it means "not enough new messages yet for this
      -- conversation", not "today's check already happened".
      IF v_new_message_count < 10 THEN
        result := 'daily_cap'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
      END IF;
    END IF;

    SELECT pg_catalog.count(*)::integer INTO v_daily_success_count
    FROM public.memory_v3_lifecycle_shadow_runs
    WHERE user_id = p_user_id AND status = 'succeeded'
      AND created_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    IF v_daily_success_count >= 1 THEN
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
        'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
        'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
        'replacesMemoryKey', i.replaces_memory_key, 'replacedByMemoryKey', i.replaced_by_memory_key,
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
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.memory_v3_reservation_failures(kind, user_id, conversation_id, detail)
      VALUES ('lifecycle', p_user_id, p_conversation_id, pg_catalog.left(SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- logging is best-effort and must never block a clean failure return
    END;
    result := 'reservation_failed'; run_id := NULL; expected_state_revision := NULL; state := NULL;
    RETURN NEXT; RETURN;
  END;
END;
$$;
