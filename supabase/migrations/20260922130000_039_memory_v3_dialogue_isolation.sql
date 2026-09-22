-- Memory V3 dialogue isolation: one independent lifecycle state per (user, conversation).
-- Mirrors memory_v3_lifecycle_shadow_* exactly, re-keyed to include conversation_id.
-- Domain 1 only: no live wiring reads these tables yet (see
-- docs/superpowers/specs/2026-09-22-memory-v3-dialogue-isolation-design.md).

CREATE TABLE public.memory_v3_dialogue_heads (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  schema_version text NOT NULL DEFAULT 'memory-v3-dialogue-state-v1'
    CHECK (schema_version = 'memory-v3-dialogue-state-v1'),
  state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision BETWEEN 0 AND 9007199254740991),
  next_memory_ordinal bigint NOT NULL DEFAULT 1 CHECK (next_memory_ordinal BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, conversation_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.memory_v3_dialogue_items (
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  memory_key text NOT NULL CHECK (memory_key ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('event', 'recurrence', 'hypothesis')),
  claim text NOT NULL CHECK (length(btrim(claim)) > 0),
  status text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  event_time_start text NULL,
  event_time_end text NULL,
  alternative text NULL,
  first_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (user_id, conversation_id, memory_key),
  FOREIGN KEY (user_id, conversation_id)
    REFERENCES public.memory_v3_dialogue_heads(user_id, conversation_id) ON DELETE CASCADE,
  CHECK (
    (kind = 'event' AND status IN ('active', 'corrected', 'rejected')) OR
    (kind = 'recurrence' AND status IN ('candidate', 'active', 'stale', 'rejected')) OR
    (kind = 'hypothesis' AND status IN ('candidate', 'supported', 'stale', 'rejected'))
  ),
  CHECK ((kind = 'hypothesis' AND alternative IS NOT NULL AND length(btrim(alternative)) > 0) OR
         (kind <> 'hypothesis' AND alternative IS NULL)),
  CHECK (updated_at >= first_seen_at)
);

CREATE TABLE public.memory_v3_dialogue_evidence (
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  memory_key text NOT NULL,
  source_message_id uuid NOT NULL REFERENCES public.messages(id),
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'corrects', 'rejects')),
  support_type text NULL CHECK (support_type IS NULL OR support_type IN ('episode_observation', 'pattern_confirmation', 'scope_boundary')),
  episode_key text NULL,
  provenance_role text NOT NULL CHECK (provenance_role = 'user'),
  mention_time timestamptz NOT NULL,
  PRIMARY KEY (user_id, conversation_id, memory_key, source_message_id, relation),
  FOREIGN KEY (user_id, conversation_id, memory_key)
    REFERENCES public.memory_v3_dialogue_items(user_id, conversation_id, memory_key) ON DELETE CASCADE,
  CHECK ((support_type = 'episode_observation' AND episode_key IS NOT NULL AND length(btrim(episode_key)) > 0) OR
         (support_type IN ('pattern_confirmation', 'scope_boundary') AND episode_key IS NULL) OR
         (support_type IS NULL AND episode_key IS NOT NULL AND length(btrim(episode_key)) > 0))
);

CREATE TABLE public.memory_v3_dialogue_identities (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL CHECK (pipeline_version = 'memory-v3-dialogue-v1'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, conversation_id, pipeline_version, input_hash)
);

