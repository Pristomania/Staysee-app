-- Per-conversation reflection entries (no cross-room bleed in queries).

CREATE INDEX IF NOT EXISTS idx_progress_entries_conversation_date
  ON public.progress_entries (conversation_id, entry_date DESC)
  WHERE conversation_id IS NOT NULL;
