/*
  # Restore messages.content column

  ## Problem
  A previous migration replaced the plain `content` column with `encrypted_content`
  and set `content_encrypted DEFAULT true`. The encryption layer was never shipped,
  so every client insert of `{ sender, content }` was silently dropped — the column
  didn't exist.

  ## Changes

  ### messages
  - Add `content` (text, NOT NULL, DEFAULT '') — the plain-text message body
    used by all current client and edge-function code.
  - Change `content_encrypted` default to `false` (encryption is not active).
  - Keep `encrypted_content` and `encryption_version` columns in place for future
    use; they are nullable / zero-defaulted and cause no harm.

  ## Security
  - No RLS changes. Existing policies on messages remain in effect.
  - content column inherits table RLS.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'content'
  ) THEN
    ALTER TABLE messages ADD COLUMN content text NOT NULL DEFAULT '';
  END IF;
END $$;

-- Fix the wrong default on content_encrypted
ALTER TABLE messages ALTER COLUMN content_encrypted SET DEFAULT false;
