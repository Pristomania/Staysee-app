-- The raw reconciler response (migration 065) told us THAT the model's
-- proposal was invalid and showed the exact JSON it returned, but not
-- WHAT it was invalid against -- a reconciler_contract_invalid observed
-- live (07.10.2026) referenced a plausible-looking candidateRef/
-- targetMemoryRef pair that still failed validation, and there was no way
-- to tell which specific rule it broke without also knowing the exact
-- candidates, existing memories, and reference bindings the model was
-- working from at that moment. None of that is otherwise recoverable
-- after the fact: extraction/operations/transitions only ever get
-- persisted on a successful compareAndSwap (migration 039), and a later
-- successful run can change the live state before anyone looks, as
-- happened here.
--
-- Adds a second diagnostic-only column, reconciler_context, holding
-- JSON.stringify({ state, extraction, bindings }) -- exactly the three
-- arguments validateMemoryV3Dialogue{,Lifecycle}Proposal() receives, so a
-- future failure can be replayed through the real validator byte for
-- byte, the same way migration 069's root cause was found. This is
-- ordinary application data already sent to the AI provider and already
-- persisted verbatim on the success path (migration 039's extraction/
-- operations columns) -- not a secret-bearing value like the raw error
-- text migration 068 was careful to keep off this same side channel, so
-- no additional sanitization is needed here.
--
-- Same DROP + CREATE reasoning as migration 065: adding a parameter
-- changes the function's identity in Postgres.

ALTER TABLE public.memory_v3_dialogue_runs
  ADD COLUMN IF NOT EXISTS reconciler_context text NULL;

ALTER TABLE public.memory_v3_lifecycle_shadow_runs
  ADD COLUMN IF NOT EXISTS reconciler_context text NULL;

DROP FUNCTION IF EXISTS public.fail_memory_v3_dialogue_run(uuid, uuid, text, text, text);

CREATE FUNCTION public.fail_memory_v3_dialogue_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,
  p_reconciler_raw_response text DEFAULT NULL, p_reconciler_context text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code,
    transport_detail = p_transport_detail,
    reconciler_raw_response = pg_catalog.left(p_reconciler_raw_response, 8000),
    reconciler_context = pg_catalog.left(p_reconciler_context, 20000),
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text, text, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text, text);

CREATE FUNCTION public.fail_memory_v3_lifecycle_shadow_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,
  p_reconciler_raw_response text DEFAULT NULL, p_reconciler_context text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_lifecycle_shadow_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code,
    transport_detail = p_transport_detail,
    reconciler_raw_response = pg_catalog.left(p_reconciler_raw_response, 8000),
    reconciler_context = pg_catalog.left(p_reconciler_context, 20000),
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run is not reservable'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_lifecycle_shadow_run(uuid, uuid, text, text, text, text) TO service_role;
