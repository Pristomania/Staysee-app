/*
  Allow users to edit their own global memory rows (content / type).
*/

DO $$
BEGIN
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
