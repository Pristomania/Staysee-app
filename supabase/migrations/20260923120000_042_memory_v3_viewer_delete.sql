-- Backs the new Memory V3 viewer screen's delete action. Direct row
-- delete only -- evidence cascades automatically (ON DELETE CASCADE,
-- already in place since migrations 034/039). No trustedForgetMemoryKeys
-- wiring: a deleted item could be independently re-derived by a future
-- extractor/reconciler run noticing the same thing again -- an accepted,
-- honest limitation of this first version, not solved here.

CREATE OR REPLACE FUNCTION public.delete_memory_v3_lifecycle_item(
  p_user_id uuid, p_memory_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM public.memory_v3_lifecycle_shadow_items
  WHERE user_id = p_user_id AND memory_key = p_memory_key
  RETURNING true INTO v_deleted;
  RETURN COALESCE(v_deleted, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_dialogue_item(
  p_user_id uuid, p_conversation_id uuid, p_memory_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM public.memory_v3_dialogue_items
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND memory_key = p_memory_key
  RETURNING true INTO v_deleted;
  RETURN COALESCE(v_deleted, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_memory_v3_lifecycle_item(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_memory_v3_lifecycle_item(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.delete_memory_v3_dialogue_item(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_memory_v3_dialogue_item(uuid, uuid, text) TO service_role;
