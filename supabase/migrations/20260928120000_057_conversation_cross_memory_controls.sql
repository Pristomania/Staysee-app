-- Cross-memory scope controls.
-- The profile value is the bulk/default setting. Each conversation stores the
-- effective value used by live reads and writes.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS cross_memory_enabled boolean;

UPDATE public.conversations AS c
SET cross_memory_enabled = COALESCE(p.cross_memory_enabled, true)
FROM public.profiles AS p
WHERE p.id = c.user_id
  AND c.cross_memory_enabled IS NULL;

UPDATE public.conversations
SET cross_memory_enabled = true
WHERE cross_memory_enabled IS NULL;

ALTER TABLE public.conversations
  ALTER COLUMN cross_memory_enabled SET DEFAULT true,
  ALTER COLUMN cross_memory_enabled SET NOT NULL;

COMMENT ON COLUMN public.conversations.cross_memory_enabled IS
  'Effective cross-memory setting for this conversation. Dialogue memory is independent.';

CREATE OR REPLACE FUNCTION public.inherit_conversation_cross_memory_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  SELECT COALESCE(p.cross_memory_enabled, true)
  INTO NEW.cross_memory_enabled
  FROM public.profiles AS p
  WHERE p.id = NEW.user_id;

  NEW.cross_memory_enabled := COALESCE(NEW.cross_memory_enabled, true);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.inherit_conversation_cross_memory_enabled()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inherit_conversation_cross_memory_enabled
  ON public.conversations;

CREATE TRIGGER inherit_conversation_cross_memory_enabled
BEFORE INSERT ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.inherit_conversation_cross_memory_enabled();

CREATE OR REPLACE FUNCTION public.set_cross_memory_enabled_for_all(
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_rows integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication_required';
  END IF;

  IF p_enabled IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'enabled_required';
  END IF;

  UPDATE public.profiles
  SET cross_memory_enabled = p_enabled
  WHERE id = v_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile_not_found';
  END IF;

  UPDATE public.conversations
  SET cross_memory_enabled = p_enabled
  WHERE user_id = v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_conversation_cross_memory_enabled(
  p_conversation_id uuid,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_rows integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication_required';
  END IF;

  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'conversation_required';
  END IF;

  IF p_enabled IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'enabled_required';
  END IF;

  UPDATE public.conversations
  SET cross_memory_enabled = p_enabled
  WHERE id = p_conversation_id
    AND user_id = v_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'conversation_not_found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_cross_memory_enabled_for_all(boolean)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_conversation_cross_memory_enabled(uuid, boolean)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.set_cross_memory_enabled_for_all(boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_conversation_cross_memory_enabled(uuid, boolean)
  TO authenticated;
