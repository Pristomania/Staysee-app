CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_read_context(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-lifecycle-read-context-v1',
    'stateRevision', h.state_revision,
    'items', pg_catalog.coalesce(projected.items, '[]'::jsonb)
  )
  FROM public.memory_v3_lifecycle_shadow_heads AS h
  LEFT JOIN LATERAL (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', selected.kind,
        'claim', selected.claim,
        'status', selected.status,
        'sensitivity', selected.sensitivity,
        'eventTimeStart', selected.event_time_start,
        'eventTimeEnd', selected.event_time_end,
        'alternative', selected.alternative,
        'updatedAt', selected.updated_at
      )
      ORDER BY selected.updated_at DESC, selected.memory_key COLLATE "C"
    ) AS items
    FROM (
      SELECT
        i.memory_key,
        i.kind,
        i.claim,
        i.status,
        i.sensitivity,
        i.event_time_start,
        i.event_time_end,
        i.alternative,
        i.updated_at
      FROM public.memory_v3_lifecycle_shadow_items AS i
      WHERE i.user_id = p_user_id
        AND (
          (i.kind = 'event' AND i.status = 'active')
          OR (i.kind = 'recurrence' AND i.status = 'active')
          OR (i.kind = 'hypothesis' AND i.status = 'supported')
        )
      ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
      LIMIT 12
    ) AS selected
  ) AS projected ON true
  WHERE h.user_id = p_user_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_lifecycle_read_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_lifecycle_read_context(uuid) TO service_role;
