-- 091_delete_my_memory_corrections
-- A person can delete their own memory corrections ("lives with X", "relationship status"...).
--
-- memory_corrections has row security with read, add and change rights for the owner but no right to delete, so the
-- "delete all memory" buttons could not remove these rows: the screen said the memory was gone while the corrections
-- still shaped later answers. The delete goes through this function, which can only touch the caller's own rows
-- (auth.uid()), so nobody can delete anybody else's.

CREATE OR REPLACE FUNCTION public.delete_my_memory_corrections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'not_authenticated';
  END IF;

  DELETE FROM public.memory_corrections WHERE user_id = v_uid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_memory_corrections() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_my_memory_corrections() FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_my_memory_corrections() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_memory_corrections() TO service_role;
