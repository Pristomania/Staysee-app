/*
  # Layer 4: Memory and Context Builder

  Adds the fields needed for StaySee AI smart context packets.

  ## Changes

  ### conversations
  - `summary` (text, nullable) — short AI-maintained summary of the conversation
  - `emotional_tone` (text, nullable) — dominant emotional tone detected
  - `summary_updated_at` (timestamptz) — when the summary was last written

  ### user_memory
  - `importance` (int, 1–5) — how important this memory item is for continuity
  - `last_used_at` (timestamptz) — when this item was last included in a context packet
  - `updated_at` (timestamptz) — when content was last changed

  ## Security
  - No new tables; all existing RLS policies remain in effect.
  - New columns inherit the table's RLS.
*/

-- conversations: add summary fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'summary'
  ) THEN
    ALTER TABLE conversations ADD COLUMN summary text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'emotional_tone'
  ) THEN
    ALTER TABLE conversations ADD COLUMN emotional_tone text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'summary_updated_at'
  ) THEN
    ALTER TABLE conversations ADD COLUMN summary_updated_at timestamptz;
  END IF;
END $$;

-- user_memory: add importance and tracking fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_memory' AND column_name = 'importance'
  ) THEN
    ALTER TABLE user_memory ADD COLUMN importance smallint NOT NULL DEFAULT 3
      CONSTRAINT importance_range CHECK (importance BETWEEN 1 AND 5);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_memory' AND column_name = 'last_used_at'
  ) THEN
    ALTER TABLE user_memory ADD COLUMN last_used_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_memory' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE user_memory ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- index to allow fast lookup of high-importance memory items
CREATE INDEX IF NOT EXISTS idx_user_memory_user_importance
  ON user_memory (user_id, importance DESC);
