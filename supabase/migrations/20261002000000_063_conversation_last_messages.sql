-- The conversation list screen previously fetched each conversation's last
-- message with its own separate query (one round trip per conversation,
-- run in parallel) just to show a one-line preview. With many conversations
-- this meant many simultaneous round trips, which is slow over a real
-- network connection even in parallel. This single RPC returns the last
-- message's content for every requested conversation in one round trip.
--
-- Callable directly by the owning user (same pattern as
-- request_room_deletion in 020_room_deletion.sql): SECURITY DEFINER,
-- scoped by auth.uid() rather than a client-supplied user id, so a caller
-- can never read another account's message previews even if they pass
-- someone else's conversation id -- the join on c.user_id = auth.uid()
-- simply excludes it from the result.
CREATE OR REPLACE FUNCTION public.load_conversation_last_messages(p_conversation_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_object_agg(sub.conversation_id, sub.content), '{}'::jsonb)
  FROM (
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.content
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.user_id = auth.uid() AND m.conversation_id = ANY(p_conversation_ids)
    ORDER BY m.conversation_id, m.created_at DESC
  ) sub;
$function$;

REVOKE ALL ON FUNCTION public.load_conversation_last_messages(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_conversation_last_messages(uuid[]) TO authenticated;
