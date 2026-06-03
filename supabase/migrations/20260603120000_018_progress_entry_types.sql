-- Insight / tension note types for «Записки себе».

ALTER TABLE public.progress_entries
  DROP CONSTRAINT IF EXISTS progress_entries_entry_type_check;

ALTER TABLE public.progress_entries
  ADD CONSTRAINT progress_entries_entry_type_check
  CHECK (entry_type IN ('note', 'shift', 'step', 'weekly', 'insight', 'tension'));
