/*
  Cross-memory: allow richer memory_type values (communication, life_context).
*/

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_memory_memory_type_check'
      AND conrelid = 'public.user_memory'::regclass
  ) THEN
    ALTER TABLE user_memory DROP CONSTRAINT user_memory_memory_type_check;
  END IF;
END $$;

ALTER TABLE user_memory
  ADD CONSTRAINT user_memory_memory_type_check
  CHECK (memory_type IN (
    'preference',
    'insight',
    'theme',
    'emotion',
    'communication',
    'life_context'
  ));

COMMENT ON TABLE user_memory IS
  'Cross-conversation life context: full sentences (style, themes, relationships), not chat bullet fragments.';
