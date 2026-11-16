-- 095: thumbs up / thumbs down under an answer, with an optional short note.
--
-- A signed-in person can mark any answer of Stacy in their own conversations as good (+1) or not good (-1), once per
-- answer, change their mind, take the mark back, and add a short note (not required). The row only POINTS at the answer
-- (message_id); the text of the answer and of the question before it is read from the conversation when the owner of the
-- product looks at the feedback. So nothing is copied out of the conversation: delete the conversation, the data or the
-- room, and the feedback goes with it (the row hangs on the conversation; _wipe_account_content also lists it).
--
-- Who can do what:
--   * a signed-in person: read, add, change (the mark and the note only) and remove THEIR OWN rows, only on THEIR OWN answers
--     of Stacy (sender 'ai') in their own conversations;
--   * nobody else through the API; the view message_feedback_review (the owner's view with the email, the answer, the
--     question, the plan and the model that most likely wrote it) is readable by the service key only.

CREATE TABLE IF NOT EXISTS public.message_feedback (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id      uuid        NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  rating          smallint    NOT NULL CHECK (rating IN (-1, 1)),
  comment         text        CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_feedback_created ON public.message_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_feedback_rating_created ON public.message_feedback (rating, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_feedback_conversation ON public.message_feedback (conversation_id);

ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_feedback select own" ON public.message_feedback;
CREATE POLICY "message_feedback select own" ON public.message_feedback
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "message_feedback insert own" ON public.message_feedback;
CREATE POLICY "message_feedback insert own" ON public.message_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = message_id
        AND m.sender = 'ai'
        AND c.id = conversation_id
        AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "message_feedback update own" ON public.message_feedback;
CREATE POLICY "message_feedback update own" ON public.message_feedback
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "message_feedback delete own" ON public.message_feedback;
CREATE POLICY "message_feedback delete own" ON public.message_feedback
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Table rights: a person may change only the mark and the note; the answer a row points at can never be moved.
REVOKE ALL ON public.message_feedback FROM PUBLIC;
REVOKE ALL ON public.message_feedback FROM anon;
REVOKE ALL ON public.message_feedback FROM authenticated;
GRANT SELECT, DELETE ON public.message_feedback TO authenticated;
GRANT INSERT (conversation_id, message_id, rating, comment) ON public.message_feedback TO authenticated;
GRANT UPDATE (rating, comment) ON public.message_feedback TO authenticated;
GRANT ALL ON public.message_feedback TO service_role;

CREATE OR REPLACE FUNCTION public.message_feedback_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_feedback_touch ON public.message_feedback;
CREATE TRIGGER trg_message_feedback_touch
  BEFORE UPDATE ON public.message_feedback
  FOR EACH ROW EXECUTE FUNCTION public.message_feedback_touch();

-- The owner's view. It reads the answer and the question from the conversation, so it holds no copy of its own. The model
-- and the prompt version come from the usage log row nearest before the answer was saved (a good guess, not a proof).
-- Never exposed to people: every right is revoked and only the service key can read it.
CREATE OR REPLACE VIEW public.message_feedback_review AS
SELECT
  f.created_at,
  f.updated_at,
  CASE f.rating WHEN -1 THEN 'плохо' ELSE 'хорошо' END AS verdict,
  f.rating,
  f.comment,
  f.user_id,
  u.email,
  t.tier,
  f.conversation_id,
  f.message_id,
  left(m.content, 600) AS reply_excerpt,
  left(prev.content, 300) AS previous_user_message,
  usage.model AS model_guess,
  usage.prompt_version AS prompt_version_guess
FROM public.message_feedback f
JOIN public.messages m ON m.id = f.message_id
LEFT JOIN auth.users u ON u.id = f.user_id
LEFT JOIN public.user_usage_tiers t ON t.user_id = f.user_id
LEFT JOIN LATERAL (
  SELECT p.content
  FROM public.messages p
  WHERE p.conversation_id = f.conversation_id AND p.sender = 'user' AND p.created_at <= m.created_at
  ORDER BY p.created_at DESC
  LIMIT 1
) prev ON true
LEFT JOIN LATERAL (
  SELECT l.model, l.prompt_version
  FROM public.ai_usage_logs l
  WHERE l.conversation_id = f.conversation_id AND l.created_at <= m.created_at + interval '30 seconds'
  ORDER BY l.created_at DESC
  LIMIT 1
) usage ON true;

REVOKE ALL ON public.message_feedback_review FROM PUBLIC;
REVOKE ALL ON public.message_feedback_review FROM anon;
REVOKE ALL ON public.message_feedback_review FROM authenticated;
GRANT SELECT ON public.message_feedback_review TO service_role;

-- The content wipe (deleting the data of an account, deleting the room) lists the feedback too. It is the 092 function with
-- one more table at the end; conversations still come first (the feedback hangs on them and goes with them already).
CREATE OR REPLACE FUNCTION public._wipe_account_content(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Conversations first: everything with a conversation_id hangs on it and goes with it. The rest are the tables that only
  -- know the person (notes, derived logs). The memory goes through _wipe_memory.
  v_tables text[] := ARRAY[
    'conversations',
    'message_embeddings',
    'message_length_events',
    'message_model_summaries',
    'progress_entries',
    'protocol_events',
    'ai_reply_recovery_events',
    'message_feedback'
  ];
  v_table text;
  v_rows  bigint;
  v_total bigint := 0;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', v_table) USING p_user_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_total := v_total + v_rows;
    END IF;
  END LOOP;
  v_total := v_total + public._wipe_memory(p_user_id);
  RETURN v_total;
END;
$$;
