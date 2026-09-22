-- Ports today's message-count trigger fix (039_memory_v3_lifecycle_message_
-- count_trigger.sql, applied to the account-wide RPC) to the dialogue-scoped
-- RPC, so both systems run the same rule. Same technique: drop the
-- calendar-day cap, gate on 10 new messages accumulated since the user's
-- last dialogue-scoped reservation (shared across all their dialogues,
-- matching the existing shared-budget behavior in this same RPC -- that
-- part, the two-advisory-lock pair and the conversation_id-free count, is
-- untouched here).
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

  -- Product decision (22.09.2026): the daily paid-call budget stays one
  -- per PERSON, shared across every one of their dialogues -- not one
  -- per dialogue. The count below deliberately omits conversation_id.
  -- That makes it a shared resource two concurrent dialogues could race
  -- on, so it needs its own lock, separate from the per-conversation one
  -- above (different "extra" salt, 1 instead of 0, so the two locks
  -- never collide in the advisory-lock keyspace even for the same user).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':' ||
    ((pg_catalog.now() AT TIME ZONE 'UTC')::date)::text, 1));

  IF EXISTS (SELECT 1 FROM public.memory_v3_dialogue_identities
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  -- Product decision (23.09.2026): replaced the calendar-day cap with a
  -- gate on 10 new messages since this user's last dialogue-scoped check
  -- (across all their dialogues), matching the account-wide rule shipped
  -- today. Watermark = the source cursor recorded by this user's most
  -- recent dialogue reservation, across every dialogue. No prior
  -- reservation ever -> let the very first check through immediately.
  SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor
  FROM public.memory_v3_dialogue_runs
  WHERE user_id = p_user_id;

  IF v_last_cursor IS NOT NULL THEN
    SELECT pg_catalog.count(*)::integer INTO v_new_message_count
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.user_id = p_user_id AND m.created_at > v_last_cursor;
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
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative,
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
