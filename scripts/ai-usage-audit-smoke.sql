-- AI usage audit — manual smoke check (Supabase SQL Editor, service_role context)
--
-- Prerequisites:
--   1. Migration 022 applied (audit columns exist)
--   2. staysee-chat deployed with audit logging
--   3. One authenticated chat message sent with userId + requestId in body
--
-- Replace :request_id with the client requestId from the test message.

-- 1) Verify audit columns exist
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'ai_usage_logs'
  AND column_name IN (
    'request_id', 'finish_reason', 'latency_ms', 'was_truncated',
    'auto_continue_used', 'finalize_used', 'prompt_version',
    'constitution_version', 'cognitive_signature_version', 'memory_version',
    'error_code', 'error_message', 'generation_status'
  )
ORDER BY column_name;

-- 2) Latest chat rows with audit fields (last 5)
SELECT
  created_at,
  request_id,
  model,
  generation_status,
  finish_reason,
  latency_ms,
  was_truncated,
  auto_continue_used,
  finalize_used,
  prompt_version,
  constitution_version,
  cognitive_signature_version,
  memory_version,
  error_code,
  error_message,
  prompt_tokens,
  completion_tokens,
  cost
FROM ai_usage_logs
ORDER BY created_at DESC
LIMIT 5;

-- 3) Lookup by request_id after test message
-- SELECT *
-- FROM ai_usage_logs
-- WHERE request_id = 'YOUR-REQUEST-ID-HERE'
-- ORDER BY created_at DESC
-- LIMIT 1;

-- 4) Background jobs still insert (audit fields null / false defaults)
SELECT
  created_at,
  model,
  generation_status,
  request_id,
  prompt_version,
  memory_tokens,
  summary_tokens
FROM ai_usage_logs
WHERE generation_status IS NULL
  AND prompt_version IS NULL
ORDER BY created_at DESC
LIMIT 5;
