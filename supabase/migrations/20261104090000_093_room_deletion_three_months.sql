-- 093: a deleted room keeps its sign-in record for 3 months, not 14 days.
--
-- Why: the free plan gives 50 messages that come back 3 months after the last answered message. If the sign-in record
-- were erased after 14 days, deleting the room and signing up again with the same address would hand out the 50 free
-- messages anew, months early. Three months is the same span: the address opens again when the messages would have.
--
-- The content (conversations, notes, memory), the plan and the usage log still go at once, exactly as in 092; only the
-- date changes. The date is a whole UTC day, the day AFTER the three months: the daily clean-up runs at 03:23 UTC, so
-- on that day it has already run when the person is told "the address is free from <that day>".
--
-- Rooms already scheduled keep the date they were given.

CREATE OR REPLACE FUNCTION public.request_room_deletion()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_purge_at timestamptz := ((now() AT TIME ZONE 'utc')::date + interval '3 months' + interval '1 day') AT TIME ZONE 'utc';
  v_existing timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- Asked before and fully recorded: the same date again, nothing is deleted twice. A half-written request (a date
  -- missing) is done again, so that the clean-up always has a date to stand on.
  SELECT room_purge_after INTO v_existing
  FROM public.profiles
  WHERE id = v_uid AND room_deletion_requested_at IS NOT NULL AND room_purge_after IS NOT NULL;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  PERFORM public._wipe_account_content(v_uid);
  DELETE FROM public.ai_usage_logs WHERE user_id = v_uid;
  DELETE FROM public.user_usage_tiers WHERE user_id = v_uid;

  -- The profile may be missing (an account made before profiles were filled in): make it, so that the sign-in block and
  -- the 3 months have something to stand on.
  INSERT INTO public.profiles (id, room_deletion_requested_at, room_purge_after, cross_memory_enabled)
  VALUES (v_uid, now(), v_purge_at, true)
  ON CONFLICT (id) DO UPDATE
    SET room_deletion_requested_at = now(),
        room_purge_after = v_purge_at,
        cross_memory_enabled = true;

  RETURN v_purge_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_room_deletion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_room_deletion() FROM anon;
GRANT EXECUTE ON FUNCTION public.request_room_deletion() TO authenticated;
