/*
  # Semantic archive search (per conversation only)

  - message_embeddings: one vector per message
  - match_conversation_message_embeddings: similarity search in ONE conversation
*/

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.message_embeddings (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_embeddings_conversation_id_idx
  ON public.message_embeddings (conversation_id);

CREATE INDEX IF NOT EXISTS message_embeddings_embedding_hnsw_idx
  ON public.message_embeddings
  USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.message_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own message embeddings" ON public.message_embeddings;
CREATE POLICY "Users read own message embeddings"
  ON public.message_embeddings FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.match_conversation_message_embeddings(
  p_conversation_id uuid,
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.32,
  p_before_created_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  message_id uuid,
  sender text,
  content text,
  created_at timestamptz,
  similarity float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    m.id AS message_id,
    m.sender,
    m.content,
    m.created_at,
    (1 - (me.embedding <=> query_embedding))::float AS similarity
  FROM public.message_embeddings me
  INNER JOIN public.messages m ON m.id = me.message_id
  WHERE me.conversation_id = p_conversation_id
    AND (p_before_created_at IS NULL OR m.created_at < p_before_created_at)
    AND (1 - (me.embedding <=> query_embedding)) > match_threshold
  ORDER BY me.embedding <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 20));
$$;

GRANT EXECUTE ON FUNCTION public.match_conversation_message_embeddings TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_conversation_message_embeddings TO service_role;

COMMENT ON TABLE public.message_embeddings IS
  'Embeddings for semantic retrieval within a single conversation (never cross-chat).';
