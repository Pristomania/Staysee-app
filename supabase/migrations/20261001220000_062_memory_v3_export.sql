-- Adds `alternative` and `status` to the two existing Memory V3 viewer-read
-- RPCs (a hypothesis's alternative explanation, and the status that tells a
-- rejected/stale guess apart from a supported one -- currently only used by
-- the lifecycle/dialogue read-context prompts, never by the viewer) and
-- adds a new load_memory_v3_dialogue_viewer_items_all RPC that returns a
-- user's dialogue memory across every conversation at once (plus
-- conversationId, so two conversations that produced the same fact don't
-- look like unexplained duplicates), for the data-export feature -- the
-- regular per-conversation Память screen keeps using the existing
-- load_memory_v3_dialogue_viewer_items unchanged. Adding fields the
-- existing viewer code doesn't read is additive and harmless: nothing in
-- projectMemoryV3ViewerItems looks at `alternative`, `status`, or
-- `conversationId`, so the day-to-day viewer's behavior does not change.
-- Same deliberate separation from the hot-path read RPCs as every prior
-- viewer migration -- this never touches load_memory_v3_lifecycle_read_context
-- or load_memory_v3_dialogue_read_context.

CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_viewer_items(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'status', i.status,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at,
      'alternative', i.alternative
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
      'status', i.status,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at,
      'alternative', i.alternative
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
$function$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items_all(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'conversationId', i.conversation_id,
      'kind', i.kind,
      'claim', i.claim,
      'status', i.status,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at,
      'alternative', i.alternative
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_viewer_items_all(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_viewer_items_all(uuid) TO service_role;
