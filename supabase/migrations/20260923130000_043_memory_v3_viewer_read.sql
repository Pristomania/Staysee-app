-- Dedicated read path for the new Memory V3 viewer screen. Deliberately
-- NOT a modification of load_memory_v3_lifecycle_read_context /
-- load_memory_v3_dialogue_read_context -- those are hot-path RPCs called
-- on every live chat reply, and their TypeScript readers
-- (lifecycleReadStore.ts / dialogueReadStore.ts) validate the returned
-- item shape with an exact field-count check, so adding a field there
-- would require touching already-proven, high-traffic code for a
-- screen that isn't even in the request path. A separate, small,
-- viewer-only RPC pair is zero risk to the live chat instead.
--
-- Includes memory_key (needed so the viewer can identify which item to
-- delete) and omits status/updatedAt/alternative -- fields the viewer
-- never shows (see viewerProjection.ts). Hypothesis filtering happens in
-- application code, not here, matching where the rest of Memory V3's
-- curation logic already lives.

CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_viewer_items(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_lifecycle_shadow_items i
  WHERE i.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_lifecycle_viewer_items(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_lifecycle_viewer_items(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_viewer_items(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_viewer_items(uuid, uuid) TO service_role;
