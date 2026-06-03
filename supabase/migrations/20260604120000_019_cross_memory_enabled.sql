-- User toggle: inject / update cross-conversation memory (user_memory).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS cross_memory_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.cross_memory_enabled IS
  'When false, user_memory is not injected into chat and not auto-updated from conversation summaries.';
