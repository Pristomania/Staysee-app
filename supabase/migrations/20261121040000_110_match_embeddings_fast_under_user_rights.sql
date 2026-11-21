/*
  # 110: the search by meaning no longer runs out of time for a person's own rights

  Found on 21.11.2026 by comparing what the chat hands to the model with what the same search returns for the service role:
  for an ordinary signed-in person the function of migrations 107/108 failed with "canceling statement due to statement timeout"
  (the role `authenticated` has a limit of 8 seconds), while for the service role it answered at once. The chat swallows that error,
  so only the search by words worked in the live chat and every question that needs the meaning («поссорилась с Леной» for
  «ругалась с подругой») got no help from the vectors. Questions with a word in common were answered, the others were not.

  The cause: for EVERY candidate line the function looked up the next message of the conversation, and every row read there passes the
  row security checks of the conversation locks (`can_read_my_conversation`), so the work grew with the square of the conversation length.
  Now the 30 best lines are chosen first (a materialized step), and the next message is looked up for those lines only.

  Same signature, same result, same rights (SECURITY INVOKER, so the conversation locks keep applying). Nothing is deleted or rewritten in any table.
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
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH hits AS MATERIALIZED (
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.sender,
      to_jsonb(m) ->> 'role' AS role,
      m.content,
      m.created_at,
      (1 - (me.embedding_1024 <=> query_embedding))::float AS similarity
    FROM public.message_embeddings me
    INNER JOIN public.messages m ON m.id = me.message_id
    WHERE me.conversation_id = p_conversation_id
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
    h.message_id,
    h.sender,
    h.role,
    h.content,
    h.created_at,
    h.similarity,
    nx.sender AS reply_sender,
    nx.role AS reply_role,
    nx.content AS reply_content
  FROM hits h
  LEFT JOIN LATERAL (
    SELECT n.sender, to_jsonb(n) ->> 'role' AS role, n.content
    FROM public.messages n
    WHERE n.conversation_id = h.conversation_id
      AND n.created_at > h.created_at
    ORDER BY n.created_at ASC
    LIMIT 1
  ) nx ON true
  ORDER BY h.similarity DESC;
$$;

GRANT EXECUTE ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz, int) TO authenticated;
