/*
  # messages — client turn id for idempotent user/ai pairs

  One client_message_id (UUID) per submit; shared by user + ai rows.
  Partial UNIQUE on (conversation_id, client_message_id, sender) allows
  at most one user row and one ai row per turn.
*/

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id text;

COMMENT ON COLUMN messages.client_message_id IS
  'Client turn UUID; same value on user and ai rows for one submit/retry';

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conv_client_msg_sender
  ON messages (conversation_id, client_message_id, sender)
  WHERE client_message_id IS NOT NULL;
