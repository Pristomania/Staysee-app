-- Records of what people agreed to, so that it can be shown which text a person accepted and when.
--
-- Three kinds of agreement:
--   terms          the public offer (accepted at registration)
--   pd_processing  the consent to the processing of personal data, including data about their state (registration)
--   images         the consent to the processing of the pictures they attach (given before the first picture)
--
-- A row says which version of the document the person saw (document_version) and the SHA-256 of that exact text
-- (document_sha256), and the server's time. At registration the two agreements travel in the metadata of the new
-- account and a trigger writes the rows, so it works with and without email confirmation, and a malformed
-- metadata can never stop anybody from registering. Later agreements are written by record_user_consent().
-- A person can read their own rows and nothing else; nobody but the database writes them.

CREATE TABLE public.user_consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_type text NOT NULL CHECK (consent_type IN ('terms', 'pd_processing', 'images')),
  document_version text NOT NULL CHECK (pg_catalog.char_length(document_version) BETWEEN 1 AND 40),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  consented_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  user_agent text CHECK (user_agent IS NULL OR pg_catalog.char_length(user_agent) <= 300),
  ip_address text CHECK (ip_address IS NULL OR pg_catalog.char_length(ip_address) <= 64)
);

-- One row per person, kind and version of the document.
CREATE UNIQUE INDEX user_consents_one_per_version
  ON public.user_consents (user_id, consent_type, document_version);

ALTER TABLE public.user_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_consents_select_own ON public.user_consents
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.user_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_consents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_consents TO service_role;

-- Registration: the agreements in the new account's metadata become rows (server time).
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
    FOREACH v_type IN ARRAY ARRAY['terms', 'pd_processing'] LOOP
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

DROP TRIGGER IF EXISTS on_auth_user_created_consents ON auth.users;
CREATE TRIGGER on_auth_user_created_consents
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.record_signup_consents();

-- Later agreements (the pictures, a new version of a document) by a signed-in person.
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
  IF p_consent_type IS NULL OR p_consent_type NOT IN ('terms', 'pd_processing', 'images') THEN
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
