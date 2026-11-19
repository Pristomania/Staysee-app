-- 094: the confirmation "I am 18 or older" is recorded like the other agreements.
--
-- At registration the form refuses to go on without the tick "Подтверждаю, что мне исполнилось 18 лет", but until now
-- nothing was kept: user_consents had only the offer, the data processing and the pictures. Now the tick travels in the
-- metadata of the new account with the others, and the same trigger writes a row 'age_18': the version of the sentence,
-- the SHA-256 of the exact sentence the person ticked, and the server's time.
--
-- Nothing is rewritten or deleted: rows already there stay as they are, accounts made before this have no 'age_18'
-- row (the tick was not recorded then, and it cannot be claimed afterwards). A problem with the record still never
-- stops anybody from registering.

ALTER TABLE public.user_consents DROP CONSTRAINT IF EXISTS user_consents_consent_type_check;
ALTER TABLE public.user_consents
  ADD CONSTRAINT user_consents_consent_type_check
  CHECK (consent_type IN ('terms', 'pd_processing', 'images', 'age_18'));

-- Registration: the agreements in the new account's metadata become rows (server time). As in 084, plus 'age_18'.
CREATE OR REPLACE FUNCTION public.record_signup_consents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_consents jsonb;
  v_type text;
  v_item jsonb;
  v_user_agent text;
BEGIN
  BEGIN
    v_consents := NEW.raw_user_meta_data -> 'consents';
    IF v_consents IS NULL OR pg_catalog.jsonb_typeof(v_consents) <> 'object' THEN
      RETURN NEW;
    END IF;
    IF pg_catalog.jsonb_typeof(v_consents -> 'user_agent') = 'string' THEN
      v_user_agent := pg_catalog.left(v_consents ->> 'user_agent', 300);
    END IF;
    FOREACH v_type IN ARRAY ARRAY['terms', 'pd_processing', 'age_18'] LOOP
      v_item := v_consents -> v_type;
      IF pg_catalog.jsonb_typeof(v_item) = 'object'
         AND pg_catalog.jsonb_typeof(v_item -> 'version') = 'string'
         AND pg_catalog.jsonb_typeof(v_item -> 'sha256') = 'string'
         AND pg_catalog.char_length(v_item ->> 'version') BETWEEN 1 AND 40
         AND (v_item ->> 'sha256') ~ '^[0-9a-f]{64}$' THEN
        INSERT INTO public.user_consents (user_id, consent_type, document_version, document_sha256, user_agent)
        VALUES (NEW.id, v_type, v_item ->> 'version', v_item ->> 'sha256', NULLIF(v_user_agent, ''))
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- A problem with the record must never stop a person from registering.
    NULL;
  END;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_signup_consents() FROM PUBLIC, anon, authenticated;

-- Later agreements by a signed-in person (a new version of a document, the pictures, a repeated confirmation).
CREATE OR REPLACE FUNCTION public.record_user_consent(
  p_consent_type text,
  p_version text,
  p_sha256 text,
  p_user_agent text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_ip text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_consent_type IS NULL OR p_consent_type NOT IN ('terms', 'pd_processing', 'images', 'age_18') THEN
    RAISE EXCEPTION 'invalid consent type';
  END IF;
  IF p_version IS NULL OR pg_catalog.char_length(p_version) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'invalid document version';
  END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid document hash';
  END IF;
  -- Best effort: the address the request came from, when the gateway passes it on.
  BEGIN
    v_ip := pg_catalog.left(
      pg_catalog.btrim(pg_catalog.split_part(
        COALESCE(pg_catalog.current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''), ',', 1)),
      64);
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;
  INSERT INTO public.user_consents (user_id, consent_type, document_version, document_sha256, user_agent, ip_address)
  VALUES (v_user, p_consent_type, p_version, p_sha256, NULLIF(pg_catalog.left(p_user_agent, 300), ''), NULLIF(v_ip, ''))
  ON CONFLICT DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_user_consent(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_user_consent(text, text, text, text) TO authenticated;
