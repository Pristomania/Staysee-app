-- Extends apply_memory_v3_lifecycle_shadow_state and apply_memory_v3_dialogue_state
-- (originally defined in 034_memory_v3_lifecycle_shadow.sql and
-- 039_memory_v3_dialogue_isolation.sql) to round-trip the new topic column
-- added in 044_memory_v3_topic_columns.sql. Three touch points per function:
-- the v_current_items reconstruction (used to detect real state changes),
-- the item INSERT column list, and nothing else -- the reducer already
-- decides the value in TypeScript before calling this RPC.

CREATE OR REPLACE FUNCTION public.apply_memory_v3_lifecycle_shadow_state(
  p_run_id uuid, p_user_id uuid, p_expected_state_revision bigint,
  p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb,
  p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_head public.memory_v3_lifecycle_shadow_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_transition_count integer;
  v_locked_run_id uuid;
  v_run_conversation_id uuid;
  v_current_items jsonb;
  v_current_state jsonb;
  v_actual_changed boolean;
  v_resulting_state_revision bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(p_state) <> 'object'
    OR p_state->>'schemaVersion' <> 'memory-v3-lifecycle-state-v1'
    OR p_state->>'userId' <> p_user_id::text
    OR pg_catalog.jsonb_typeof(p_state->'items') <> 'array'
    OR pg_catalog.jsonb_array_length(p_state->'items') > 100 THEN
    RAISE EXCEPTION 'invalid lifecycle state';
  END IF;
  SELECT COALESCE(pg_catalog.sum(pg_catalog.jsonb_array_length(item->'evidence')), 0)::integer
    INTO v_evidence_count FROM pg_catalog.jsonb_array_elements(p_state->'items') item;
  IF v_evidence_count > 500 THEN RAISE EXCEPTION 'invalid lifecycle state'; END IF;
  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF pg_catalog.jsonb_typeof(p_extraction) <> 'object' OR pg_catalog.jsonb_typeof(p_operations) <> 'array'
    OR pg_catalog.jsonb_typeof(p_transitions) <> 'array' THEN RAISE EXCEPTION 'invalid lifecycle audit'; END IF;
  v_transition_count := pg_catalog.jsonb_array_length(p_transitions);

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = (evidence->>'conversationId')::uuid
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid lifecycle evidence ownership' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_head FROM public.memory_v3_lifecycle_shadow_heads
  WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle head is missing'; END IF;
  SELECT id, conversation_id INTO v_locked_run_id, v_run_conversation_id
    FROM public.memory_v3_lifecycle_shadow_runs
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved'
      AND expected_state_revision = p_expected_state_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run is not reservable'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_extraction->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = v_run_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid lifecycle extraction ownership' USING ERRCODE = '42501'; END IF;
  IF v_head.state_revision <> p_expected_state_revision THEN
    UPDATE public.memory_v3_lifecycle_shadow_runs SET
      status = 'failed', diagnostic_code = 'state_conflict', completed_at = pg_catalog.now()
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

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
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_current_items
  FROM public.memory_v3_lifecycle_shadow_items i WHERE i.user_id = p_user_id;
  v_current_state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_current_items);
  v_actual_changed := (p_state - 'stateRevision') IS DISTINCT FROM (v_current_state - 'stateRevision');
  IF p_changed IS DISTINCT FROM v_actual_changed THEN
    RAISE EXCEPTION 'invalid lifecycle changed flag';
  END IF;
  v_resulting_state_revision := p_expected_state_revision
    + CASE WHEN v_actual_changed THEN 1 ELSE 0 END;
  IF (p_state->>'stateRevision')::bigint <> v_resulting_state_revision THEN
    RAISE EXCEPTION 'invalid lifecycle revision';
  END IF;

  IF v_actual_changed THEN
    DELETE FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id;
    INSERT INTO public.memory_v3_lifecycle_shadow_items(
      user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,
      alternative, topic, first_seen_at, updated_at, revision)
    SELECT p_user_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
      item->>'topic',
      (item->>'firstSeenAt')::timestamptz, (item->>'updatedAt')::timestamptz, (item->>'revision')::bigint
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item;

    INSERT INTO public.memory_v3_lifecycle_shadow_evidence(
      user_id, memory_key, conversation_id, source_message_id, relation, support_type,
      episode_key, provenance_role, mention_time)
    SELECT p_user_id, item->>'memoryKey', (evidence->>'conversationId')::uuid,
      (evidence->>'sourceMessageId')::uuid, evidence->>'relation', evidence->>'supportType',
      evidence->>'episodeKey', evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence;

    UPDATE public.memory_v3_lifecycle_shadow_heads SET
      state_revision = state_revision + 1,
      next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
      updated_at = pg_catalog.now()
    WHERE user_id = p_user_id;
  END IF;
  resulting_state_revision := v_resulting_state_revision;
  UPDATE public.memory_v3_lifecycle_shadow_runs SET
    status = 'succeeded',
    resulting_state_revision = v_resulting_state_revision,
    extraction = p_extraction, operations = p_operations, transitions = p_transitions,
    item_count = v_item_count, evidence_count = v_evidence_count, transition_count = v_transition_count,
    extractor_prompt_tokens = (p_extractor_usage->>'promptTokens')::integer,
    extractor_completion_tokens = (p_extractor_usage->>'completionTokens')::integer,
    extractor_cost_usd = (p_extractor_usage->>'costUsd')::numeric,
    reconciler_prompt_tokens = (p_reconciler_usage->>'promptTokens')::integer,
    reconciler_completion_tokens = (p_reconciler_usage->>'completionTokens')::integer,
    reconciler_cost_usd = (p_reconciler_usage->>'costUsd')::numeric,
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run completion failed'; END IF;
  result := 'succeeded'; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state(
  p_run_id uuid, p_user_id uuid, p_conversation_id uuid, p_expected_state_revision bigint,
  p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb,
  p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_transition_count integer;
  v_locked_run_id uuid;
  v_current_items jsonb;
  v_current_state jsonb;
  v_actual_changed boolean;
  v_resulting_state_revision bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(p_state) <> 'object'
    OR p_state->>'schemaVersion' <> 'memory-v3-dialogue-state-v1'
    OR p_state->>'userId' <> p_user_id::text
    OR p_state->>'conversationId' <> p_conversation_id::text
    OR pg_catalog.jsonb_typeof(p_state->'items') <> 'array'
    OR pg_catalog.jsonb_array_length(p_state->'items') > 100 THEN
    RAISE EXCEPTION 'invalid dialogue state';
  END IF;
  SELECT COALESCE(pg_catalog.sum(pg_catalog.jsonb_array_length(item->'evidence')), 0)::integer
    INTO v_evidence_count FROM pg_catalog.jsonb_array_elements(p_state->'items') item;
  IF v_evidence_count > 500 THEN RAISE EXCEPTION 'invalid dialogue state'; END IF;
  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF pg_catalog.jsonb_typeof(p_extraction) <> 'object' OR pg_catalog.jsonb_typeof(p_operations) <> 'array'
    OR pg_catalog.jsonb_typeof(p_transitions) <> 'array' THEN RAISE EXCEPTION 'invalid dialogue audit'; END IF;
  v_transition_count := pg_catalog.jsonb_array_length(p_transitions);

  -- Stricter than the cross-conversation original: evidence must come from THIS
  -- conversation specifically, not just any conversation owned by the user --
  -- that is the entire point of dialogue isolation.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid dialogue evidence ownership' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue head is missing'; END IF;

  SELECT id INTO v_locked_run_id
    FROM public.memory_v3_dialogue_runs
    WHERE id = p_run_id AND user_id = p_user_id AND conversation_id = p_conversation_id AND status = 'reserved'
      AND expected_state_revision = p_expected_state_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_extraction->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid dialogue extraction ownership' USING ERRCODE = '42501'; END IF;

  IF v_head.state_revision <> p_expected_state_revision THEN
    UPDATE public.memory_v3_dialogue_runs SET
      status = 'failed', diagnostic_code = 'state_conflict', completed_at = pg_catalog.now()
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

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
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_current_items
  FROM public.memory_v3_dialogue_items i WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
  v_current_state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id, 'conversationId', v_head.conversation_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_current_items);
  v_actual_changed := (p_state - 'stateRevision') IS DISTINCT FROM (v_current_state - 'stateRevision');
  IF p_changed IS DISTINCT FROM v_actual_changed THEN
    RAISE EXCEPTION 'invalid dialogue changed flag';
  END IF;
  v_resulting_state_revision := p_expected_state_revision + CASE WHEN v_actual_changed THEN 1 ELSE 0 END;
  IF (p_state->>'stateRevision')::bigint <> v_resulting_state_revision THEN
    RAISE EXCEPTION 'invalid dialogue revision';
  END IF;

  IF v_actual_changed THEN
    DELETE FROM public.memory_v3_dialogue_items WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
    INSERT INTO public.memory_v3_dialogue_items(
      user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,
      alternative, topic, first_seen_at, updated_at, revision)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
      item->>'topic',
      (item->>'firstSeenAt')::timestamptz, (item->>'updatedAt')::timestamptz, (item->>'revision')::bigint
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item;

    INSERT INTO public.memory_v3_dialogue_evidence(
      user_id, conversation_id, memory_key, source_message_id, relation, support_type,
      episode_key, provenance_role, mention_time)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey',
      (evidence->>'sourceMessageId')::uuid, evidence->>'relation', evidence->>'supportType',
      evidence->>'episodeKey', evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence;

    UPDATE public.memory_v3_dialogue_heads SET
      state_revision = state_revision + 1,
      next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
      updated_at = pg_catalog.now()
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
  END IF;
  resulting_state_revision := v_resulting_state_revision;
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'succeeded',
    resulting_state_revision = v_resulting_state_revision,
    extraction = p_extraction, operations = p_operations, transitions = p_transitions,
    item_count = v_item_count, evidence_count = v_evidence_count, transition_count = v_transition_count,
    extractor_prompt_tokens = (p_extractor_usage->>'promptTokens')::integer,
    extractor_completion_tokens = (p_extractor_usage->>'completionTokens')::integer,
    extractor_cost_usd = (p_extractor_usage->>'costUsd')::numeric,
    reconciler_prompt_tokens = (p_reconciler_usage->>'promptTokens')::integer,
    reconciler_completion_tokens = (p_reconciler_usage->>'completionTokens')::integer,
    reconciler_cost_usd = (p_reconciler_usage->>'costUsd')::numeric,
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run completion failed'; END IF;
  result := 'succeeded'; RETURN NEXT;
END;
$$;
