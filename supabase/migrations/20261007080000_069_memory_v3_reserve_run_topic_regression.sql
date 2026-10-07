-- Root cause of every reservation_failed / state_invalid seen today,
-- found by reproducing the exact live state JSON this function returns
-- and running it through the real validator: migrations 066-068 each
-- did CREATE OR REPLACE FUNCTION on reserve_memory_v3_dialogue_run and/or
-- reserve_memory_v3_lifecycle_shadow_run, copying the function body as it
-- stood in the ORIGINAL migration (039/034) -- which predates migration
-- 048 (24.09.2026, "memory_v3_reserve_run_topic"). That migration added
-- 'topic', i.topic to each function's per-item JSON build, because
-- dialogueContract.ts's/lifecycleContract.ts's ITEM_FIELDS has required a
-- topic key on every item since the topic-classification work (PR #57)
-- landed. Every CREATE OR REPLACE since then silently reverted that fix
-- back to the pre-048 shape -- own regression, introduced across today's
-- own migrations 066-068, never shipped by anyone else.
--
-- Any dialogue (or lifecycle) conversation with at least one existing
-- item hit this on every single reservation attempt: the RPC's returned
-- state always had one fewer key than the validator requires, so
-- projectState()/validateMemoryV3DialogueState() always threw -- a
-- reservation_failed with the reserve()-stage tag "state_invalid"
-- (see migration 067's getMemoryV3{Dialogue,Lifecycle}ReserveStage()),
-- confirmed live via the Edge Function console log this same session.
-- A conversation with zero existing items never has this problem (an
-- empty items array has no per-item shape to mismatch), which is why
-- most of today's earlier failures were reconciler_contract_invalid /
-- other codes instead -- this one only shows up once an account has real
-- memory data already, as this canary account's has since 24.09.2026.
--
-- Re-adds 'topic', i.topic in the same position migration 048 used
-- (between alternative and firstSeenAt), in both reserve functions,
-- on top of everything else migrations 066-068 already changed. Nothing
-- else in either function body is touched.

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_claimed boolean;
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
BEGIN
  BEGIN
    IF p_pipeline_version <> 'memory-v3-dialogue-v1' OR p_model <> 'google/gemini-3.7-flash' THEN
      RAISE EXCEPTION 'invalid dialogue reservation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.messages m ON m.conversation_id = c.id
      WHERE c.id = p_conversation_id AND c.user_id = p_user_id
        AND m.id = p_source_last_message_id AND m.created_at = p_source_last_created_at
    ) THEN RAISE EXCEPTION 'invalid dialogue reservation' USING ERRCODE = '42501'; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_conversation_id::text || ':' ||
      ((pg_catalog.now() AT TIME ZONE 'UTC')::date)::text, 0));

    IF EXISTS (SELECT 1 FROM public.memory_v3_dialogue_identities
      WHERE user_id = p_user_id AND conversation_id = p_conversation_id
        AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
      result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
    END IF;

    INSERT INTO public.memory_v3_dialogue_identities(user_id, conversation_id, pipeline_version, input_hash)
    VALUES (p_user_id, p_conversation_id, p_pipeline_version, p_input_hash)
    ON CONFLICT (user_id, conversation_id, pipeline_version, input_hash) DO NOTHING
    RETURNING true INTO v_claimed;
    IF v_claimed IS DISTINCT FROM true THEN
      result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
    END IF;

    INSERT INTO public.memory_v3_dialogue_heads(user_id, conversation_id) VALUES (p_user_id, p_conversation_id)
    ON CONFLICT (user_id, conversation_id) DO NOTHING;
    SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'dialogue head is missing'; END IF;

    SELECT pg_catalog.count(*)::integer INTO v_evidence_count
    FROM public.memory_v3_dialogue_evidence WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
    IF (SELECT pg_catalog.count(*) FROM public.memory_v3_dialogue_items
        WHERE user_id = p_user_id AND conversation_id = p_conversation_id) > 100
       OR v_evidence_count > 500 THEN RAISE EXCEPTION 'dialogue state too large'; END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
        'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
        'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
        'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
        'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
          'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
          'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
          ORDER BY e.source_message_id, e.relation COLLATE "C")
          FROM public.memory_v3_dialogue_evidence e
          WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id AND e.memory_key = i.memory_key),
          '[]'::jsonb)
      ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_items
    FROM public.memory_v3_dialogue_items i
    WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;

    state := pg_catalog.jsonb_build_object(
      'schemaVersion', v_head.schema_version, 'userId', v_head.user_id,
      'conversationId', v_head.conversation_id,
      'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
      'items', v_items);
    expected_state_revision := v_head.state_revision;
    INSERT INTO public.memory_v3_dialogue_runs(
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
      VALUES ('dialogue', p_user_id, p_conversation_id, pg_catalog.left(SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- logging is best-effort and must never block a clean failure return
    END;
    result := 'reservation_failed'; run_id := NULL; expected_state_revision := NULL; state := NULL;
    RETURN NEXT; RETURN;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_daily_count integer;
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
        'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
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
