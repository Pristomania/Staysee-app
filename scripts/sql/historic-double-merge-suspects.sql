-- Historic suspected double-merge / duplicate-closure replies
-- Read-only. Run in Supabase SQL editor with service_role context.
-- Does not return message content — counts and ids only.

-- 1) Rows where auto-continue ran but was_truncated=false (stop-triggered era)
SELECT
  count(*) AS suspected_stop_auto_continue_count
FROM ai_usage_logs
WHERE auto_continue_used = true
  AND finalize_used = false
  AND coalesce(was_truncated, false) = false
  AND generation_status = 'success';

-- 2) By model / prompt_version / day
SELECT
  date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
  model,
  prompt_version,
  count(*) AS cnt
FROM ai_usage_logs
WHERE auto_continue_used = true
  AND finalize_used = false
  AND coalesce(was_truncated, false) = false
  AND generation_status = 'success'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, cnt DESC;

-- 3) Join to messages: long replies with multiple closure markers (sample ids only)
WITH flagged AS (
  SELECT
    m.id AS message_id,
    m.conversation_id,
    m.created_at,
    length(m.content) AS content_length,
    (length(m.content) - length(replace(m.content, 'Спи', ''))) / length('Спи') AS spi_count,
    (length(m.content) - length(replace(m.content, 'Ты молодец', ''))) / length('Ты молодец') AS molodec_count
  FROM messages m
  WHERE m.sender = 'ai'
    AND m.role IN ('assistant', 'ai')
    AND length(m.content) > 1500
)
SELECT
  message_id,
  conversation_id,
  created_at,
  content_length,
  spi_count,
  molodec_count
FROM flagged
WHERE spi_count >= 2 OR molodec_count >= 1
ORDER BY created_at DESC
LIMIT 50;

-- 4) Known incident correlation
SELECT *
FROM ai_usage_logs
WHERE request_id = '5545eb86-7aef-427c-9c06-dfb723ceed31';

-- After migration 028 deployed:
-- SELECT completion_route, count(*) FROM ai_reply_recovery_events GROUP BY 1 ORDER BY 2 DESC;
