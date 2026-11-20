/*
  # 108: the search by meaning returns only the person's own lines, and not the very short ones

  Measured on a made-up conversation of nine months (142 lines of the person, 36 questions with known answers, 20.11.2026):
  very short lines ("устала", "мне тяжело", "голова болит") are close in meaning to any question about feelings and crowd out
  the right line; and answers of the assistant (which are never shown as hits) used to take places among the best 12.

  This replaces the function of migration 107 (created a few hours earlier, no data depends on it) with one that
  - looks only at lines written by the person (sender 'user', or role 'user' when there is no sender),
  - skips lines shorter than p_min_chars characters (a length, not a word: nothing is read from the text),
  - is otherwise the same: one conversation, one model, the caller's rights (the conversation locks keep applying).
  Nothing is deleted or rewritten in any table.
*/

DROP FUNCTION IF EXISTS public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz);

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
  SELECT
    m.id AS message_id,
    m.sender,
    to_jsonb(m) ->> 'role' AS role,
    m.content,
    m.created_at,
    (1 - (me.embedding_1024 <=> query_embedding))::float AS similarity,
    nx.sender AS reply_sender,
    nx.role AS reply_role,
    nx.content AS reply_content
  FROM public.message_embeddings me
  INNER JOIN public.messages m ON m.id = me.message_id
  LEFT JOIN LATERAL (
    SELECT n.sender, to_jsonb(n) ->> 'role' AS role, n.content
    FROM public.messages n
    WHERE n.conversation_id = m.conversation_id
      AND n.created_at > m.created_at
    ORDER BY n.created_at ASC
    LIMIT 1
  ) nx ON true
  WHERE me.conversation_id = p_conversation_id
    AND me.embedding_model = p_model
    AND me.embedding_1024 IS NOT NULL
    AND (m.sender = 'user' OR (m.sender IS DISTINCT FROM 'ai' AND to_jsonb(m) ->> 'role' = 'user'))
    AND length(btrim(coalesce(m.content, ''))) >= GREATEST(0, p_min_chars)
    AND (p_before_created_at IS NULL OR m.created_at < p_before_created_at)
    AND (1 - (me.embedding_1024 <=> query_embedding)) > match_threshold
  ORDER BY me.embedding_1024 <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 30));
$$;

GRANT EXECUTE ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz, int) TO service_role;
