-- The extractor stage of both memory-v3 pipelines (dialogue + lifecycle)
-- computes a specific transport diagnostic when a call to the AI model
-- fails -- timeout vs. a 4xx/5xx from the provider vs. an invalid response
-- -- but the shadow runner only ever persisted the generic
-- 'extractor_transport_failed' bucket, discarding the specific reason.
-- (The reconciler stage already has an equivalent generic bucket,
-- 'reconciler_transport_failed', with the same loss of detail.) This made
-- a real, recurring reliability problem (observed: dialogue memory writes
-- failing well over half the time over several days) impossible to
-- diagnose without direct Edge Function log access.
--
-- Adds a free-text transport_detail column to both runs tables -- NOT a
-- closed enum like diagnostic_code, since the underlying transport
-- modules (transport.ts for the extractor, dialogueTransport.ts /
-- lifecycleTransport.ts for the reconciler) each have their own, already
-- more granular, independently-evolving set of specific codes (including
-- exact HTTP statuses like 'provider_http_429' for rate limiting) -- a
-- shared closed whitelist across both would just be another thing to keep
-- in sync for no real benefit, since this column is diagnostic-only and
-- never branched on.
--
-- fail_memory_v3_dialogue_run / fail_memory_v3_lifecycle_shadow_run gain a
-- new optional p_transport_detail parameter (NULL by default, so every
-- existing call site that has no specific transport code to report keeps
-- working unchanged). DROP + CREATE rather than CREATE OR REPLACE: adding
-- a parameter changes the function's identity in Postgres, so OR REPLACE
-- would leave the old 3-argument overload behind instead of replacing it.

ALTER TABLE public.memory_v3_dialogue_runs
  ADD COLUMN IF NOT EXISTS transport_detail text NULL;

ALTER TABLE public.memory_v3_lifecycle_shadow_runs
  ADD COLUMN IF NOT EXISTS transport_detail text NULL;

DROP FUNCTION IF EXISTS public.fail_memory_v3_dialogue_run(uuid, uuid, text);

CREATE FUNCTION public.fail_memory_v3_dialogue_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code,
    transport_detail = p_transport_detail, completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text);

CREATE FUNCTION public.fail_memory_v3_lifecycle_shadow_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_lifecycle_shadow_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code,
    transport_detail = p_transport_detail, completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run is not reservable'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text) TO service_role;
