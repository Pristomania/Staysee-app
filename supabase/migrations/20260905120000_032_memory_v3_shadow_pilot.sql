-- Memory V3 production shadow pilot: durable at-most-once identity and 30-day payload store.

CREATE TABLE public.memory_v3_shadow_identities (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  extractor_version text NOT NULL CHECK (length(btrim(extractor_version)) > 0),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, conversation_id, extractor_version, input_hash)
);

CREATE TABLE public.memory_v3_shadow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  extractor_version text NOT NULL CHECK (length(btrim(extractor_version)) > 0),
  model text NOT NULL CHECK (length(btrim(model)) > 0),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
  diagnostic_code text NULL CHECK (
    diagnostic_code IS NULL OR diagnostic_code IN (
      'invalid_source',
      'prompt_too_large',
      'reservation_failed',
      'transport_failed',
      'transport_timeout',
      'provider_http_4xx',
      'provider_http_5xx',
      'provider_response_invalid',
      'extractor_parse_invalid',
      'extractor_shape_invalid',
      'extractor_contract_invalid',
      'completion_write_failed',
      'unknown_failure'
    )
  ),
  source_last_message_id uuid NOT NULL,
  source_last_created_at timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count > 0 AND message_count <= 60),
  user_message_count integer NOT NULL CHECK (user_message_count > 0 AND user_message_count <= message_count),
  item_count integer NULL CHECK (item_count IS NULL OR item_count >= 0),
  evidence_count integer NULL CHECK (evidence_count IS NULL OR evidence_count >= 0),
  extraction jsonb NULL,
  prompt_tokens integer NULL CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer NULL CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  cost_usd numeric NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz NULL,
  FOREIGN KEY (user_id, conversation_id, extractor_version, input_hash)
    REFERENCES public.memory_v3_shadow_identities(user_id, conversation_id, extractor_version, input_hash)
    ON DELETE CASCADE,
  CONSTRAINT memory_v3_shadow_runs_usage_shape CHECK (
    (
      prompt_tokens IS NULL
      AND completion_tokens IS NULL
      AND cost_usd IS NULL
    ) OR (
      prompt_tokens IS NOT NULL
      AND completion_tokens IS NOT NULL
      AND cost_usd IS NOT NULL
    )
  ),
  CONSTRAINT memory_v3_shadow_runs_terminal_shape CHECK (
    (
      status = 'reserved'
      AND completed_at IS NULL
      AND diagnostic_code IS NULL
      AND item_count IS NULL
      AND evidence_count IS NULL
      AND extraction IS NULL
      AND prompt_tokens IS NULL
      AND completion_tokens IS NULL
      AND cost_usd IS NULL
    ) OR (
      status = 'succeeded'
      AND completed_at IS NOT NULL
      AND extraction IS NOT NULL
      AND item_count IS NOT NULL
      AND evidence_count IS NOT NULL
      AND diagnostic_code IS NULL
    ) OR (
      status = 'failed'
      AND completed_at IS NOT NULL
      AND diagnostic_code IS NOT NULL
      AND extraction IS NULL
      AND item_count IS NULL
      AND evidence_count IS NULL
      AND prompt_tokens IS NULL
      AND completion_tokens IS NULL
      AND cost_usd IS NULL
    )
  )
);

CREATE INDEX memory_v3_shadow_runs_user_created_idx
  ON public.memory_v3_shadow_runs(user_id, created_at DESC);
CREATE INDEX memory_v3_shadow_runs_conversation_created_idx
  ON public.memory_v3_shadow_runs(conversation_id, created_at DESC);
CREATE INDEX memory_v3_shadow_runs_created_idx
  ON public.memory_v3_shadow_runs(created_at);

ALTER TABLE public.memory_v3_shadow_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_shadow_runs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_shadow_run(
  p_user_id uuid,
  p_conversation_id uuid,
  p_extractor_version text,
  p_model text,
  p_input_hash text,
  p_source_last_message_id uuid,
  p_source_last_created_at timestamptz,
  p_message_count integer,
  p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_daily_count integer;
  v_claimed boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations
    WHERE id = p_conversation_id
      AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'invalid shadow reservation' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || (pg_catalog.now() AT TIME ZONE 'UTC')::date::text,
      0
    )
  );

  DELETE FROM public.memory_v3_shadow_runs
  WHERE created_at < pg_catalog.now() - INTERVAL '30 days';

  IF EXISTS (
    SELECT 1
    FROM public.memory_v3_shadow_identities
    WHERE user_id = p_user_id
      AND conversation_id = p_conversation_id
      AND extractor_version = p_extractor_version
      AND input_hash = p_input_hash
  ) THEN
    result := 'duplicate';
    run_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_daily_count
  FROM public.memory_v3_shadow_runs
  WHERE user_id = p_user_id
    AND created_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  IF v_daily_count >= 4 THEN
    result := 'daily_cap';
    run_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.memory_v3_shadow_identities (
    user_id,
    conversation_id,
    extractor_version,
    input_hash
  ) VALUES (
    p_user_id,
    p_conversation_id,
    p_extractor_version,
    p_input_hash
  )
  ON CONFLICT (user_id, conversation_id, extractor_version, input_hash) DO NOTHING
  RETURNING true INTO v_claimed;

  IF v_claimed IS DISTINCT FROM true THEN
    result := 'duplicate';
    run_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.memory_v3_shadow_runs (
    user_id,
    conversation_id,
    extractor_version,
    model,
    input_hash,
    status,
    source_last_message_id,
    source_last_created_at,
    message_count,
    user_message_count
  ) VALUES (
    p_user_id,
    p_conversation_id,
    p_extractor_version,
    p_model,
    p_input_hash,
    'reserved',
    p_source_last_message_id,
    p_source_last_created_at,
    p_message_count,
    p_user_message_count
  )
  RETURNING id INTO run_id;

  result := 'reserved';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_memory_v3_shadow_run(
  p_run_id uuid,
  p_user_id uuid,
  p_status text,
  p_diagnostic_code text,
  p_item_count integer,
  p_evidence_count integer,
  p_extraction jsonb,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_cost_usd numeric,
  p_completed_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('succeeded', 'failed') OR p_completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid shadow completion';
  END IF;

  UPDATE public.memory_v3_shadow_runs
  SET
    status = p_status,
    diagnostic_code = p_diagnostic_code,
    item_count = p_item_count,
    evidence_count = p_evidence_count,
    extraction = p_extraction,
    prompt_tokens = p_prompt_tokens,
    completion_tokens = p_completion_tokens,
    cost_usd = p_cost_usd,
    completed_at = p_completed_at
  WHERE id = p_run_id
    AND user_id = p_user_id
    AND status = 'reserved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shadow run is not reservable';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_memory_v3_shadow_runs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.memory_v3_shadow_runs
  WHERE created_at < pg_catalog.now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON TABLE public.memory_v3_shadow_identities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_shadow_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_shadow_identities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_v3_shadow_runs TO service_role;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_shadow_run(uuid, uuid, text, text, text, uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_memory_v3_shadow_run(uuid, uuid, text, text, integer, integer, jsonb, integer, integer, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_memory_v3_shadow_runs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_shadow_run(uuid, uuid, text, text, text, uuid, timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_memory_v3_shadow_run(uuid, uuid, text, text, integer, integer, jsonb, integer, integer, numeric, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_memory_v3_shadow_runs() TO service_role;
