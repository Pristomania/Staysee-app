/*
  # 107: search by meaning across the WHOLE conversation, with the model written down

  Why: the search saw only the first 400 messages of a conversation, and a vector said nothing about which model made it
  (a vector of another model compares as silent garbage). This adds, without deleting or rewriting anything:

  - message_embeddings.embedding_model: the model that made the vector.
  - message_embeddings.embedding_1024: the vector of a 1024-number model (BAAI/bge-m3). The old 1536 column stays untouched
    (and becomes nullable); its rows are simply no longer read. They can be dropped later, on the owner's word.
  - messages_missing_embeddings(): the newest messages of one conversation that have no vector of the given model yet.
  - match_conversation_embeddings_by_model(): similarity search in ONE conversation, only among vectors of the given model,
    returning the reply that followed each hit.

  Both functions run with the caller's rights (SECURITY INVOKER), so the conversation locks and the row policies of
  migration 103 keep applying. The role of a message is read with to_jsonb(): it works whether or not the role column exists.
*/

ALTER TABLE public.message_embeddings
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_1024 vector(1024);

ALTER TABLE public.message_embeddings ALTER COLUMN embedding DROP NOT NULL;

CREATE INDEX IF NOT EXISTS message_embeddings_embedding_1024_hnsw_idx
  ON public.message_embeddings
  USING hnsw (embedding_1024 vector_cosine_ops);

CREATE INDEX IF NOT EXISTS message_embeddings_conversation_model_idx
  ON public.message_embeddings (conversation_id, embedding_model);

CREATE OR REPLACE FUNCTION public.messages_missing_embeddings(
  p_conversation_id uuid,
  p_model text,
  p_limit int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  sender text,
  role text,
  content text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    m.id,
    m.sender,
    to_jsonb(m) ->> 'role' AS role,
    m.content,
    m.created_at
  FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND length(btrim(coalesce(m.content, ''))) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.message_embeddings me
      WHERE me.message_id = m.id
        AND me.embedding_model = p_model
        AND me.embedding_1024 IS NOT NULL
    )
  ORDER BY m.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

CREATE OR REPLACE FUNCTION public.match_conversation_embeddings_by_model(
  p_conversation_id uuid,
  p_model text,
  query_embedding vector(1024),
  match_count int DEFAULT 12,
  match_threshold float DEFAULT 0.58,
  p_before_created_at timestamptz DEFAULT NULL
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
    AND (p_before_created_at IS NULL OR m.created_at < p_before_created_at)
    AND (1 - (me.embedding_1024 <=> query_embedding)) > match_threshold
  ORDER BY me.embedding_1024 <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 30));
$$;

GRANT EXECUTE ON FUNCTION public.messages_missing_embeddings(uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.messages_missing_embeddings(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_conversation_embeddings_by_model(uuid, text, vector, int, float, timestamptz) TO service_role;

COMMENT ON COLUMN public.message_embeddings.embedding_model IS
  'The model that made embedding_1024. Vectors of different models are never compared.';
