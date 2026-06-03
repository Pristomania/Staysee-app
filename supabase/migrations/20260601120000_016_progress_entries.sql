-- Progress diary: user's own notes + saved weekly snapshots (not raw chat export).

CREATE TABLE IF NOT EXISTS public.progress_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT (CURRENT_DATE),
  entry_type text NOT NULL DEFAULT 'note'
    CHECK (entry_type IN ('note', 'shift', 'step', 'weekly')),
  content text NOT NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_progress_entries_user_date
  ON public.progress_entries (user_id, entry_date DESC);

ALTER TABLE public.progress_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own progress entries"
  ON public.progress_entries
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
