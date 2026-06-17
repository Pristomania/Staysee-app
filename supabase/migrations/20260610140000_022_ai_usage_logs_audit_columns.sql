/*
  # ai_usage_logs — generation audit columns (no PII)

  Extends per-request usage rows with request correlation, completion metadata,
  prompt layer versions, and safe error/status codes.
*/

ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS finish_reason text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS latency_ms int;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS was_truncated boolean NOT NULL DEFAULT false;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS auto_continue_used boolean NOT NULL DEFAULT false;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS finalize_used boolean NOT NULL DEFAULT false;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS constitution_version text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS cognitive_signature_version text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS memory_version text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS generation_status text;

COMMENT ON COLUMN ai_usage_logs.request_id IS 'Client idempotency key or server dedup key; no message content';
COMMENT ON COLUMN ai_usage_logs.finish_reason IS 'OpenRouter finish_reason from final model segment';
COMMENT ON COLUMN ai_usage_logs.latency_ms IS 'Wall-clock ms for staysee-chat handler through reply assembly';
COMMENT ON COLUMN ai_usage_logs.was_truncated IS 'True when any model segment ended with finish_reason=length';
COMMENT ON COLUMN ai_usage_logs.auto_continue_used IS 'True when auto-continue merge path ran';
COMMENT ON COLUMN ai_usage_logs.finalize_used IS 'True when finalize pass ran';
COMMENT ON COLUMN ai_usage_logs.prompt_version IS 'Surgery1 stack layer id (no prompt text)';
COMMENT ON COLUMN ai_usage_logs.constitution_version IS 'Constitution block version label';
COMMENT ON COLUMN ai_usage_logs.cognitive_signature_version IS 'Cognitive signature block version label';
COMMENT ON COLUMN ai_usage_logs.memory_version IS 'Structured memory injection schema version';
COMMENT ON COLUMN ai_usage_logs.error_code IS 'Short machine code; no user/assistant text';
COMMENT ON COLUMN ai_usage_logs.error_message IS 'Short safe error summary; no PII';
COMMENT ON COLUMN ai_usage_logs.generation_status IS 'success | incomplete | error | background';

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_request_id
  ON ai_usage_logs (request_id)
  WHERE request_id IS NOT NULL;
