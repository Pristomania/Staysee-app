-- Product decision (28.09.2026): the 10-new-messages trigger (039/041,
-- topic-updated by 048) counted messages across ALL of a user's dialogues,
-- but every actual run only ever processes the ONE conversation that
-- happened to trip the count (loadMessages is always scoped to a single
-- conversation_id, for both scopes). When the 10 messages were spread
-- across two conversations, the run fired for whichever one sent the
-- 10th message, its own message timestamp became the new shared
-- watermark, and the OTHER conversation's contributing messages -- never
-- actually processed by either run -- fell before that watermark and
-- could never be counted again. Their content was silently and
-- permanently skipped from ever generating memory. Fix: count and gate
-- per conversation, matching what already happens on the processing
-- side. Transcribed from the CURRENT live versions of both functions (as
-- last replaced by 20260924130000_048_memory_v3_reserve_run_topic.sql),
-- with only the message-count trigger and (for the dialogue function)
-- its now-unnecessary shared-budget lock changed; every other line --
-- including all inline comments -- kept byte-identical to that source
-- migration.

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_last_cursor timestamptz;
  v_new_message_count integer;
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

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_identities
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  -- Product decision (28.09.2026): watermark and count are now scoped to
  -- THIS conversation only, not shared across the user's other dialogues
  -- -- the shared version let a quiet conversation's messages get counted
  -- toward triggering a run for a different, busier conversation, then
  -- silently skipped forever once the shared watermark moved past them.
  -- No prior reservation for this conversation ever -> let the very
  -- first check through immediately, same as before.
  SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor
  FROM public.memory_v3_lifecycle_shadow_runs
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  IF v_last_cursor IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_new_message_count
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.user_id = p_user_id AND c.id = p_conversation_id AND m.created_at > v_last_cursor;
    -- Result stays 'daily_cap' for wire compatibility with existing
    -- callers; it now means "not enough new messages yet", not "today's
    -- check already happened".
    IF v_new_message_count < 10 THEN
      result := 'daily_cap'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
    END IF;
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
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(
  uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_last_cursor timestamptz;
  v_new_message_count integer;
  v_claimed boolean;
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
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

  -- Review finding fix: lock folds conversation_id into the hash, unlike
  -- the lifecycle-shadow lock which is user_id-only. This is the whole
  -- point of this table set -- two dialogues of the same user must not
  -- serialize against each other for state writes.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':' || p_conversation_id::text || ':' ||
    ((pg_catalog.now() AT TIME ZONE 'UTC')::date)::text, 0));

  -- Product decision (28.09.2026): the message-count gate is now per
  -- conversation (see below), so the count is no longer a resource shared
  -- across a user's dialogues -- the separate per-user "budget" lock this
  -- used to need (22.09.2026 product decision) has nothing left to
  -- protect and is removed. Two dialogues of the same user were already
  -- not serialized against each other for state writes (the lock above
  -- is per-conversation); now they are not serialized against each other
  -- for the count either.

  IF EXISTS (SELECT 1 FROM public.memory_v3_dialogue_identities
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  -- Product decision (28.09.2026): watermark and count are now scoped to
  -- THIS conversation only, not shared across the user's other dialogues
  -- -- the shared version let a quiet conversation's messages get counted
  -- toward triggering a run for a different, busier conversation, then
  -- silently skipped forever once the shared watermark moved past them.
  -- No prior reservation for this conversation ever -> let the very
  -- first check through immediately, same as before.
  SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor
  FROM public.memory_v3_dialogue_runs
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  IF v_last_cursor IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_new_message_count
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.user_id = p_user_id AND c.id = p_conversation_id AND m.created_at > v_last_cursor;
    -- Result stays 'daily_cap' for wire compatibility with existing
    -- callers; it now means "not enough new messages yet".
    IF v_new_message_count < 10 THEN
      result := 'daily_cap'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
    END IF;
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
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_dialogue_run(uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_dialogue_run(uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer) TO service_role;
