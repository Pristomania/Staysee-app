-- A log of how often messages are long and how often people hit the 10,000-character limit, to answer over
-- the months whether the limit (and the context) should grow. Only the length and the time are kept, never
-- the text. Like message_model_summaries, the table is for the service role only.
--
--  * 'long_message': a message of more than 4,000 characters arrived (written by the chat function).
--  * 'over_limit':   the input box reported that a person typed or pasted more than 10,000 characters
--                    (record_over_limit_hit, called by the signed-in person's own app). The box does not
--                    send such a text, so this is the only trace of it.

CREATE TABLE public.message_length_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('long_message', 'over_limit')),
  char_count integer NOT NULL CHECK (char_count BETWEEN 1 AND 10000000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX message_length_events_created_at_idx ON public.message_length_events (created_at);
CREATE INDEX message_length_events_user_kind_idx ON public.message_length_events (user_id, kind, created_at DESC);

ALTER TABLE public.message_length_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.message_length_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.message_length_events TO service_role;

-- Called by a signed-in person's own app when the input box goes over the maximum. At most one report per
-- person per ten seconds, so a paste loop cannot flood the table; a count that is not over the maximum is
-- refused.
CREATE FUNCTION public.record_over_limit_hit(p_char_count integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_char_count IS NULL OR p_char_count <= 10000 OR p_char_count > 10000000 THEN
    RAISE EXCEPTION 'invalid character count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.message_length_events
    WHERE user_id = v_user AND kind = 'over_limit'
      AND created_at > pg_catalog.now() - pg_catalog.make_interval(secs => 10)
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.message_length_events (user_id, kind, char_count)
  VALUES (v_user, 'over_limit', p_char_count);
END;
$$;

REVOKE ALL ON FUNCTION public.record_over_limit_hit(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_over_limit_hit(integer) TO authenticated;

-- The report: counts only, no account, conversation or text. Service role only.
CREATE FUNCTION public.long_message_stats(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH msgs AS (
    SELECT pg_catalog.char_length(m.content) AS n
    FROM public.messages m
    WHERE m.sender = 'user'
      AND m.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
  ),
  ev AS (
    SELECT e.kind, e.user_id, e.char_count
    FROM public.message_length_events e
    WHERE e.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
  )
  SELECT pg_catalog.jsonb_build_object(
    'days', p_days,
    'user_messages', (SELECT pg_catalog.count(*) FROM msgs),
    'over_1000', (SELECT pg_catalog.count(*) FROM msgs WHERE n > 1000),
    'over_4000', (SELECT pg_catalog.count(*) FROM msgs WHERE n > 4000),
    'over_8000', (SELECT pg_catalog.count(*) FROM msgs WHERE n > 8000),
    'max_length', (SELECT COALESCE(pg_catalog.max(n), 0) FROM msgs),
    'long_message_events', (SELECT pg_catalog.count(*) FROM ev WHERE kind = 'long_message'),
    'long_message_users', (SELECT pg_catalog.count(DISTINCT user_id) FROM ev WHERE kind = 'long_message'),
    'over_limit_events', (SELECT pg_catalog.count(*) FROM ev WHERE kind = 'over_limit'),
    'over_limit_users', (SELECT pg_catalog.count(DISTINCT user_id) FROM ev WHERE kind = 'over_limit'),
    'over_limit_max', (SELECT COALESCE(pg_catalog.max(char_count), 0) FROM ev WHERE kind = 'over_limit'),
    'summaries_made', (
      SELECT pg_catalog.count(*) FROM public.message_model_summaries s
      WHERE s.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.long_message_stats(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.long_message_stats(integer) TO service_role;
