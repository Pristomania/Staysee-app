-- Security RLS smoke — run after applying migration 024
--   npx supabase db query --linked -f scripts/security-rls-smoke.sql
-- Or paste sections into Supabase SQL Editor.

-- =============================================================================
-- A. RLS enabled on public.messages
-- =============================================================================
-- Expected: relrowsecurity = true

SELECT relrowsecurity AS messages_rls_enabled
FROM pg_class
WHERE oid = 'public.messages'::regclass;

-- =============================================================================
-- B. Policies on public.messages
-- =============================================================================
-- Expected: 4 rows — SELECT, INSERT, UPDATE, DELETE — role {authenticated}

SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'messages'
ORDER BY policyname;

-- =============================================================================
-- C. Grants on analytics views (should be empty or postgres/service only)
-- =============================================================================
-- Expected: no grants for anon, authenticated, or PUBLIC on these views

SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('v_analytics_cost_by_user', 'v_analytics_top_conversations')
ORDER BY table_name, grantee, privilege_type;

-- =============================================================================
-- D. Manual REST / UI checks (after db push — not runnable in SQL Editor)
-- =============================================================================
--
-- 1. Anon cannot read messages
--    curl -s "$SUPABASE_URL/rest/v1/messages?select=id&limit=1" \
--      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--    Expected: [] or 401 — NOT 200 with real message rows
--
-- 2. Authenticated user A reads own messages
--    (user A JWT) GET /rest/v1/messages?conversation_id=eq.<A_CONV_ID>&select=id,content
--    Expected: 200, own rows only
--
-- 3. User A cannot read user B messages
--    (user A JWT) GET /rest/v1/messages?conversation_id=eq.<B_CONV_ID>&select=id,content
--    Expected: [] (RLS filters out)
--
-- 4. UI: user A opens chat → history loads; sends message → user+ai rows persist
--
-- 5. staysee-chat: in same conversation ask about a phrase from an earlier message
--    Expected: model still recalls (archive/tail); no empty-context regression
--
-- 6. Analytics views closed via REST
--    curl -s "$SUPABASE_URL/rest/v1/v_analytics_cost_by_user?select=user_id&limit=1" \
--      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--    Expected: permission denied or empty — not cross-user cost data
