-- Bulk-delete RPCs for the Privacy screen's new "delete smart memory"
-- button. User-facing Memory V3 content lives in items (and heads).
-- Evidence already cascades from items (ON DELETE CASCADE in 034/039).
-- identities/runs are operational bookkeeping (idempotency keys and
-- extraction-run audit), not user-facing claims -- they are left in
-- place on purpose. See the matching PR description.

CREATE OR REPLACE FUNCTION public.delete_all_memory_v3_lifecycle_data(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  -- Delete items first (evidence cascades). Delete the head last so a
  -- concurrent live write can't recreate items against an already-gone
  -- head in a strange order.
  DELETE FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id;
  DELETE FROM public.memory_v3_lifecycle_shadow_heads WHERE user_id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_all_memory_v3_dialogue_data(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  -- Scoped by user_id only, across ALL of that user's conversations at
  -- once -- this is a full reset, not a per-conversation operation.
  DELETE FROM public.memory_v3_dialogue_items WHERE user_id = p_user_id;
  DELETE FROM public.memory_v3_dialogue_heads WHERE user_id = p_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_all_memory_v3_lifecycle_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_all_memory_v3_lifecycle_data(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.delete_all_memory_v3_dialogue_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_all_memory_v3_dialogue_data(uuid) TO service_role;
