-- The reconciler stage of both memory-v3 pipelines (dialogue + lifecycle)
-- can fail three different ways once it has replied at all:
-- reconciler_parse_invalid (not JSON), reconciler_shape_invalid (wrong
-- field shape), reconciler_contract_invalid (right shape, but violates a
-- business rule -- an invented candidateRef, a missing operation, etc).
-- None of the three ever persisted what the model actually said, so a
-- failure like this was only ever a code name with no way to tell which
-- of many possible rule violations it was, short of direct Edge Function
-- log access (which this project has no tooling for). Observed live on
-- 02.10 and 07.10.2026 (dialogue reconciler, reconciler_contract_invalid,
-- both failures on the one canary account) with no way to diagnose either
-- occurrence after the fact.
--
-- Adds a free-text reconciler_raw_response column to both runs tables,
-- diagnostic-only like transport_detail (migration 064) and deliberately
-- not parsed or branched on here. Capped at 8000 characters server-side --
-- comfortably larger than any real reconciler reply (operations lists are
-- bounded by MEMORY_V3_DIALOGUE_MAX_CANDIDATES /
-- MEMORY_V3_LIFECYCLE_MAX_CANDIDATES already) -- so a pathological or
-- adversarial response can't grow a row without bound.
--
-- fail_memory_v3_dialogue_run / fail_memory_v3_lifecycle_shadow_run gain a
-- new optional p_reconciler_raw_response parameter (NULL by default, same
-- as p_transport_detail), so every existing call site keeps working
-- unchanged. DROP + CREATE rather than CREATE OR REPLACE: adding a
-- parameter changes the function's identity in Postgres, so OR REPLACE
-- would leave the old 4-argument overload behind instead of replacing it.

ALTER TABLE public.memory_v3_dialogue_runs
  ADD COLUMN IF NOT EXISTS reconciler_raw_response text NULL;

ALTER TABLE public.memory_v3_lifecycle_shadow_runs
  ADD COLUMN IF NOT EXISTS reconciler_raw_response text NULL;

DROP FUNCTION IF EXISTS public.fail_memory_v3_dialogue_run(uuid, uuid, text, text);

CREATE FUNCTION public.fail_memory_v3_dialogue_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,
  p_reconciler_raw_response text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code,
    transport_detail = p_transport_detail,
    reconciler_raw_response = pg_catalog.left(p_reconciler_raw_response, 8000),
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text);

CREATE FUNCTION public.fail_memory_v3_lifecycle_shadow_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,
  p_reconciler_raw_response text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_lifecycle_shadow_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code,
    transport_detail = p_transport_detail,
    reconciler_raw_response = pg_catalog.left(p_reconciler_raw_response, 8000),
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run is not reservable'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text, text) TO service_role;
