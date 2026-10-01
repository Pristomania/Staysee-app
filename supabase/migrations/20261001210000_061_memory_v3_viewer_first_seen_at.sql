-- Adds firstSeenAt to the two Memory V3 viewer-read RPCs (updatedAt was
-- added just before this by 060_memory_v3_viewer_updated_at.sql). Lets the
-- viewer distinguish "recorded once, never touched since" (firstSeenAt ==
-- updatedAt) from "has genuinely changed since it was first recorded"
-- (updatedAt is later) -- the reducer only ever bumps updatedAt on a real
-- material change (a revise that actually changes content, or a status
-- transition like mark_stale/reject), never on a plain re-confirmation, so
-- this comparison is a reliable signal of real change, not just re-affirming
-- the same fact again.
-- Same deliberate separation from the hot-path read RPCs as the original --
-- this never touches load_memory_v3_lifecycle_read_context or
-- load_memory_v3_dialogue_read_context.

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
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at
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
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_lifecycle_viewer_items(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_lifecycle_viewer_items(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_viewer_items(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_viewer_items(uuid, uuid) TO service_role;
