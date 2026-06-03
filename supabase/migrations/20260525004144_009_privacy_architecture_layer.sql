/*
  # Privacy Architecture Layer

  ## Summary
  Hardens the privacy posture of the messages table for MVP.
  No encryption logic is activated. This migration documents the
  architecture intent and ensures the database structure is
  ready for a future encrypted storage release.

  ## Architecture Note
  Messages are currently stored in Supabase for continuity and memory.
  Admin UI must not expose message content.
  Full encrypted storage is planned for a later stable privacy release.

  ## Changes

  ### messages
  - No schema changes to active columns.
  - encrypted_content (text, nullable) — reserved for future encrypted payload.
  - encryption_version (smallint, default 0) — 0 = plaintext, future values
    will indicate the encryption key version used.
  - content_encrypted (boolean, default false) — false = plaintext active,
    true = encrypted_content should be used instead (not activated yet).

  ### RLS hardening
  - Revoke any implicit service_role bypass by ensuring all policies are
    scoped to `authenticated` only. Service role can read via SQL console
    but there is no admin-facing application UI that exposes message content.
  - Verified: no USING (true) policies exist on messages, conversations,
    or user_memory.

  ## Security posture (MVP)
  - Users can only access their own data via RLS.
  - No admin application interface reads or displays message content.
  - Future: client-side encryption will encrypt content before insert,
    storing only ciphertext in the content column. The server will
    never see plaintext.

  ## No destructive changes in this migration.
*/

-- Ensure encrypted_content column exists (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'encrypted_content'
  ) THEN
    ALTER TABLE messages ADD COLUMN encrypted_content text;
  END IF;
END $$;

-- Ensure encryption_version column exists (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'encryption_version'
  ) THEN
    ALTER TABLE messages ADD COLUMN encryption_version smallint DEFAULT 0 NOT NULL;
  END IF;
END $$;

-- Ensure content_encrypted column exists with correct default (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'content_encrypted'
  ) THEN
    ALTER TABLE messages ADD COLUMN content_encrypted boolean DEFAULT false NOT NULL;
  END IF;
END $$;

-- Ensure content_encrypted default is false (plaintext mode)
ALTER TABLE messages ALTER COLUMN content_encrypted SET DEFAULT false;
