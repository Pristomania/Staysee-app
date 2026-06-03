/*
  # Secure handle_new_user function

  ## Problem
  The existing handle_new_user() function:
  - Is SECURITY DEFINER without an explicit search_path, which allows a
    malicious schema injected earlier in the search path to shadow public tables
    (the classic "search_path hijack" attack vector Supabase warns about).
  - Has EXECUTE granted to PUBLIC, anon, and authenticated roles. The function
    is only ever called by an internal trigger owned by the postgres superuser;
    no application role needs to call it directly.

  ## Changes
  1. Recreate handle_new_user() with:
     - SET search_path = public, pg_temp  — pins the function to the correct schema
     - SECURITY DEFINER retained (required to write to profiles as a trigger)
     - Explicit schema-qualified table reference (public.profiles)
  2. Revoke EXECUTE from PUBLIC (covers anon + authenticated transitively)
  3. Revoke EXECUTE explicitly from anon and authenticated roles
  4. Grant EXECUTE only to postgres (the role that owns the trigger)

  ## No data changes — existing profiles and trigger are untouched.
*/

-- 1. Recreate the function with a locked-down search_path
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- 2. Strip execute from every role that doesn't need it
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;

-- 3. Ensure postgres (trigger owner) retains execute
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres;
