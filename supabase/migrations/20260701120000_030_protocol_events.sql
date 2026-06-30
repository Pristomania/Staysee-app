/*
  # protocol_events — PII-free safety/protocol audit trail

  Records hard-stops, model-emitted protocol signals (stripped before client),
  and sanitizer events. No raw user/assistant message text.
*/

CREATE TABLE IF NOT EXISTS protocol_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),

  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  conversation_id uuid,
  request_id text,

  event_type text NOT NULL,
  severity text NOT NULL,
  protocol text NOT NULL,
  action_taken text NOT NULL,
  confidence text NOT NULL,

  reason text,
  matched_pattern text,
  classifier_summary text,

  prompt_version text,
  model text,

  signal_count int NOT NULL DEFAULT 0,
  signals_stripped text[]
);

COMMENT ON TABLE protocol_events IS
  'PII-free protocol/safety events: hard-stops, stripped model signals, tag sanitizer. Service-role insert only.';

CREATE INDEX IF NOT EXISTS idx_protocol_events_created_at
  ON protocol_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_protocol_events_request_id
  ON protocol_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_protocol_events_conversation
  ON protocol_events (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_protocol_events_event_type
  ON protocol_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_protocol_events_user_id
  ON protocol_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

ALTER TABLE protocol_events ENABLE ROW LEVEL SECURITY;
