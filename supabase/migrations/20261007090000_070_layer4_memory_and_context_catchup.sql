-- Migration 005 (20260524231158, "Layer 4: Memory and Context Builder")
-- was already idempotent (every ALTER/CREATE INDEX guarded by an
-- IF NOT EXISTS check) but never actually reached production for 4 of
-- its 6 fields: conversations.summary and conversations.summary_updated_at
-- are live, but conversations.emotional_tone, user_memory.importance,
-- user_memory.last_used_at, user_memory.updated_at, and the
-- idx_user_memory_user_importance index are not -- confirmed by querying
-- information_schema.columns directly against production. This matches
-- the gap scripts/lib/schema-drift.ts's KNOWN_MEMORY_TARGETS has tracked
-- (as a check, never auto-applied) since that tool was built.
--
-- The silent fallback in context.ts's fetchConversationMeta (for
-- emotional_tone) and fetchMemoryItems (for importance/last_used_at/
-- updated_at) means none of this has ever been a hard outage -- the app
-- has run this whole time by discarding each failed rich query and
-- re-querying a smaller column set, logging a console.warn each time.
-- The real cost: fetchMemoryItems has silently ordered memory items by
-- created_at (most recent) instead of by importance (most important) on
-- every single request since this table existed, because the "order by
-- importance" query has never once succeeded against production.
--
-- Re-running migration 005's own text verbatim (for just the still-missing
-- pieces) rather than writing new ALTER statements: it was already written
-- to be safely re-run against a partially-applied state.

-- conversations: add emotional_tone (summary and summary_updated_at are
-- already live; their own IF NOT EXISTS guards make including them here
-- harmless too, but they're omitted since they already exist).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'emotional_tone'
  ) THEN
    ALTER TABLE conversations ADD COLUMN emotional_tone text;
  END IF;
END $$;

-- user_memory: add importance, last_used_at, updated_at
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
