-- Atomic, service-role-only initial import of a reviewed Memory V3
-- dialogue-scope historical backfill artifact, one conversation at a
-- time. Mirrors 037_memory_v3_lifecycle_backfill_import.sql's
-- lifecycle-scope function exactly in structure and validation rigor,
-- scoped by (user_id, conversation_id) instead of just user_id, and
-- with topic as a 13th required item key (memory_v3_dialogue_items
-- already has the topic column from today's earlier work, so this is
-- built correctly from the start -- no separate before/after patch
-- needed the way the lifecycle apply-state RPC needed one in 045).
--
-- Unlike the lifecycle original, which hardcodes an empty-only starting
-- state (p_expected_state_revision = 0), this one is allowed to
-- overwrite a conversation that already has live data -- Настя
-- explicitly asked for full reprocessing rather than skipping already-
-- active conversations (2026-09-24). It guards only against a narrow
-- race: the conversation's actual current revision must still match
-- whatever revision was observed right before the paid run started.

CREATE TABLE public.memory_v3_dialogue_backfill_imports (
  import_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  artifact_digest text NOT NULL UNIQUE CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_cutoff timestamptz NOT NULL,
  profile_id text NOT NULL CHECK (profile_id = 'memory-v3-dialogue-history-backfill-v1'),
  schema_version text NOT NULL CHECK (schema_version = 'memory-v3-dialogue-state-v1'),
  pipeline_version text NOT NULL CHECK (pipeline_version = 'memory-v3-dialogue-v1'),
  extractor_version text NOT NULL CHECK (extractor_version = 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2'),
  reconciler_version text NOT NULL CHECK (reconciler_version = 'memory-v3-dialogue-reconciler-v1'),
  expected_state_revision bigint NOT NULL CHECK (expected_state_revision >= 0),
  resulting_state_revision bigint NOT NULL CHECK (resulting_state_revision >= 1),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  evidence_count integer NOT NULL CHECK (evidence_count BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, conversation_id)
);

ALTER TABLE public.memory_v3_dialogue_backfill_imports ENABLE ROW LEVEL SECURITY;

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
      WHERE artifact_digest = p_artifact_digest
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

REVOKE ALL ON TABLE public.memory_v3_dialogue_backfill_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_dialogue_backfill_imports FROM service_role;
GRANT SELECT, INSERT ON TABLE public.memory_v3_dialogue_backfill_imports TO service_role;

REVOKE ALL ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) FROM service_role;
GRANT EXECUTE ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) TO service_role;
