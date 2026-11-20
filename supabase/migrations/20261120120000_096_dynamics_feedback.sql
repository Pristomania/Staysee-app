-- 096: thumbs up / thumbs down under a weekly "Динамика" of a conversation, with an optional short note.
--
-- The same thing migration 095 does for the answers of Stacy, for the weekly dynamics that the model forms for a conversation
-- (a progress_entries row of entry_type 'weekly'). A signed-in person can mark a dynamics of THEIR OWN conversation as good (+1)
-- or not good (-1), once per dynamics, change their mind, take the mark back, and add a short note (not required).
-- The row only POINTS at the dynamics (entry_id); the text is read from progress_entries when the owner of the product looks at
-- the feedback, so nothing is copied out: delete the conversation, the data or the room, and the feedback goes with it.
--
-- Who can do what:
--   * a signed-in person: read, add, change (the mark and the note only) and remove THEIR OWN rows, only on THEIR OWN weekly
--     dynamics in their own conversations;
--   * nobody else through the API; the view dynamics_feedback_review (the owner's view with the e-mail and the text of the
--     dynamics) is readable by the service key only.

CREATE TABLE IF NOT EXISTS public.dynamics_feedback (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  entry_id        uuid        NOT NULL REFERENCES public.progress_entries(id) ON DELETE CASCADE,
  rating          smallint    NOT NULL CHECK (rating IN (-1, 1)),
  comment         text        CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_dynamics_feedback_created ON public.dynamics_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dynamics_feedback_rating_created ON public.dynamics_feedback (rating, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dynamics_feedback_conversation ON public.dynamics_feedback (conversation_id);

ALTER TABLE public.dynamics_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dynamics_feedback select own" ON public.dynamics_feedback;
CREATE POLICY "dynamics_feedback select own" ON public.dynamics_feedback
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "dynamics_feedback insert own" ON public.dynamics_feedback;
CREATE POLICY "dynamics_feedback insert own" ON public.dynamics_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.progress_entries p
      JOIN public.conversations c ON c.id = p.conversation_id
      WHERE p.id = entry_id
        AND p.entry_type = 'weekly'
        AND p.user_id = auth.uid()
        AND c.id = conversation_id
        AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "dynamics_feedback update own" ON public.dynamics_feedback;
CREATE POLICY "dynamics_feedback update own" ON public.dynamics_feedback
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "dynamics_feedback delete own" ON public.dynamics_feedback;
CREATE POLICY "dynamics_feedback delete own" ON public.dynamics_feedback
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Table rights: a person may change only the mark and the note; the dynamics a row points at can never be moved.
REVOKE ALL ON public.dynamics_feedback FROM PUBLIC;
REVOKE ALL ON public.dynamics_feedback FROM anon;
REVOKE ALL ON public.dynamics_feedback FROM authenticated;
GRANT SELECT, DELETE ON public.dynamics_feedback TO authenticated;
GRANT INSERT (conversation_id, entry_id, rating, comment) ON public.dynamics_feedback TO authenticated;
GRANT UPDATE (rating, comment) ON public.dynamics_feedback TO authenticated;
GRANT ALL ON public.dynamics_feedback TO service_role;

CREATE OR REPLACE FUNCTION public.dynamics_feedback_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dynamics_feedback_touch ON public.dynamics_feedback;
CREATE TRIGGER trg_dynamics_feedback_touch
  BEFORE UPDATE ON public.dynamics_feedback
  FOR EACH ROW EXECUTE FUNCTION public.dynamics_feedback_touch();

-- The owner's view. It reads the dynamics from progress_entries, so it holds no copy of its own. Never exposed to people:
-- every right is revoked and only the service key can read it.
CREATE OR REPLACE VIEW public.dynamics_feedback_review AS
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
  f.entry_id,
  p.entry_date,
  left(p.content, 1200) AS dynamics_excerpt
FROM public.dynamics_feedback f
JOIN public.progress_entries p ON p.id = f.entry_id
LEFT JOIN auth.users u ON u.id = f.user_id
LEFT JOIN public.user_usage_tiers t ON t.user_id = f.user_id;

REVOKE ALL ON public.dynamics_feedback_review FROM PUBLIC;
REVOKE ALL ON public.dynamics_feedback_review FROM anon;
REVOKE ALL ON public.dynamics_feedback_review FROM authenticated;
GRANT SELECT ON public.dynamics_feedback_review TO service_role;

-- The content wipe (deleting the data of an account, deleting the room) lists the feedback on dynamics too. It is the 095
-- function with one more table at the end; conversations still come first (the feedback hangs on them and goes with them).
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
    'message_feedback',
    'dynamics_feedback'
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
