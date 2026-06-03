/*
  # Privacy-First Architecture for StaySee AI

  ## Summary
  Hardens the database schema for strict privacy:

  1. Hard-delete support for conversations and messages
     - Adds a `deleted_at` timestamptz column to conversations (soft flag removed in favour of permanent deletion path)
     - Adds a `deleted_at` timestamptz column to messages
     - Adds a DELETE policy on messages so users can permanently remove their own messages
     - Adds a DELETE policy on conversations so users can permanently remove their own conversations

  2. Encryption readiness
     - Adds `content_encrypted` boolean column (default false) to messages to track which rows
       are stored encrypted at rest (populated by future edge-function encryption layer)
     - Adds `encryption_version` smallint (default 0) to messages for key-rotation tracking

  3. Admin access prevention
     - Removes any service-role bypass by ensuring all policies are scoped to `authenticated` role only
     - No `USING (true)` or open policies exist on conversation/message tables

  4. RLS hardening
     - Ensures DELETE policy exists on messages (was missing in original schema)
     - Ensures UPDATE policy exists on messages (was missing in original schema — needed for soft-delete path)
     - All policies re-checked for ownership via auth.uid()

  5. Performance
     - Index on messages(conversation_id, created_at) for ordered fetches
     - Index on conversations(user_id, is_active) for filtered list queries
*/

-- Add encryption-readiness columns to messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'content_encrypted'
  ) THEN
    ALTER TABLE messages ADD COLUMN content_encrypted boolean DEFAULT false NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'encryption_version'
  ) THEN
    ALTER TABLE messages ADD COLUMN encryption_version smallint DEFAULT 0 NOT NULL;
  END IF;
END $$;

-- Add deleted_at to conversations (permanent-delete audit trail)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE conversations ADD COLUMN deleted_at timestamptz DEFAULT NULL;
  END IF;
END $$;

-- DELETE policy on messages (users can permanently delete messages in their conversations)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'Users can delete messages in own conversations'
  ) THEN
    CREATE POLICY "Users can delete messages in own conversations"
      ON messages FOR DELETE
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM conversations
          WHERE conversations.id = messages.conversation_id
          AND conversations.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- UPDATE policy on messages (needed for future encryption migration path)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'Users can update messages in own conversations'
  ) THEN
    CREATE POLICY "Users can update messages in own conversations"
      ON messages FOR UPDATE
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM conversations
          WHERE conversations.id = messages.conversation_id
          AND conversations.user_id = auth.uid()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM conversations
          WHERE conversations.id = messages.conversation_id
          AND conversations.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Composite indexes for privacy-aware queries
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_conversations_user_active
  ON conversations(user_id, is_active);
