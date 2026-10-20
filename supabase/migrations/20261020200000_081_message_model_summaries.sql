-- Short versions of long messages, read by the model and never shown to the person.
--
-- A message of more than 4,000 characters is read by the model in full for the next 10 replies, then as a
-- short version (made once by a cheap model when it is first needed, then reused). The person always sees
-- the message in full. This table is for the service role only: row level security is on, there are no
-- policies, and the public roles have no privileges. A short version is deleted with its message
-- (and with the conversation or account that owns it) through the foreign keys.

CREATE TABLE public.message_model_summaries (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  summary text NOT NULL CHECK (pg_catalog.char_length(summary) BETWEEN 1 AND 1500),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.message_model_summaries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.message_model_summaries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_model_summaries TO service_role;
