/*
  # P0 Security: re-enable messages RLS + close analytics views

  ## Context (prod drift)
  Migration 002 enabled RLS on public.messages, but production had
  relrowsecurity = false — anon/authenticated REST could read all message content.

  ## Memory / context (expected behaviour after this migration)
  - staysee-chat and frontend read messages via the user's JWT; policies below
    allow SELECT only when conversations.user_id = auth.uid().
  - Edge background work (embeddings, summary persist, usage) uses service_role
    and is unaffected by RLS (service_role bypasses row policies).
  - No FORCE ROW LEVEL SECURITY — table owner / service_role retain bypass.

  ## Analytics views
  v_analytics_cost_by_user and v_analytics_top_conversations are ops-only.
  REVOKE removes anon/authenticated/PUBLIC access; views are not dropped.
  Use service_role or SQL editor for cost dashboards.

  Post-apply smoke: scripts/security-rls-smoke.sql
*/

-- ── messages: enable RLS ─────────────────────────────────────────────────────

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Idempotent policy reset (names from 002 + 003)
DROP POLICY IF EXISTS "Users can view messages in own conversations" ON public.messages;
DROP POLICY IF EXISTS "Users can create messages in own conversations" ON public.messages;
DROP POLICY IF EXISTS "Users can update messages in own conversations" ON public.messages;
DROP POLICY IF EXISTS "Users can delete messages in own conversations" ON public.messages;

CREATE POLICY "Users can view messages in own conversations"
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create messages in own conversations"
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update messages in own conversations"
  ON public.messages
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete messages in own conversations"
  ON public.messages
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

-- ── analytics views: revoke public API access ────────────────────────────────

REVOKE ALL ON public.v_analytics_cost_by_user FROM anon;
REVOKE ALL ON public.v_analytics_cost_by_user FROM authenticated;
REVOKE ALL ON public.v_analytics_cost_by_user FROM PUBLIC;

REVOKE ALL ON public.v_analytics_top_conversations FROM anon;
REVOKE ALL ON public.v_analytics_top_conversations FROM authenticated;
REVOKE ALL ON public.v_analytics_top_conversations FROM PUBLIC;
