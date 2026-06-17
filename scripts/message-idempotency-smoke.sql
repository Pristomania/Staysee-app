-- Message idempotency — manual smoke (Supabase SQL Editor)
--
-- After a successful chat turn with PR1 deployed:
-- expect at most 2 rows per (conversation_id, client_message_id) — user + ai.

SELECT conversation_id, client_message_id, count(*) AS row_count
FROM messages
WHERE client_message_id IS NOT NULL
GROUP BY conversation_id, client_message_id
HAVING count(*) > 2;

-- Expected: 0 rows

-- Per-turn pair check (replace UUIDs):
-- SELECT sender, client_message_id, left(content, 40), created_at
-- FROM messages
-- WHERE conversation_id = 'YOUR-CONV-UUID'
--   AND client_message_id = 'YOUR-TURN-UUID'
-- ORDER BY created_at;
