/*
  # 111: the search by meaning checks the access to the conversation once, not on every line

  Migration 110 removed the work that grew with the square of the conversation length, but the search for a signed-in person still took
  about 4 seconds on a conversation of 298 messages (0.2 seconds for the service role), and the role `authenticated` is cut at 8 seconds.
  The reason: the row security policies of `message_embeddings` and `messages` call `can_read_my_conversation(...)` on every row, and that
  function is VOLATILE (it joins conversations, usage tiers and profiles), so PostgreSQL cannot call it once. About 600 calls on a short
  conversation, and thousands on a long one.

  Now the function runs with the rights of its owner (SECURITY DEFINER) and asks the SAME question the policies ask, once for the whole
  conversation:  `auth.uid()` must be a signed-in person and `can_read_my_conversation(p_conversation_id)` must be true (it is the person's
  own conversation, it is active, not locked by the plan, the room is not being deleted). If not, it returns nothing.
  Only the lines of that one conversation are read, so nothing of another person or another conversation can come out.

  Who may call it: only `authenticated` (the chat calls it with the person's own token). Not `anon`, not PUBLIC, not `service_role`.
  Nothing is deleted or rewritten in any table.
*/

CREATE OR REPLACE FUNCTION public.match_conversation_embeddings_by_model(
  p_conversation_id uuid,
  p_model text,
  query_embedding vector(1024),
  match_count int DEFAULT 12,
  match_threshold float DEFAULT 0.58,
  p_before_created_at timestamptz DEFAULT NULL,
  p_min_chars int DEFAULT 20
)
RETURNS TABLE (
  message_id uuid,
  sender text,
  role text,
  content text,
  created_at timestamptz,
  similarity float,
  reply_sender text,
  reply_role text,
  reply_content text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_read_my_conversation(p_conversation_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT
      m.id AS hit_id,
      m.conversation_id AS hit_conversation_id,
      m.sender AS hit_sender,
      to_jsonb(m) ->> 'role' AS hit_role,
      m.content AS hit_content,
      m.created_at AS hit_created_at,
      (1 - (me.embedding_1024 <=> query_embedding))::float AS hit_similarity
    FROM public.message_embeddings me
    INNER JOIN public.messages m ON m.id = me.message_id
    WHERE me.conversation_id = p_conversation_id
      AND m.conversation_id = p_conversation_id
      AND me.embedding_model = p_model
      AND me.embedding_1024 IS NOT NULL
      AND (m.sender = 'user' OR (m.sender IS DISTINCT FROM 'ai' AND to_jsonb(m) ->> 'role' = 'user'))
      AND length(btrim(coalesce(m.content, ''))) >= GREATEST(0, p_min_chars)
      AND (p_before_created_at IS NULL OR m.created_at < p_before_created_at)
      AND (1 - (me.embedding_1024 <=> query_embedding)) > match_threshold
    ORDER BY me.embedding_1024 <=> query_embedding
    LIMIT GREATEST(1, LEAST(match_count, 30))
  )
  SELECT
    h.hit_id,
    h.hit_sender,
    h.hit_role,
    h.hit_content,
    h.hit_created_at,
    h.hit_similarity,
    nx.next_sender,
    nx.next_role,
    nx.next_content
  FROM hits h
  LEFT JOIN LATERAL (
    SELECT n.sender AS next_sender, to_jsonb(n) ->> 'role' AS next_role, n.content AS next_content
    FROM public.messages n
    WHERE n.conversation_id = h.hit_conversation_id
      AND n.created_at > h.hit_created_at
    ORDER BY n.created_at ASC
    LIMIT 1
  ) nx ON true
  ORDER BY h.hit_similarity DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz, int) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz, int) TO authenticated;
