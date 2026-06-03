/*
  Ensure user_memory exists on prod DBs that predate migration 002 tracking.
  Adds UPDATE policy for in-app memory editing.
*/

CREATE TABLE IF NOT EXISTS user_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  memory_type text NOT NULL CHECK (memory_type IN ('preference', 'insight', 'theme', 'emotion')),
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_memory' AND policyname = 'Users can view own memory'
  ) THEN
    CREATE POLICY "Users can view own memory"
      ON user_memory FOR SELECT
      TO authenticated
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_memory' AND policyname = 'Users can create own memory'
  ) THEN
    CREATE POLICY "Users can create own memory"
      ON user_memory FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_memory' AND policyname = 'Users can delete own memory'
  ) THEN
    CREATE POLICY "Users can delete own memory"
      ON user_memory FOR DELETE
      TO authenticated
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_memory' AND policyname = 'Users can update own memory'
  ) THEN
    CREATE POLICY "Users can update own memory"
      ON user_memory FOR UPDATE
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);
