/*
  # StaySee Memory MVP (Phase 1)

  Adds rolling long-term memory field on conversations.
  Backfills from legacy `summary` column when present.
  Does not modify messages table or break existing rows.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'conversation_summary'
  ) THEN
    ALTER TABLE conversations ADD COLUMN conversation_summary text;
  END IF;
END $$;

-- Backfill from existing summary field (Layer 4 migration)
UPDATE conversations
SET conversation_summary = summary
WHERE conversation_summary IS NULL
  AND summary IS NOT NULL
  AND trim(summary) <> '';
