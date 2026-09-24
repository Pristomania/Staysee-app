-- Fixes a Critical bug found in code review of Task 6 (the dialogue-scope
-- history-backfill import step): 050_memory_v3_dialogue_backfill_import.sql
-- copied memory_v3_dialogue_backfill_imports's uniqueness constraints
-- verbatim from the lifecycle sibling's audit table, where a single-column
-- `import_id uuid PRIMARY KEY` and `artifact_digest text NOT NULL UNIQUE`
-- make sense -- one import EVER per account there. But the dialogue-scope
-- import step sends the SAME import_id and the SAME artifact_digest for
-- EVERY conversation in one multi-conversation batch (both are correctly
-- artifact-level values, not per-conversation ones). Conversation #1's
-- audit-row INSERT succeeds; conversation #2's INSERT then violates BOTH
-- constraints, the function raises, and only the first conversation in any
-- real multi-conversation artifact would ever import -- worse, the
-- artifact_digest would already be permanently recorded, so even a
-- corrected retry of the SAME artifact would fail forever (service_role
-- only has SELECT/INSERT on this table, no DELETE/UPDATE -- no self-service
-- recovery).
--
-- This codebase's established convention is that migrations are immutable
-- snapshots and patches happen via a new migration (see how 049 patched
-- 037's lifecycle-scope sibling function earlier today). This migration:
--   1. Widens the primary key from (import_id) to (import_id,
--      conversation_id) -- the same import_id legitimately appears once per
--      conversation in a batch, never twice for the SAME conversation.
--   2. Widens the artifact_digest uniqueness from (artifact_digest) to
--      (artifact_digest, conversation_id) -- the same artifact legitimately
--      imports many different conversations, never the same conversation
--      twice.
--   3. Re-defines import_memory_v3_dialogue_backfill_state (CREATE OR
--      REPLACE, same signature) with exactly one change: the artifact_digest
--      conflict guard now also compares conversation_id. The first EXISTS
--      check in that same guard, on (user_id, conversation_id), already
--      independently blocks re-importing the same conversation at all --
--      this second check remains a defense-in-depth belt-and-suspenders on
--      artifact identity specifically, consistent with this function's
--      already-paranoid validation style. Every other line, including every
--      comment, is transcribed byte-identical from 050.

ALTER TABLE public.memory_v3_dialogue_backfill_imports
  DROP CONSTRAINT IF EXISTS memory_v3_dialogue_backfill_imports_pkey;
ALTER TABLE public.memory_v3_dialogue_backfill_imports
  ADD CONSTRAINT memory_v3_dialogue_backfill_imports_pkey PRIMARY KEY (import_id, conversation_id);

ALTER TABLE public.memory_v3_dialogue_backfill_imports
  DROP CONSTRAINT IF EXISTS memory_v3_dialogue_backfill_imports_artifact_digest_key;
ALTER TABLE public.memory_v3_dialogue_backfill_imports
  ADD CONSTRAINT memory_v3_dialogue_backfill_imports_artifact_digest_key UNIQUE (artifact_digest, conversation_id);

CREATE OR REPLACE FUNCTION public.import_memory_v3_dialogue_backfill_state(
  p_import_id uuid,
  p_user_id uuid,
  p_conversation_id uuid,
  p_expected_state_revision bigint,
  p_artifact_digest text,
  p_source_snapshot_digest text,
  p_source_cutoff timestamptz,
  p_profile_id text,
  p_pipeline_version text,
  p_extractor_version text,
  p_reconciler_version text,
  p_state jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_date_pattern CONSTANT text := '^(0[1-9][0-9]{2}|[1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$';
  v_datetime_pattern CONSTANT text := '^(0[1-9][0-9]{2}|[1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,9})?)?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$';
BEGIN
  IF p_import_id IS NULL
    OR p_user_id IS NULL
    OR p_conversation_id IS NULL
    OR p_expected_state_revision < 0
    OR p_artifact_digest IS NULL
    OR p_artifact_digest !~ '^[0-9a-f]{64}$'
    OR p_source_snapshot_digest IS NULL
    OR p_source_snapshot_digest !~ '^[0-9a-f]{64}$'
    OR p_source_cutoff IS NULL
    OR p_profile_id IS DISTINCT FROM 'memory-v3-dialogue-history-backfill-v1'
    OR p_pipeline_version IS DISTINCT FROM 'memory-v3-dialogue-v1'
    OR p_extractor_version IS DISTINCT FROM 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2'
    OR p_reconciler_version IS DISTINCT FROM 'memory-v3-dialogue-reconciler-v1'
  THEN
    RAISE EXCEPTION 'invalid dialogue backfill import';
  END IF;

  IF pg_catalog.jsonb_typeof(p_state) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_state)) <> 6
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(p_state) AS state_key
      WHERE state_key <> ALL (ARRAY[
        'schemaVersion', 'userId', 'conversationId', 'stateRevision', 'nextMemoryOrdinal', 'items'
      ]::text[])
    )
    OR p_state->>'schemaVersion' IS DISTINCT FROM 'memory-v3-dialogue-state-v1'
    OR p_state->>'userId' IS DISTINCT FROM p_user_id::text
    OR p_state->>'conversationId' IS DISTINCT FROM p_conversation_id::text
    OR pg_catalog.jsonb_typeof(p_state->'stateRevision') IS DISTINCT FROM 'number'
    OR (p_state->>'stateRevision') !~ '^[0-9]+$'
    OR (p_state->>'stateRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR pg_catalog.jsonb_typeof(p_state->'nextMemoryOrdinal') IS DISTINCT FROM 'number'
    OR (p_state->>'nextMemoryOrdinal') !~ '^[0-9]+$'
    OR (p_state->>'nextMemoryOrdinal')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR pg_catalog.jsonb_typeof(p_state->'items') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF v_item_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item
    WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(item)) <> 13
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(item) AS item_key
        WHERE item_key <> ALL (ARRAY[
          'memoryKey', 'kind', 'claim', 'status', 'sensitivity', 'eventTimeStart',
          'eventTimeEnd', 'alternative', 'topic', 'firstSeenAt', 'updatedAt', 'revision', 'evidence'
        ]::text[])
      )
      OR pg_catalog.jsonb_typeof(item->'memoryKey') IS DISTINCT FROM 'string'
      OR item->>'memoryKey' !~ '^[0-9a-f]{64}$'
      OR pg_catalog.jsonb_typeof(item->'kind') IS DISTINCT FROM 'string'
      OR item->>'kind' NOT IN ('event', 'recurrence', 'hypothesis')
      OR pg_catalog.jsonb_typeof(item->'claim') IS DISTINCT FROM 'string'
      OR pg_catalog.length(pg_catalog.btrim(item->>'claim')) = 0
      OR pg_catalog.jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(item->'sensitivity') IS DISTINCT FROM 'string'
      OR item->>'sensitivity' NOT IN ('normal', 'sensitive')
      OR (
        (item->>'kind' = 'event' AND item->>'status' IN ('active', 'corrected', 'rejected'))
        OR (item->>'kind' = 'recurrence' AND item->>'status' IN ('candidate', 'active', 'stale', 'rejected'))
        OR (item->>'kind' = 'hypothesis' AND item->>'status' IN ('candidate', 'supported', 'stale', 'rejected'))
      ) IS DISTINCT FROM true
      OR (
        (item->>'kind' = 'hypothesis'
          AND pg_catalog.jsonb_typeof(item->'alternative') = 'string'
          AND pg_catalog.length(pg_catalog.btrim(item->>'alternative')) > 0)
        OR (item->>'kind' <> 'hypothesis' AND item->'alternative' = 'null'::jsonb)
      ) IS DISTINCT FROM true
      OR (
        item->'topic' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(item->'topic') = 'string'
          AND item->>'topic' IN ('person', 'fact', 'preference'))
      ) IS DISTINCT FROM true
      OR (
        item->'eventTimeStart' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(item->'eventTimeStart') = 'string'
          AND (item->>'eventTimeStart' ~ v_date_pattern
            OR item->>'eventTimeStart' ~ v_datetime_pattern))
      ) IS DISTINCT FROM true
      OR (
        item->'eventTimeEnd' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(item->'eventTimeEnd') = 'string'
          AND (item->>'eventTimeEnd' ~ v_date_pattern
            OR item->>'eventTimeEnd' ~ v_datetime_pattern))
      ) IS DISTINCT FROM true
      OR (item->'eventTimeStart' <> 'null'::jsonb
        AND pg_catalog.date_part('epoch', (item->>'eventTimeStart')::timestamptz) IS NULL)
      OR (item->'eventTimeEnd' <> 'null'::jsonb
        AND pg_catalog.date_part('epoch', (item->>'eventTimeEnd')::timestamptz) IS NULL)
      OR (item->'eventTimeStart' <> 'null'::jsonb
        AND item->'eventTimeEnd' <> 'null'::jsonb
        AND (CASE WHEN item->>'eventTimeStart' ~ v_date_pattern
          THEN (item->>'eventTimeStart')::date::timestamp AT TIME ZONE 'UTC'
          ELSE (item->>'eventTimeStart')::timestamptz END)
          > (CASE WHEN item->>'eventTimeEnd' ~ v_date_pattern
          THEN (item->>'eventTimeEnd')::date::timestamp AT TIME ZONE 'UTC'
          ELSE (item->>'eventTimeEnd')::timestamptz END))
      OR pg_catalog.jsonb_typeof(item->'firstSeenAt') IS DISTINCT FROM 'string'
      OR item->>'firstSeenAt' !~ v_datetime_pattern
      OR pg_catalog.jsonb_typeof(item->'updatedAt') IS DISTINCT FROM 'string'
      OR item->>'updatedAt' !~ v_datetime_pattern
      OR (item->>'updatedAt')::timestamptz < (item->>'firstSeenAt')::timestamptz
      OR pg_catalog.jsonb_typeof(item->'revision') IS DISTINCT FROM 'number'
      OR (item->>'revision') !~ '^[0-9]+$'
      OR (item->>'revision')::numeric NOT BETWEEN 1 AND 9007199254740991
      OR pg_catalog.jsonb_typeof(item->'evidence') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(item->'evidence') < 1
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item
    GROUP BY item->>'memoryKey'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  SELECT COALESCE(pg_catalog.sum(
    pg_catalog.jsonb_array_length(item->'evidence')
  ), 0::bigint)::integer
  INTO v_evidence_count
  FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item;
  IF v_evidence_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
      pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
    WHERE pg_catalog.jsonb_typeof(evidence) IS DISTINCT FROM 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(evidence)) <> 7
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(evidence) AS evidence_key
        WHERE evidence_key <> ALL (ARRAY[
          'conversationId', 'sourceMessageId', 'relation', 'supportType',
          'episodeKey', 'provenanceRole', 'mentionTime'
        ]::text[])
      )
      OR pg_catalog.jsonb_typeof(evidence->'conversationId') IS DISTINCT FROM 'string'
      OR evidence->>'conversationId' IS DISTINCT FROM p_conversation_id::text
      OR pg_catalog.jsonb_typeof(evidence->'sourceMessageId') IS DISTINCT FROM 'string'
      OR evidence->>'sourceMessageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR pg_catalog.jsonb_typeof(evidence->'relation') IS DISTINCT FROM 'string'
      OR evidence->>'relation' NOT IN ('supports', 'contradicts', 'corrects', 'rejects')
      OR pg_catalog.jsonb_typeof(evidence->'provenanceRole') IS DISTINCT FROM 'string'
      OR evidence->>'provenanceRole' IS DISTINCT FROM 'user'
      OR pg_catalog.jsonb_typeof(evidence->'mentionTime') IS DISTINCT FROM 'string'
      OR evidence->>'mentionTime' !~ v_datetime_pattern
      OR (
        (item->>'kind' = 'recurrence' AND evidence->>'relation' = 'supports'
          AND evidence->>'supportType' = 'episode_observation'
          AND pg_catalog.jsonb_typeof(evidence->'episodeKey') = 'string'
          AND pg_catalog.length(pg_catalog.btrim(evidence->>'episodeKey')) > 0)
        OR (item->>'kind' = 'recurrence' AND evidence->>'relation' = 'supports'
          AND evidence->>'supportType' IN ('pattern_confirmation', 'scope_boundary')
          AND evidence->'episodeKey' = 'null'::jsonb)
        OR (NOT (item->>'kind' = 'recurrence' AND evidence->>'relation' = 'supports')
          AND evidence->'supportType' = 'null'::jsonb
          AND pg_catalog.jsonb_typeof(evidence->'episodeKey') = 'string'
          AND pg_catalog.length(pg_catalog.btrim(evidence->>'episodeKey')) > 0)
      ) IS DISTINCT FROM true
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
      pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
    GROUP BY item->>'memoryKey', evidence->>'conversationId',
      evidence->>'sourceMessageId', evidence->>'relation'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
      WHERE evidence->>'relation' = CASE item->>'status'
        WHEN 'active' THEN 'supports'
        WHEN 'candidate' THEN 'supports'
        WHEN 'supported' THEN 'supports'
        WHEN 'corrected' THEN 'corrects'
        WHEN 'stale' THEN 'contradicts'
        WHEN 'rejected' THEN 'rejects'
      END
    )
      OR (
        item->>'kind' = 'recurrence'
        AND item->>'status' IN ('candidate', 'active')
        AND (
          SELECT pg_catalog.count(DISTINCT evidence->>'episodeKey')
          FROM pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
          WHERE evidence->>'relation' = 'supports'
            AND evidence->>'supportType' = 'episode_observation'
        ) < CASE WHEN item->>'status' = 'active' THEN 2 ELSE 1 END
      )
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
      pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
        AND m.sender = 'user'
        AND m.created_at = (evidence->>'mentionTime')::timestamptz
        AND m.created_at <= p_source_cutoff
    )
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill evidence' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.memory_v3_dialogue_heads(user_id, conversation_id)
  VALUES (p_user_id, p_conversation_id)
  ON CONFLICT (user_id, conversation_id) DO NOTHING;

  SELECT * INTO v_head
  FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dialogue backfill head is missing';
  END IF;

  IF v_head.state_revision <> p_expected_state_revision
    OR EXISTS (
      SELECT 1 FROM public.memory_v3_dialogue_backfill_imports
      WHERE user_id = p_user_id AND conversation_id = p_conversation_id
    )
    OR EXISTS (
      SELECT 1 FROM public.memory_v3_dialogue_backfill_imports
      WHERE artifact_digest = p_artifact_digest AND conversation_id = p_conversation_id
    )
  THEN
    RAISE EXCEPTION 'dialogue backfill import conflict: conversation changed since the paid run, or this conversation/artifact was already imported';
  END IF;

  DELETE FROM public.memory_v3_dialogue_items
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  INSERT INTO public.memory_v3_dialogue_items(
    user_id, conversation_id, memory_key, kind, claim, status, sensitivity,
    event_time_start, event_time_end, alternative, topic, first_seen_at, updated_at, revision
  )
  SELECT p_user_id, p_conversation_id, item->>'memoryKey', item->>'kind', item->>'claim',
    item->>'status', item->>'sensitivity', item->>'eventTimeStart',
    item->>'eventTimeEnd', item->>'alternative', item->>'topic',
    (item->>'firstSeenAt')::timestamptz,
    (item->>'updatedAt')::timestamptz,
    (item->>'revision')::bigint
  FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item;

  INSERT INTO public.memory_v3_dialogue_evidence(
    user_id, conversation_id, memory_key, source_message_id, relation,
    support_type, episode_key, provenance_role, mention_time
  )
  SELECT p_user_id, p_conversation_id, item->>'memoryKey',
    (evidence->>'sourceMessageId')::uuid,
    evidence->>'relation', evidence->>'supportType', evidence->>'episodeKey',
    evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
  FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
    pg_catalog.jsonb_array_elements(item->'evidence') AS evidence;

  UPDATE public.memory_v3_dialogue_heads
  SET state_revision = (p_state->>'stateRevision')::bigint,
    next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
    updated_at = pg_catalog.now()
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  INSERT INTO public.memory_v3_dialogue_backfill_imports(
    import_id, user_id, conversation_id, artifact_digest, source_snapshot_digest, source_cutoff,
    profile_id, schema_version, pipeline_version, extractor_version,
    reconciler_version, expected_state_revision, resulting_state_revision,
    item_count, evidence_count
  )
  VALUES (
    p_import_id, p_user_id, p_conversation_id, p_artifact_digest, p_source_snapshot_digest,
    p_source_cutoff, p_profile_id, p_state->>'schemaVersion', p_pipeline_version,
    p_extractor_version, p_reconciler_version, p_expected_state_revision,
    (p_state->>'stateRevision')::bigint, v_item_count, v_evidence_count
  );

  result := 'succeeded';
  resulting_state_revision := (p_state->>'stateRevision')::bigint;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) FROM service_role;
GRANT EXECUTE ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) TO service_role;
