/*
  # P0/P1 Security: lock analytics RPCs, views, stale messages policy, sensitive RPCs

  ## Context (post-024 audit)
  - Analytics SECURITY DEFINER RPCs and two analytics views were still callable/readable
    by anon/authenticated despite migration 013 intent.
  - Stale policy "Users can manage own messages" on public.messages (prod drift) allowed
    cross-user reads via messages.user_id = auth.uid().
  - increment_usage and list_rooms_ready_for_purge had overly broad EXECUTE grants.

  ## Scope
  - Grants / policy changes only. No function bodies, views, frontend, or Edge changes.
  - staysee-chat and Edge use service_role for increment_usage, analytics RPCs, and purge.

  Post-apply smoke: scripts/security-025-smoke.sql
*/

-- ── A. Analytics SECURITY DEFINER RPCs: service_role only ─────────────────────

REVOKE ALL ON FUNCTION public.get_usage_cost_today() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_usage_cost_today() FROM anon;
REVOKE ALL ON FUNCTION public.get_usage_cost_today() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_usage_cost_today() TO service_role;

REVOKE ALL ON FUNCTION public.get_usage_cost_by_users(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_usage_cost_by_users(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_usage_cost_by_users(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_usage_cost_by_users(timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.get_top_expensive_conversations(int, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_top_expensive_conversations(int, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_top_expensive_conversations(int, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_top_expensive_conversations(int, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.get_memory_token_usage(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_memory_token_usage(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_memory_token_usage(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_memory_token_usage(timestamptz) TO service_role;

-- ── B. Analytics views: revoke public API access ─────────────────────────────

REVOKE ALL ON public.v_analytics_daily_cost FROM PUBLIC;
REVOKE ALL ON public.v_analytics_daily_cost FROM anon;
REVOKE ALL ON public.v_analytics_daily_cost FROM authenticated;

REVOKE ALL ON public.v_analytics_memory_system FROM PUBLIC;
REVOKE ALL ON public.v_analytics_memory_system FROM anon;
REVOKE ALL ON public.v_analytics_memory_system FROM authenticated;

-- ── C. Remove stale messages policy (prod drift) ─────────────────────────────

DROP POLICY IF EXISTS "Users can manage own messages" ON public.messages;

-- ── D. Harden INSERT/UPDATE when messages.user_id exists (prod drift) ────────
-- If the column is absent (tracked schema only), 024 policies remain unchanged.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'messages'
      AND column_name = 'user_id'
  ) THEN
    DROP POLICY IF EXISTS "Users can create messages in own conversations" ON public.messages;
    DROP POLICY IF EXISTS "Users can update messages in own conversations" ON public.messages;

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
        AND (messages.user_id IS NULL OR messages.user_id = auth.uid())
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
        AND (messages.user_id IS NULL OR messages.user_id = auth.uid())
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.conversations c
          WHERE c.id = messages.conversation_id
            AND c.user_id = auth.uid()
        )
        AND (messages.user_id IS NULL OR messages.user_id = auth.uid())
      );
  END IF;
END $$;

-- ── E. increment_usage: service_role only (Edge staysee-chat) ─────────────────

REVOKE ALL ON FUNCTION public.increment_usage(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_usage(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.increment_usage(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(uuid, int) TO service_role;

-- ── F. list_rooms_ready_for_purge: service_role only (purge-scheduled-rooms) ─

REVOKE ALL ON FUNCTION public.list_rooms_ready_for_purge(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_rooms_ready_for_purge(int) FROM anon;
REVOKE ALL ON FUNCTION public.list_rooms_ready_for_purge(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_rooms_ready_for_purge(int) TO service_role;
