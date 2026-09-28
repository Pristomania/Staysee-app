-- Retire the legacy user_memory engine and UI for every profile by default.
-- One internal compatibility account keeps the old view for product comparison.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS legacy_memory_compat_enabled boolean NOT NULL DEFAULT false;

UPDATE public.profiles
SET legacy_memory_compat_enabled = false
WHERE legacy_memory_compat_enabled IS DISTINCT FROM false;

UPDATE public.profiles
SET legacy_memory_compat_enabled = true
WHERE id = 'ad52b415-875a-45e9-9f6b-be4d25a2c0e0'::uuid;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_legacy_memory_compat_owner_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_legacy_memory_compat_owner_check
  CHECK (
    legacy_memory_compat_enabled = false
    OR id = 'ad52b415-875a-45e9-9f6b-be4d25a2c0e0'::uuid
  );

COMMENT ON COLUMN public.profiles.legacy_memory_compat_enabled IS
  'Internal comparison flag. When true, legacy user_memory synthesis and the archived memory UI remain available.';
