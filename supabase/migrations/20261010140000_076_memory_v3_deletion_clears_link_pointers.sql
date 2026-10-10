-- The contract's cross-item consistency check (added earlier in this
-- branch) fails the WHOLE state whenever a stored item's
-- replaces_memory_key/replaced_by_memory_key points at a memory_key that no
-- longer exists in that same conversation/account's item set. Every
-- pre-existing deletion path can remove one half of a linked pair without
-- clearing the surviving half's pointer:
--   - delete_memory_v3_dialogue_item / delete_memory_v3_lifecycle_item
--     (migration 042, backs the Memory viewer's per-item delete button)
--   - delete_memory_v3_dialogue_items_for_message / ..._lifecycle_items_for_message
--     (migrations 039/034, fire BEFORE DELETE ON messages)
--   - delete_memory_v3_lifecycle_items_for_conversation
--     (migration 034, fires BEFORE DELETE ON conversations -- lifecycle
--     items are user-scoped, not conversation-scoped, so this is a partial
--     delete, unlike the dialogue side)
-- Once that happens, every future reservation for that pipeline fails state
-- validation forever, with no recovery short of deleting everything. This
-- migration adds two UPDATE statements before each DELETE, nulling out any
-- other row's pointer that would otherwise dangle. The dialogue
-- conversation-delete trigger is untouched: it deletes the whole head row,
-- which cascades to every item/evidence row for that conversation at once,
-- so no partial, dangling state can survive it.

CREATE OR REPLACE FUNCTION public.delete_memory_v3_lifecycle_item(
  p_user_id uuid, p_memory_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_deleted boolean;
BEGIN
  UPDATE public.memory_v3_lifecycle_shadow_items
  SET replaces_memory_key = NULL
  WHERE user_id = p_user_id AND replaces_memory_key = p_memory_key;
  UPDATE public.memory_v3_lifecycle_shadow_items
  SET replaced_by_memory_key = NULL
  WHERE user_id = p_user_id AND replaced_by_memory_key = p_memory_key;
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
  UPDATE public.memory_v3_dialogue_items
  SET replaces_memory_key = NULL
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND replaces_memory_key = p_memory_key;
  UPDATE public.memory_v3_dialogue_items
  SET replaced_by_memory_key = NULL
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND replaced_by_memory_key = p_memory_key;
  DELETE FROM public.memory_v3_dialogue_items
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND memory_key = p_memory_key
  RETURNING true INTO v_deleted;
  RETURN COALESCE(v_deleted, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_dialogue_items_for_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_dialogue_items u
  SET replaces_memory_key = NULL
  WHERE u.conversation_id = OLD.conversation_id
    AND EXISTS (
      SELECT 1 FROM public.memory_v3_dialogue_items i
      WHERE i.user_id = u.user_id AND i.conversation_id = u.conversation_id
        AND i.memory_key = u.replaces_memory_key
        AND EXISTS (SELECT 1 FROM public.memory_v3_dialogue_evidence e
          WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id
            AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id)
    );
  UPDATE public.memory_v3_dialogue_items u
  SET replaced_by_memory_key = NULL
  WHERE u.conversation_id = OLD.conversation_id
    AND EXISTS (
      SELECT 1 FROM public.memory_v3_dialogue_items i
      WHERE i.user_id = u.user_id AND i.conversation_id = u.conversation_id
        AND i.memory_key = u.replaced_by_memory_key
        AND EXISTS (SELECT 1 FROM public.memory_v3_dialogue_evidence e
          WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id
            AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id)
    );
  DELETE FROM public.memory_v3_dialogue_items i
  WHERE EXISTS (SELECT 1 FROM public.memory_v3_dialogue_evidence e
    WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id
      AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_lifecycle_items_for_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_lifecycle_shadow_items u
  SET replaces_memory_key = NULL
  WHERE EXISTS (
    SELECT 1 FROM public.memory_v3_lifecycle_shadow_items i
    WHERE i.user_id = u.user_id AND i.memory_key = u.replaces_memory_key
      AND EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id)
  );
  UPDATE public.memory_v3_lifecycle_shadow_items u
  SET replaced_by_memory_key = NULL
  WHERE EXISTS (
    SELECT 1 FROM public.memory_v3_lifecycle_shadow_items i
    WHERE i.user_id = u.user_id AND i.memory_key = u.replaced_by_memory_key
      AND EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id)
  );
  DELETE FROM public.memory_v3_lifecycle_shadow_items i
  WHERE EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_evidence e
    WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key AND e.source_message_id = OLD.id);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_lifecycle_items_for_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_lifecycle_shadow_items u
  SET replaces_memory_key = NULL
  WHERE EXISTS (
    SELECT 1 FROM public.memory_v3_lifecycle_shadow_items i
    WHERE i.user_id = u.user_id AND i.memory_key = u.replaces_memory_key
      AND EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key AND e.conversation_id = OLD.id)
  );
  UPDATE public.memory_v3_lifecycle_shadow_items u
  SET replaced_by_memory_key = NULL
  WHERE EXISTS (
    SELECT 1 FROM public.memory_v3_lifecycle_shadow_items i
    WHERE i.user_id = u.user_id AND i.memory_key = u.replaced_by_memory_key
      AND EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key AND e.conversation_id = OLD.id)
  );
  DELETE FROM public.memory_v3_lifecycle_shadow_items i
  WHERE EXISTS (SELECT 1 FROM public.memory_v3_lifecycle_shadow_evidence e
    WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key AND e.conversation_id = OLD.id);
  RETURN OLD;
END;
$$;
