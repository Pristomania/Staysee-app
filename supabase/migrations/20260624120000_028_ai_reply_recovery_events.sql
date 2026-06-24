/*
  # ai_reply_recovery_events — PII-free completion route diagnostics

  Records which recovery path ran (length continue vs stop repair/retry/fail-closed).
  No raw assistant/user message text.
*/

CREATE TABLE IF NOT EXISTS ai_reply_recovery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  conversation_id uuid,
  assistant_message_id uuid,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  model text,
  prompt_version text,
  constitution_version text,
  completion_route text NOT NULL,
  auto_continue_trigger_reason text,
  stop_not_publishable_reasons text,
  segment_count int NOT NULL DEFAULT 1,
  segment_1_finish_reason text,
  segment_1_content_length int,
  segment_1_publishable boolean,
  segment_1_publishability_fail_reason text,
  segment_2_finish_reason text,
  segment_2_content_length int,
  segment_2_publishable boolean,
  segment_2_publishability_fail_reason text,
  merge_strategy text,
  merged_content_length int,
  duplicate_closure_detected boolean NOT NULL DEFAULT false,
  duplicate_closure_repaired boolean NOT NULL DEFAULT false,
  duplicate_closure_repair_reason text,
  repair_applied boolean NOT NULL DEFAULT false,
  retry_whole_used boolean NOT NULL DEFAULT false,
  fail_closed_used boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE ai_reply_recovery_events IS 'PII-free diagnostic metadata for reply recovery paths. Retention job may prune historical rows after operational review.';

CREATE INDEX IF NOT EXISTS idx_ai_reply_recovery_events_created_at
  ON ai_reply_recovery_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_reply_recovery_events_request_id
  ON ai_reply_recovery_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_reply_recovery_events_conversation
  ON ai_reply_recovery_events (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_reply_recovery_events_completion_route
  ON ai_reply_recovery_events (completion_route, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_reply_recovery_events_duplicate_closure
  ON ai_reply_recovery_events (duplicate_closure_detected, created_at DESC)
  WHERE duplicate_closure_detected = true;

CREATE INDEX IF NOT EXISTS idx_ai_reply_recovery_events_auto_continue_trigger
  ON ai_reply_recovery_events (auto_continue_trigger_reason, created_at DESC)
  WHERE auto_continue_trigger_reason IS NOT NULL;

ALTER TABLE ai_reply_recovery_events ENABLE ROW LEVEL SECURITY;

-- No user-facing policies — service_role inserts only.
