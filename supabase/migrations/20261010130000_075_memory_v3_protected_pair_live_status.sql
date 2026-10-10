-- Migration 073's protected-pair branch selected new_item purely by
-- "replaces_memory_key IS NOT NULL", with no status filter -- unlike the
-- plain top-12 branch just above it, which already restricts to the live
-- status per kind. A freshly created recurrence/hypothesis sits in
-- "candidate" status until confirmed; if such an item supersedes a sensitive
-- old item, the old pair-selection could surface it, and the TypeScript
-- read-store's isLinked exception only accepts corrected/stale/rejected for
-- a linked old end, never "candidate" for a linked new end -- so the whole
-- read context would fail validation and drop ALL memory context for the
-- account. This migration restricts new_item to the same live statuses the
-- plain branch already requires. No other clause changes.

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
    'items', COALESCE(projected.items, '[]'::jsonb)
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
        'updatedAt', selected.updated_at,
        'replacesMemoryKey', selected.replaces_memory_key,
        'replacedByMemoryKey', selected.replaced_by_memory_key
      )
      ORDER BY selected.updated_at DESC, selected.memory_key COLLATE "C"
    ) AS items
    FROM (
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_lifecycle_shadow_items AS i
        WHERE i.user_id = p_user_id
          AND (
            (i.kind = 'event' AND i.status = 'active')
            OR (i.kind = 'recurrence' AND i.status = 'active')
            OR (i.kind = 'hypothesis' AND i.status = 'supported')
          )
        ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
        LIMIT 12
      )
      UNION
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_lifecycle_shadow_items AS i
        JOIN (
          SELECT new_item.memory_key AS new_key, new_item.replaces_memory_key AS old_key
          FROM public.memory_v3_lifecycle_shadow_items AS new_item
          JOIN public.memory_v3_lifecycle_shadow_items AS old_item
            ON old_item.user_id = p_user_id AND old_item.memory_key = new_item.replaces_memory_key
          WHERE new_item.user_id = p_user_id AND new_item.replaces_memory_key IS NOT NULL
            AND (new_item.sensitivity = 'sensitive' OR old_item.sensitivity = 'sensitive')
            AND (
              (new_item.kind = 'event' AND new_item.status = 'active')
              OR (new_item.kind = 'recurrence' AND new_item.status = 'active')
              OR (new_item.kind = 'hypothesis' AND new_item.status = 'supported')
            )
          ORDER BY new_item.updated_at DESC
          LIMIT 5
        ) AS protected_pair
          ON i.memory_key IN (protected_pair.new_key, protected_pair.old_key)
        WHERE i.user_id = p_user_id
      )
    ) AS selected
  ) AS projected ON true
  WHERE h.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-dialogue-read-context-v1',
    'stateRevision', h.state_revision,
    'items', COALESCE(projected.items, '[]'::jsonb)
  )
  FROM public.memory_v3_dialogue_heads AS h
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
        'updatedAt', selected.updated_at,
        'replacesMemoryKey', selected.replaces_memory_key,
        'replacedByMemoryKey', selected.replaced_by_memory_key
      )
      ORDER BY selected.updated_at DESC, selected.memory_key COLLATE "C"
    ) AS items
    FROM (
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_dialogue_items AS i
        WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id
          AND (
            (i.kind = 'event' AND i.status = 'active')
            OR (i.kind = 'recurrence' AND i.status = 'active')
            OR (i.kind = 'hypothesis' AND i.status = 'supported')
          )
        ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
        LIMIT 12
      )
      UNION
      (
        SELECT
          i.memory_key, i.kind, i.claim, i.status, i.sensitivity,
          i.event_time_start, i.event_time_end, i.alternative, i.updated_at,
          i.replaces_memory_key, i.replaced_by_memory_key
        FROM public.memory_v3_dialogue_items AS i
        JOIN (
          SELECT new_item.memory_key AS new_key, new_item.replaces_memory_key AS old_key
          FROM public.memory_v3_dialogue_items AS new_item
          JOIN public.memory_v3_dialogue_items AS old_item
            ON old_item.user_id = p_user_id AND old_item.conversation_id = p_conversation_id
            AND old_item.memory_key = new_item.replaces_memory_key
          WHERE new_item.user_id = p_user_id AND new_item.conversation_id = p_conversation_id
            AND new_item.replaces_memory_key IS NOT NULL
            AND (new_item.sensitivity = 'sensitive' OR old_item.sensitivity = 'sensitive')
            AND (
              (new_item.kind = 'event' AND new_item.status = 'active')
              OR (new_item.kind = 'recurrence' AND new_item.status = 'active')
              OR (new_item.kind = 'hypothesis' AND new_item.status = 'supported')
            )
          ORDER BY new_item.updated_at DESC
          LIMIT 5
        ) AS protected_pair
          ON i.memory_key IN (protected_pair.new_key, protected_pair.old_key)
        WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id
      )
    ) AS selected
  ) AS projected ON true
  WHERE h.user_id = p_user_id AND h.conversation_id = p_conversation_id;
$function$;
