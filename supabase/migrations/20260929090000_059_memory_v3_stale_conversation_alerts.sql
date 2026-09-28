-- Detects a memory pipeline that has gone silent for a specific
-- conversation/scope -- distinct from an explicit error, which the existing
-- Telegram alert path already covers. Under healthy operation the per-
-- conversation message count since the last successful run (039/041/053)
-- should never exceed the 10-message trigger by more than one message,
-- since a successful reservation resets the watermark immediately. A count
-- well past that threshold, on a conversation with recent activity, means
-- the reservation is never even being attempted -- e.g. an eligibility
-- check throwing before reaching it -- which produces no error and
-- therefore no existing alert.

CREATE TABLE public.memory_v3_stale_alerts (
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('dialogue', 'lifecycle')),
  new_message_count integer NOT NULL,
  last_alerted_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, conversation_id, scope)
);

ALTER TABLE public.memory_v3_stale_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.memory_v3_stale_alerts
FROM PUBLIC, anon, authenticated, service_role;

-- Detects newly-stale conversations and records/dedupes them in one atomic
-- statement: a genuinely new stale conversation is inserted and returned; an
-- already-flagged one is re-returned only after a 24-hour quiet period (still
-- stuck a day later), never on every call while it remains within that
-- window. Callers (staysee-chat) send exactly one Telegram alert per
-- returned row using the existing bot token/chat id, via a dedicated safe
-- sender -- this table's dedup replaces the need for the closed-enum
-- reserve_memory_v3_alert_window, which cannot key by conversation_id.
CREATE OR REPLACE FUNCTION public.flag_memory_v3_stale_conversations()
RETURNS TABLE(user_id uuid, conversation_id uuid, scope text, new_message_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_threshold CONSTANT integer := 25;
  v_activity_window CONSTANT interval := interval '3 days';
  v_quiet_period CONSTANT interval := interval '24 hours';
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT c.user_id AS c_user_id, c.id AS c_conversation_id, 'dialogue'::text AS c_scope,
      counts.new_message_count AS c_new_message_count
    FROM public.conversations c
    JOIN LATERAL (
      SELECT pg_catalog.count(*)::integer AS new_message_count
      FROM public.messages m
      WHERE m.conversation_id = c.id
        AND m.created_at > COALESCE(
          (SELECT pg_catalog.max(r.source_last_created_at) FROM public.memory_v3_dialogue_runs r
           WHERE r.user_id = c.user_id AND r.conversation_id = c.id),
          '-infinity'::timestamptz
        )
    ) counts ON counts.new_message_count >= v_threshold
    WHERE c.cross_memory_enabled = true
      AND EXISTS (
        SELECT 1 FROM public.messages m2
        WHERE m2.conversation_id = c.id AND m2.created_at > pg_catalog.now() - v_activity_window
      )
    UNION ALL
    SELECT c.user_id, c.id, 'lifecycle'::text, counts.new_message_count
    FROM public.conversations c
    JOIN LATERAL (
      SELECT pg_catalog.count(*)::integer AS new_message_count
      FROM public.messages m
      WHERE m.conversation_id = c.id
        AND m.created_at > COALESCE(
          (SELECT pg_catalog.max(r.source_last_created_at) FROM public.memory_v3_lifecycle_shadow_runs r
           WHERE r.user_id = c.user_id AND r.conversation_id = c.id),
          '-infinity'::timestamptz
        )
    ) counts ON counts.new_message_count >= v_threshold
    WHERE c.cross_memory_enabled = true
      AND EXISTS (
        SELECT 1 FROM public.messages m2
        WHERE m2.conversation_id = c.id AND m2.created_at > pg_catalog.now() - v_activity_window
      )
  ),
  upserted AS (
    INSERT INTO public.memory_v3_stale_alerts (user_id, conversation_id, scope, new_message_count, last_alerted_at)
    SELECT c_user_id, c_conversation_id, c_scope, c_new_message_count, pg_catalog.now()
    FROM candidates
    ON CONFLICT (user_id, conversation_id, scope) DO UPDATE
      SET new_message_count = EXCLUDED.new_message_count, last_alerted_at = pg_catalog.now()
      WHERE public.memory_v3_stale_alerts.last_alerted_at <= pg_catalog.now() - v_quiet_period
    RETURNING public.memory_v3_stale_alerts.user_id, public.memory_v3_stale_alerts.conversation_id,
      public.memory_v3_stale_alerts.scope, public.memory_v3_stale_alerts.new_message_count
  )
  SELECT * FROM upserted;
END;
$function$;

REVOKE ALL ON FUNCTION public.flag_memory_v3_stale_conversations()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_memory_v3_stale_conversations()
TO service_role;
