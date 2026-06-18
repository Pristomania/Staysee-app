/*
  PR3c-1 — session processState store in conversations.metadata.
  Enum-only process state; no user text, no clinical labels.
*/

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.conversations.metadata IS
  'Session-only server metadata (processState). No user text, no clinical labels.';
