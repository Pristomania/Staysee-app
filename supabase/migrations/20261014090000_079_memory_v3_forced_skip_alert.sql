-- Delta windowing (2026-10-13) added a "give up after 3 consecutive
-- failures" safety valve: after enough failed runs in a row, a conversation's
-- memory pipeline deliberately skips the one message it keeps failing on and
-- moves forward, rather than staying stuck on it forever. That skip is a
-- genuinely consequential event -- a message's content is permanently
-- excluded from memory -- and Настя asked to be alerted before (as part of)
-- that decision, the same way she already is for an ordinary run failure.
--
-- Extends the existing alert-window allowlist with one new key,
-- 'write:forced_skip', reusing the same Telegram alert path, the same
-- one-per-UTC-hour dedup, and the same 14-day retention -- no new table,
-- no new RPC. CREATE OR REPLACE on the function; DROP+ADD on the CHECK
-- constraint, since Postgres has no ALTER CHECK. Existing rows are
-- unaffected: the new constraint only allows one more value, it disallows
-- nothing the old one allowed.

ALTER TABLE public.memory_v3_alert_windows
  DROP CONSTRAINT memory_v3_alert_windows_key_check;

ALTER TABLE public.memory_v3_alert_windows
  ADD CONSTRAINT memory_v3_alert_windows_key_check CHECK (alert_key IN (
    'read:load_failed',
    'read:invalid_shape',
    'read:too_large',
    'write:invalid_source',
    'write:state_too_large',
    'write:extractor_transport_failed',
    'write:extractor_parse_invalid',
    'write:extractor_shape_invalid',
    'write:extractor_contract_invalid',
    'write:reconciler_request_too_large',
    'write:reconciler_transport_failed',
    'write:reconciler_parse_invalid',
    'write:reconciler_shape_invalid',
    'write:reconciler_contract_invalid',
    'write:state_conflict',
    'write:state_write_failed',
    'write:reservation_failed',
    'write:unknown_failure',
    'write:forced_skip'
  ));

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_alert_window(
  p_alert_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_inserted boolean;
  v_window_start timestamptz;
BEGIN
  IF p_alert_key IS NULL OR p_alert_key NOT IN (
    'read:load_failed',
    'read:invalid_shape',
    'read:too_large',
    'write:invalid_source',
    'write:state_too_large',
    'write:extractor_transport_failed',
    'write:extractor_parse_invalid',
    'write:extractor_shape_invalid',
    'write:extractor_contract_invalid',
    'write:reconciler_request_too_large',
    'write:reconciler_transport_failed',
    'write:reconciler_parse_invalid',
    'write:reconciler_shape_invalid',
    'write:reconciler_contract_invalid',
    'write:state_conflict',
    'write:state_write_failed',
    'write:reservation_failed',
    'write:unknown_failure',
    'write:forced_skip'
  ) THEN
    RAISE EXCEPTION 'invalid memory v3 alert key';
  END IF;

  v_window_start :=
    pg_catalog.date_trunc('hour', pg_catalog.now() AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC';

  DELETE FROM public.memory_v3_alert_windows
  WHERE window_start < pg_catalog.now() - INTERVAL '14 days';

  INSERT INTO public.memory_v3_alert_windows(alert_key, window_start)
  VALUES (p_alert_key, v_window_start)
  ON CONFLICT (alert_key, window_start) DO NOTHING
  RETURNING true INTO v_inserted;

  RETURN COALESCE(v_inserted, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_alert_window(text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_alert_window(text)
TO service_role;