CREATE TABLE public.memory_v3_dialogue_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL CHECK (pipeline_version = 'memory-v3-dialogue-v1'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  extractor_version text NOT NULL CHECK (length(btrim(extractor_version)) > 0),
  reconciler_version text NOT NULL CHECK (length(btrim(reconciler_version)) > 0),
  model text NOT NULL CHECK (model = 'google/gemini-3.7-flash'),
  status text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
  diagnostic_code text NULL CHECK (diagnostic_code IS NULL OR diagnostic_code IN (
    'invalid_source', 'state_too_large', 'extractor_transport_failed', 'extractor_parse_invalid',
    'extractor_shape_invalid', 'extractor_contract_invalid', 'reconciler_request_too_large',
    'reconciler_transport_failed', 'reconciler_parse_invalid', 'reconciler_shape_invalid',
    'reconciler_contract_invalid', 'state_conflict', 'state_write_failed',
    'reservation_failed', 'unknown_failure'
  )),
  source_last_message_id uuid NOT NULL,
  source_last_created_at timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count BETWEEN 1 AND 60),
  user_message_count integer NOT NULL CHECK (user_message_count BETWEEN 1 AND message_count),
  expected_state_revision bigint NOT NULL CHECK (expected_state_revision BETWEEN 0 AND 9007199254740991),
  resulting_state_revision bigint NULL CHECK (resulting_state_revision BETWEEN 0 AND 9007199254740991),
  extraction jsonb NULL,
  operations jsonb NULL,
  transitions jsonb NULL,
  item_count integer NULL CHECK (item_count IS NULL OR item_count BETWEEN 0 AND 100),
  evidence_count integer NULL CHECK (evidence_count IS NULL OR evidence_count BETWEEN 0 AND 500),
  transition_count integer NULL CHECK (transition_count IS NULL OR transition_count >= 0),
  extractor_prompt_tokens integer NULL CHECK (extractor_prompt_tokens IS NULL OR extractor_prompt_tokens >= 0),
  extractor_completion_tokens integer NULL CHECK (extractor_completion_tokens IS NULL OR extractor_completion_tokens >= 0),
  extractor_cost_usd numeric NULL CHECK (extractor_cost_usd IS NULL OR extractor_cost_usd >= 0),
  reconciler_prompt_tokens integer NULL CHECK (reconciler_prompt_tokens IS NULL OR reconciler_prompt_tokens >= 0),
  reconciler_completion_tokens integer NULL CHECK (reconciler_completion_tokens IS NULL OR reconciler_completion_tokens >= 0),
  reconciler_cost_usd numeric NULL CHECK (reconciler_cost_usd IS NULL OR reconciler_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz NULL,
  UNIQUE (user_id, conversation_id, pipeline_version, input_hash),
  FOREIGN KEY (user_id, conversation_id, pipeline_version, input_hash)
    REFERENCES public.memory_v3_dialogue_identities(user_id, conversation_id, pipeline_version, input_hash)
    ON DELETE CASCADE,
  CONSTRAINT memory_v3_dialogue_runs_extractor_usage_shape CHECK (
    (extractor_prompt_tokens IS NULL AND extractor_completion_tokens IS NULL AND extractor_cost_usd IS NULL) OR
    (extractor_prompt_tokens IS NOT NULL AND extractor_completion_tokens IS NOT NULL AND extractor_cost_usd IS NOT NULL)
  ),
  CONSTRAINT memory_v3_dialogue_runs_reconciler_usage_shape CHECK (
    (reconciler_prompt_tokens IS NULL AND reconciler_completion_tokens IS NULL AND reconciler_cost_usd IS NULL) OR
    (reconciler_prompt_tokens IS NOT NULL AND reconciler_completion_tokens IS NOT NULL AND reconciler_cost_usd IS NOT NULL)
  ),
  CONSTRAINT memory_v3_dialogue_runs_terminal_shape CHECK (
    (status = 'reserved' AND completed_at IS NULL AND diagnostic_code IS NULL AND resulting_state_revision IS NULL
      AND extraction IS NULL AND operations IS NULL AND transitions IS NULL AND item_count IS NULL
      AND evidence_count IS NULL AND transition_count IS NULL AND extractor_prompt_tokens IS NULL
      AND extractor_completion_tokens IS NULL AND extractor_cost_usd IS NULL AND reconciler_prompt_tokens IS NULL
      AND reconciler_completion_tokens IS NULL AND reconciler_cost_usd IS NULL)
    OR
    (status = 'succeeded' AND completed_at IS NOT NULL AND diagnostic_code IS NULL
      AND resulting_state_revision IS NOT NULL AND extraction IS NOT NULL AND operations IS NOT NULL
      AND transitions IS NOT NULL AND item_count IS NOT NULL AND evidence_count IS NOT NULL
      AND transition_count IS NOT NULL)
    OR
    (status = 'failed' AND completed_at IS NOT NULL AND diagnostic_code IS NOT NULL
      AND resulting_state_revision IS NULL AND extraction IS NULL AND operations IS NULL AND transitions IS NULL
      AND item_count IS NULL AND evidence_count IS NULL AND transition_count IS NULL
      AND extractor_prompt_tokens IS NULL AND extractor_completion_tokens IS NULL AND extractor_cost_usd IS NULL
      AND reconciler_prompt_tokens IS NULL AND reconciler_completion_tokens IS NULL AND reconciler_cost_usd IS NULL)
  )
);

