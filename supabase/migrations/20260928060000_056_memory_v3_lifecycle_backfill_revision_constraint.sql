-- Removes the original auto-generated revision=0 check. PostgreSQL truncated
-- its name differently from the explicit replacement constraint.

ALTER TABLE public.memory_v3_lifecycle_backfill_imports
  DROP CONSTRAINT IF EXISTS memory_v3_lifecycle_backfill_impo_expected_state_revision_check;
