/*
  Room deletion (user's StaySee space):
  - request_room_deletion(): wipe conversations, memory, embeddings immediately; schedule auth purge in 14 days.
  - purge_scheduled_rooms(): service-only — delete auth users whose room_purge_after has passed.
*/

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS room_deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS room_purge_after timestamptz;

COMMENT ON COLUMN public.profiles.room_deletion_requested_at IS
  'Set when user deletes their room; login blocked; content already wiped.';
COMMENT ON COLUMN public.profiles.room_purge_after IS
  'After this time the auth user row may be purged (default +14 days from request).';

CREATE OR REPLACE FUNCTION public.request_room_deletion()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  uid uuid := auth.uid();
  purge_at timestamptz := now() + interval '14 days';
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = uid AND room_deletion_requested_at IS NOT NULL
  ) THEN
    RETURN (SELECT room_purge_after FROM public.profiles WHERE id = uid);
  END IF;

  DELETE FROM public.message_embeddings WHERE user_id = uid;
  DELETE FROM public.conversations WHERE user_id = uid;
  DELETE FROM public.user_memory WHERE user_id = uid;
  DELETE FROM public.progress_entries WHERE user_id = uid;
  DELETE FROM public.ai_usage_logs WHERE user_id = uid;
  DELETE FROM public.ai_usage_log WHERE user_id = uid;
  DELETE FROM public.user_usage_tiers WHERE user_id = uid;

  UPDATE public.profiles
  SET
    room_deletion_requested_at = now(),
    room_purge_after = purge_at,
    onboarding_completed = false,
    primary_concern = '',
    cross_memory_enabled = true
  WHERE id = uid;

  RETURN purge_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_room_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_room_deletion() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_rooms_ready_for_purge(p_limit int DEFAULT 50)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p.id
  FROM public.profiles p
  WHERE p.room_deletion_requested_at IS NOT NULL
    AND p.room_purge_after IS NOT NULL
    AND p.room_purge_after <= now()
  ORDER BY p.room_purge_after ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
$$;

REVOKE ALL ON FUNCTION public.list_rooms_ready_for_purge(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_rooms_ready_for_purge(int) TO service_role;