CREATE INDEX memory_v3_dialogue_evidence_source_idx
  ON public.memory_v3_dialogue_evidence(source_message_id);
CREATE INDEX memory_v3_dialogue_runs_user_conversation_created_idx
  ON public.memory_v3_dialogue_runs(user_id, conversation_id, created_at DESC);
CREATE INDEX memory_v3_dialogue_runs_created_idx
  ON public.memory_v3_dialogue_runs(created_at);

ALTER TABLE public.memory_v3_dialogue_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_runs ENABLE ROW LEVEL SECURITY;
-- No policies: RLS enabled + zero policies = fail-closed for anon/authenticated,
-- same pattern as memory_v3_lifecycle_shadow_* and protocol_events. Table-level
-- REVOKE/GRANT below is a second, independent layer (service_role bypasses RLS
-- by default, so RLS alone is not the only thing standing between these tables
-- and a client connection).

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run(
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
  -- serialize against each other.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':' || p_conversation_id::text || ':' ||
    ((pg_catalog.now() AT TIME ZONE 'UTC')::date)::text, 0));

  IF EXISTS (SELECT 1 FROM public.memory_v3_dialogue_identities
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_daily_count
  FROM public.memory_v3_dialogue_runs
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id
    AND created_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_daily_count >= 1 THEN
    result := 'daily_cap'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
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
$$;

CREATE OR REPLACE FUNCTION public.fail_memory_v3_dialogue_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code, completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;
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
      alternative, first_seen_at, updated_at, revision)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
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

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' STABLE AS $$
DECLARE
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_items jsonb;
BEGIN
  SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'kind', i.kind, 'claim', i.claim,
    'status', CASE WHEN i.kind = 'hypothesis' THEN 'supported' ELSE 'active' END,
    'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
    'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'updatedAt', i.updated_at)
    ORDER BY i.updated_at DESC), '[]'::jsonb) INTO v_items
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id
    AND i.status IN ('active', 'supported')
  LIMIT 12;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-dialogue-read-context-v1',
    'stateRevision', v_head.state_revision, 'items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_memory_v3_dialogue_runs()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_deleted bigint;
BEGIN
  DELETE FROM public.memory_v3_dialogue_runs
  WHERE created_at < pg_catalog.now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_dialogue_items_for_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.memory_v3_dialogue_items i
  WHERE EXISTS (SELECT 1 FROM public.memory_v3_dialogue_evidence e
    WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id
      AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_dialogue_items_for_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.memory_v3_dialogue_heads WHERE conversation_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER delete_memory_v3_dialogue_items_before_message
BEFORE DELETE ON public.messages FOR EACH ROW
EXECUTE FUNCTION public.delete_memory_v3_dialogue_items_for_message();
CREATE TRIGGER delete_memory_v3_dialogue_items_before_conversation
BEFORE DELETE ON public.conversations FOR EACH ROW
EXECUTE FUNCTION public.delete_memory_v3_dialogue_items_for_conversation();
-- Note: the conversation trigger deletes the head row directly (cascading to
-- items/evidence via their own ON DELETE CASCADE foreign keys to the head),
-- unlike the lifecycle-shadow original's per-item DELETE -- because here a
-- conversation's whole state is scoped to a head row that has no reason to
-- outlive the conversation it belongs to, unlike the user-wide head there.

REVOKE ALL ON TABLE public.memory_v3_dialogue_heads FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_dialogue_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_dialogue_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_dialogue_identities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_dialogue_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_dialogue_heads TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_dialogue_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_dialogue_evidence TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_dialogue_identities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_dialogue_runs TO service_role;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_dialogue_run(uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_memory_v3_dialogue_state(uuid, uuid, uuid, bigint, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_read_context(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_memory_v3_dialogue_runs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_memory_v3_dialogue_items_for_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_memory_v3_dialogue_items_for_conversation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_dialogue_run(uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_memory_v3_dialogue_state(uuid, uuid, uuid, bigint, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_read_context(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_memory_v3_dialogue_runs() TO service_role;

SELECT cron.unschedule('memory-v3-dialogue-purge-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'memory-v3-dialogue-purge-daily');
SELECT cron.schedule(
  'memory-v3-dialogue-purge-daily',
  '31 3 * * *',
  $cron$SELECT public.purge_memory_v3_dialogue_runs();$cron$
);
