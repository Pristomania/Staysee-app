-- Every row in user_memory was written with importance stuck at the
-- column's default (3) until today's fix (same commit that added
-- `importance: c.importance` to the three .insert() call sites in
-- userLifeMemory.ts / consolidateUserLifeMemory.ts) -- the computed,
-- type-based score (TYPE_IMPORTANCE in userLifeMemory.ts: communication/
-- preference=5, life_context/insight=4, theme/emotion=3) was always
-- discarded before that. That fix only affects rows written from now on;
-- every row already in the table is still sitting at 3 regardless of its
-- real type. One-time backfill, using the exact same mapping the
-- application code uses, so the sort order migration 070 enabled actually
-- reflects something real for existing users immediately instead of
-- only for new facts going forward.
--
-- Idempotent: re-running this after it has already run is a no-op (every
-- row already matches its CASE branch), and any memory_type this mapping
-- doesn't recognize is left untouched rather than guessed at.

UPDATE public.user_memory
SET importance = CASE memory_type
  WHEN 'communication' THEN 5
  WHEN 'preference' THEN 5
  WHEN 'life_context' THEN 4
  WHEN 'insight' THEN 4
  WHEN 'theme' THEN 3
  WHEN 'emotion' THEN 3
  ELSE importance
END
WHERE memory_type IN ('communication', 'preference', 'life_context', 'insight', 'theme', 'emotion');
