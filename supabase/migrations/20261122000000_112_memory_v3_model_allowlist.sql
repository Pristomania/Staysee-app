/*
  # 112: the background memory runs on DeepSeek V4.1 Flash, and the memory of the conversation is written after every 10 new messages

  1. The model. Until now the database accepted one model only: both tables of runs had CHECK (model = 'google/gemini-3.7-flash') and both
     functions that reserve a run raised an error for any other model. The application now writes `deepseek-ai/DeepSeek-V4.1-Flash` (the name
     does not depend on which host answered: Cloud.ru, or OpenRouter as the reserve). This migration lets BOTH names in: the runs already written
     stay valid, and a rollback of the application to Gemini needs no change in the database.

  2. The cadence. The function that reserves a run of the memory of a conversation had no count of messages at all: the memory was written after
     EVERY turn (the memory between conversations has had the rule «after 10 new messages» since migration 039, per conversation since 053).
     Measured on 22.11.2026 on the real pipeline over a made-up conversation of nine months (23 facts to keep): writing after every 10 new
     messages keeps as many facts as writing after every turn (Gemini: 21 of 23 every turn, 20-21 every 5 turns; DeepSeek V4.1 Flash: 22 of 23
     every 5 turns, 21 every 10) and costs about a quarter of it (0.63 roubles a turn against 0.16 for Gemini). The chat keeps the last 40 messages
     in the prompt anyway, so a fact said a few turns ago is never missing for the conversation it was said in. The function now does what the
     lifecycle one does: when this conversation already has a succeeded run, a new run is reserved only after 10 messages written after
     the last run's cursor; otherwise the answer is 'daily_cap' (the old name, kept for the callers: it means «not enough new messages yet», and the
     application treats it as a quiet skip). The first run of a conversation is never held back.

  What is changed (nothing else, nothing is deleted or rewritten):
  - the two CHECK constraints on `model` (memory_v3_dialogue_runs, memory_v3_lifecycle_shadow_runs);
  - the two reserve functions (reserve_memory_v3_dialogue_run, reserve_memory_v3_lifecycle_shadow_run): the copies of their LIVE definitions
    (taken with pg_get_functiondef on 22.11.2026) with the model condition widened, and, in the dialogue one, the count of new messages added.
  Grants stay (CREATE OR REPLACE keeps them). The two backfill-import functions are tied to the version of the prompt, not to the model.
*/

ALTER TABLE public.memory_v3_dialogue_runs DROP CONSTRAINT memory_v3_dialogue_runs_model_check;
ALTER TABLE public.memory_v3_dialogue_runs
  ADD CONSTRAINT memory_v3_dialogue_runs_model_check
  CHECK (model IN ('google/gemini-3.7-flash', 'deepseek-ai/DeepSeek-V4.1-Flash'));

ALTER TABLE public.memory_v3_lifecycle_shadow_runs DROP CONSTRAINT memory_v3_lifecycle_shadow_runs_model_check;
ALTER TABLE public.memory_v3_lifecycle_shadow_runs
  ADD CONSTRAINT memory_v3_lifecycle_shadow_runs_model_check
  CHECK (model IN ('google/gemini-3.7-flash', 'deepseek-ai/DeepSeek-V4.1-Flash'));

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run(p_user_id uuid, p_conversation_id uuid, p_pipeline_version text, p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text, p_source_last_message_id uuid, p_source_last_created_at timestamp with time zone, p_message_count integer, p_user_message_count integer)
 RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed boolean;
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
  v_last_cursor_at timestamptz;
  v_last_cursor_id uuid;
  v_new_message_count integer;
BEGIN
  BEGIN
    IF p_pipeline_version <> 'memory-v3-dialogue-v1' OR p_model NOT IN ('google/gemini-3.7-flash', 'deepseek-ai/DeepSeek-V4.1-Flash') THEN
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

    SELECT r.source_last_created_at, r.source_last_message_id
    INTO v_last_cursor_at, v_last_cursor_id
    FROM public.memory_v3_dialogue_runs r
    WHERE r.user_id = p_user_id AND r.conversation_id = p_conversation_id AND r.status = 'succeeded'
    ORDER BY r.source_last_created_at DESC, r.source_last_message_id DESC
    LIMIT 1;

    IF v_last_cursor_at IS NOT NULL THEN
      SELECT pg_catalog.count(*)::integer INTO v_new_message_count
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE c.user_id = p_user_id AND c.id = p_conversation_id
        AND (m.created_at > v_last_cursor_at
          OR (m.created_at = v_last_cursor_at AND m.id > v_last_cursor_id));
      -- 'daily_cap' is the old name, kept for the callers: here it means "not enough new messages yet for this conversation".
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
        'replacesMemoryKey', i.replaces_memory_key, 'replacedByMemoryKey', i.replaced_by_memory_key,
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
$function$;

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run(p_user_id uuid, p_conversation_id uuid, p_pipeline_version text, p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text, p_source_last_message_id uuid, p_source_last_created_at timestamp with time zone, p_message_count integer, p_user_message_count integer)
 RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_last_cursor_at timestamptz;
  v_last_cursor_id uuid;
  v_new_message_count integer;
  v_claimed boolean;
  v_head public.memory_v3_lifecycle_shadow_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
BEGIN
  BEGIN
    IF p_pipeline_version <> 'memory-v3-lifecycle-shadow-v1' OR p_model NOT IN ('google/gemini-3.7-flash', 'deepseek-ai/DeepSeek-V4.1-Flash') THEN
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

    SELECT r.source_last_created_at, r.source_last_message_id
    INTO v_last_cursor_at, v_last_cursor_id
    FROM public.memory_v3_lifecycle_shadow_runs r
    WHERE r.user_id = p_user_id AND r.conversation_id = p_conversation_id AND r.status = 'succeeded'
    ORDER BY r.source_last_created_at DESC, r.source_last_message_id DESC
    LIMIT 1;

    IF v_last_cursor_at IS NOT NULL THEN
      SELECT pg_catalog.count(*)::integer INTO v_new_message_count
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE c.user_id = p_user_id AND c.id = p_conversation_id
        AND (m.created_at > v_last_cursor_at
          OR (m.created_at = v_last_cursor_at AND m.id > v_last_cursor_id));
      -- Result stays 'daily_cap' for wire compatibility with existing
      -- callers; it means "not enough new messages yet for this
      -- conversation", not "today's check already happened".
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
$function$;
