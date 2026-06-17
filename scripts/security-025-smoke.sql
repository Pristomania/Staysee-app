-- Security smoke — run after applying migration 025
--   npx supabase db query --linked -f scripts/security-025-smoke.sql
-- Or paste sections into Supabase SQL Editor.

-- =============================================================================
-- 1. Analytics RPCs: no EXECUTE for anon / authenticated / PUBLIC
-- =============================================================================
-- Expected: 0 rows

SELECT routine_name, grantee, privilege_type AS violation
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_usage_cost_today',
    'get_usage_cost_by_users',
    'get_top_expensive_conversations',
    'get_memory_token_usage'
  )
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  AND privilege_type = 'EXECUTE'
ORDER BY routine_name, grantee;

-- =============================================================================
-- 2. Analytics views: no grants for anon / authenticated / PUBLIC
-- =============================================================================
-- Expected: 0 rows (all four analytics views)

SELECT table_name, grantee, privilege_type AS violation
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'v_analytics_daily_cost',
    'v_analytics_memory_system',
    'v_analytics_cost_by_user',
    'v_analytics_top_conversations'
  )
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;

-- =============================================================================
-- 3. Stale messages policy removed
-- =============================================================================
-- Expected: stale_policy_count = 0

SELECT count(*) AS stale_policy_count
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'messages'
  AND policyname = 'Users can manage own messages';

-- =============================================================================
-- 4. Four 024 messages policies still present
-- =============================================================================
-- Expected: 4 rows, roles {authenticated}

SELECT policyname, cmd, roles::text
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'messages'
  AND policyname IN (
    'Users can view messages in own conversations',
    'Users can create messages in own conversations',
    'Users can update messages in own conversations',
    'Users can delete messages in own conversations'
  )
ORDER BY policyname;

-- =============================================================================
-- 5. increment_usage: no EXECUTE for anon / authenticated / PUBLIC
-- =============================================================================
-- Expected: 0 rows

SELECT routine_name, grantee, privilege_type AS violation
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public'
  AND routine_name = 'increment_usage'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  AND privilege_type = 'EXECUTE';

-- =============================================================================
-- 6. list_rooms_ready_for_purge: no EXECUTE for anon / authenticated / PUBLIC
-- =============================================================================
-- Expected: 0 rows

SELECT routine_name, grantee, privilege_type AS violation
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public'
  AND routine_name = 'list_rooms_ready_for_purge'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  AND privilege_type = 'EXECUTE';

-- =============================================================================
-- 7. service_role EXECUTE grants present where required
-- =============================================================================
-- Expected: 6 rows (4 analytics RPCs + increment_usage + list_rooms_ready_for_purge)

SELECT routine_name, grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_usage_cost_today',
    'get_usage_cost_by_users',
    'get_top_expensive_conversations',
    'get_memory_token_usage',
    'increment_usage',
    'list_rooms_ready_for_purge'
  )
  AND grantee = 'service_role'
  AND privilege_type = 'EXECUTE'
ORDER BY routine_name;

-- =============================================================================
-- 8. messages RLS still enabled
-- =============================================================================
-- Expected: messages_rls_enabled = true

SELECT relrowsecurity AS messages_rls_enabled
FROM pg_class
WHERE oid = 'public.messages'::regclass;

-- =============================================================================
-- 9. Optional: messages.user_id INSERT/UPDATE policy text (prod drift)
-- =============================================================================
-- When user_id column exists, INSERT/UPDATE policies should mention user_id.

SELECT policyname, cmd,
       (qual LIKE '%user_id%' OR with_check LIKE '%user_id%') AS has_user_id_guard
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'messages'
  AND policyname IN (
    'Users can create messages in own conversations',
    'Users can update messages in own conversations'
  )
ORDER BY policyname;

-- =============================================================================
-- 10. Manual REST / RPC / UI checklist (not runnable in SQL Editor)
-- =============================================================================
--
-- Analytics RPCs blocked for anon:
--   POST /rest/v1/rpc/get_usage_cost_by_users  body: {}
--   Headers: apikey=$ANON_KEY, Authorization=Bearer $ANON_KEY
--   Expected: 401/403 — NOT 200 with user_id rows
--
--   POST /rest/v1/rpc/get_top_expensive_conversations  body: {"p_limit":1}
--   Expected: 401/403 — NOT 200 with conversation_id/user_id
--
--   POST /rest/v1/rpc/get_usage_cost_today  body: {}
--   Expected: 401/403
--
--   POST /rest/v1/rpc/get_memory_token_usage  body: {}
--   Expected: 401/403
--
-- Analytics views blocked for anon:
--   GET /rest/v1/v_analytics_daily_cost?select=day&limit=1
--   Expected: 401 permission denied — NOT aggregate cost rows
--
--   GET /rest/v1/v_analytics_memory_system?select=day&limit=1
--   Expected: 401 permission denied
--
-- Messages baseline (024 still holds):
--   GET /rest/v1/messages?select=id&limit=1  (anon)
--   Expected: [] — NOT real message rows
--
-- Chat UX (authenticated user):
--   - Open existing chat → history loads
--   - Send message → user + ai rows persist
--   - staysee-chat recall: ask about earlier phrase in same conversation → still works
--
-- Edge / ops (service_role only — should still work):
--   - staysee-chat quota increment (increment_usage via svc client)
--   - usageAnalytics RPCs via service_role client
--   - purge-scheduled-rooms → list_rooms_ready_for_purge
--
-- Cross-user regression (authenticated user A JWT):
--   GET /rest/v1/messages?conversation_id=eq.<B_CONV_ID>&select=id,content
--   Expected: [] (RLS filters out)
--
-- user_id spoof blocked (if messages.user_id column present):
--   INSERT into own conversation with user_id = another user's uuid
--   Expected: RLS violation / insert rejected
