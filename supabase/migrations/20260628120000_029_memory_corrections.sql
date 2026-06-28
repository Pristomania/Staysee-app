-- Durable user memory corrections (v1: cohabitation, relationship status, explicit delete).

CREATE TABLE IF NOT EXISTS public.memory_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  source_message_id uuid NULL REFERENCES public.messages(id) ON DELETE SET NULL,
  subject_key text NOT NULL,
  correction_text text NOT NULL,
  display_text text NOT NULL,
  old_text text NULL,
  scope text NOT NULL CHECK (scope IN ('conversation', 'global')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT memory_corrections_correction_text_len
    CHECK (char_length(correction_text) BETWEEN 3 AND 420),
  CONSTRAINT memory_corrections_display_text_len
    CHECK (char_length(display_text) BETWEEN 3 AND 280),
  CONSTRAINT memory_corrections_subject_key_len
    CHECK (char_length(subject_key) BETWEEN 3 AND 80),
  CONSTRAINT memory_corrections_scope_conversation_ck
    CHECK (
      (scope = 'conversation' AND conversation_id IS NOT NULL)
      OR (scope = 'global' AND conversation_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_corrections_one_active_per_subject
  ON public.memory_corrections (
    user_id,
    scope,
    subject_key,
    COALESCE(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_memory_corrections_user_active
  ON public.memory_corrections (user_id, active)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_memory_corrections_conversation_active
  ON public.memory_corrections (conversation_id, active)
  WHERE active = true AND conversation_id IS NOT NULL;

ALTER TABLE public.memory_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_corrections_select_own
  ON public.memory_corrections
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY memory_corrections_insert_own
  ON public.memory_corrections
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY memory_corrections_update_own
  ON public.memory_corrections
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.memory_corrections IS
  'User-authored durable memory corrections; applied before prompt injection and summary merge.';
