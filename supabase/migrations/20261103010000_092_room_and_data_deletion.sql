-- 092_room_and_data_deletion
-- Deleting a person's memory, their data, and their room (account), repaired and completed.
--
-- What was wrong on production (read from its real schema on 02.11.2026):
--  * request_room_deletion() (migration 020) updates profiles.onboarding_completed and profiles.primary_concern, columns the
--    production profiles table does not have, and deletes from ai_usage_log, a table production does not have. Every press
--    of "Удалить комнату навсегда" failed and rolled back: nothing was deleted and the person only saw "try later".
--  * Nothing called purge-scheduled-rooms once a day, so the login record promised to be erased after 14 days never was.
--  * "Delete all memory" removed only the items and heads of the memory (delete_all_memory_v3_*_data) and left everything
--    built around them: the runs with the model's raw answers and the context it was given, the identities of the runs,
--    the shadow runs, the import records, the alerts, and the corrections. The screen said "deleted".
--  * "Delete data" from the app was a row of separate calls, one per kind of table, with no single moment at which "all of
--    it is gone" was true and no way to know a table had been forgotten.
--
-- What this does:
--  * _wipe_memory(uid): every kind of memory of a person, all the tables of Memory V3 (items, heads, evidence, identities,
--    runs, shadow runs, imports, alerts, failures), the old memory table and the corrections.
--  * _wipe_account_content(uid): that, plus conversations (and what hangs on them), notes, embeddings and the event logs.
--    Neither is callable by people.
--  * delete_my_memory(): "Удалить всю память" for the caller, one transaction. Conversations and notes stay.
--  * delete_my_account_data(): the free plan's "Удалить данные аккаунта": the caller's content, one transaction. The
--    account, the plan, the counter, the bought messages, the consents and the usage log stay.
--  * request_room_deletion(): the same wipe, then the usage rows, then the profile is marked (created if it was missing) so
--    the person cannot sign in and the 14 days start. Only columns production has.
--  * purge_scheduled_rooms() and a daily job: the accounts whose 14 days are over are removed for good (the profile and
--    everything tied to it go with the sign-in record, which also removes consents and bought messages, as the policy
--    says). One account failing is logged and does not stop the others. Runs inside the database, no outside server.
-- A listed table that does not exist (a database that is behind) is skipped, so a missing table can never block a deletion;
-- a test keeps the lists complete against every table the migrations create with a user_id.

CREATE OR REPLACE FUNCTION public._wipe_memory(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tables text[] := ARRAY[
    'memory_corrections',
    'user_memory',
    'memory_v3_dialogue_backfill_imports',
    'memory_v3_dialogue_evidence',
    'memory_v3_dialogue_heads',
    'memory_v3_dialogue_identities',
    'memory_v3_dialogue_items',
    'memory_v3_dialogue_runs',
    'memory_v3_lifecycle_backfill_imports',
    'memory_v3_lifecycle_shadow_evidence',
    'memory_v3_lifecycle_shadow_heads',
    'memory_v3_lifecycle_shadow_identities',
    'memory_v3_lifecycle_shadow_items',
    'memory_v3_lifecycle_shadow_runs',
    'memory_v3_reservation_failures',
    'memory_v3_shadow_identities',
    'memory_v3_shadow_runs',
    'memory_v3_stale_alerts'
  ];
  v_table text;
  v_rows  bigint;
  v_total bigint := 0;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', v_table) USING p_user_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_total := v_total + v_rows;
    END IF;
  END LOOP;
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public._wipe_account_content(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Conversations first: everything with a conversation_id hangs on it and goes with it. The rest are the tables that only
  -- know the person (notes, derived logs). The memory goes through _wipe_memory.
  v_tables text[] := ARRAY[
    'conversations',
    'message_embeddings',
    'message_length_events',
    'message_model_summaries',
    'progress_entries',
    'protocol_events',
    'ai_reply_recovery_events'
  ];
  v_table text;
  v_rows  bigint;
  v_total bigint := 0;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', v_table) USING p_user_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_total := v_total + v_rows;
    END IF;
  END LOOP;
  v_total := v_total + public._wipe_memory(p_user_id);
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public._wipe_memory(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wipe_memory(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._wipe_memory(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public._wipe_account_content(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wipe_account_content(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._wipe_account_content(uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.delete_my_memory()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_rows bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'not_authenticated';
  END IF;

  v_rows := public._wipe_memory(v_uid);
  RETURN jsonb_build_object('rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_memory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_my_memory() FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_my_memory() TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_my_account_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_rows bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'not_authenticated';
  END IF;

  v_rows := public._wipe_account_content(v_uid);
  RETURN jsonb_build_object('rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_account_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_my_account_data() FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account_data() TO authenticated;

CREATE OR REPLACE FUNCTION public.request_room_deletion()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_purge_at timestamptz := now() + interval '14 days';
  v_existing timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- Asked before and fully recorded: the same date again, nothing is deleted twice. A half-written request (a date
  -- missing) is done again, so that the purge always has a date to stand on.
  SELECT room_purge_after INTO v_existing
  FROM public.profiles
  WHERE id = v_uid AND room_deletion_requested_at IS NOT NULL AND room_purge_after IS NOT NULL;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  PERFORM public._wipe_account_content(v_uid);
  DELETE FROM public.ai_usage_logs WHERE user_id = v_uid;
  DELETE FROM public.user_usage_tiers WHERE user_id = v_uid;

  -- The profile may be missing (an account made before profiles were filled in): make it, so that the sign-in block and
  -- the 14 days have something to stand on.
  INSERT INTO public.profiles (id, room_deletion_requested_at, room_purge_after, cross_memory_enabled)
  VALUES (v_uid, now(), v_purge_at, true)
  ON CONFLICT (id) DO UPDATE
    SET room_deletion_requested_at = now(),
        room_purge_after = v_purge_at,
        cross_memory_enabled = true;

  RETURN v_purge_at;
END;
$$;

REVOKE ALL ON FUNCTION public.request_room_deletion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_room_deletion() FROM anon;
GRANT EXECUTE ON FUNCTION public.request_room_deletion() TO authenticated;

-- Removes for good the rooms whose 14 days are over. The sign-in record goes, and the profile and every table tied to it
-- with it; the content is wiped once more first, for the tables that have no link to delete by. Each account on its own:
-- one that cannot be removed is reported (a warning in the database log) and the others still are.
CREATE OR REPLACE FUNCTION public.purge_scheduled_rooms()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id    uuid;
  v_count integer := 0;
BEGIN
  FOR v_id IN
    SELECT p.id
    FROM public.profiles p
    WHERE p.room_deletion_requested_at IS NOT NULL
      AND p.room_purge_after IS NOT NULL
      AND p.room_purge_after <= now()
    ORDER BY p.room_purge_after
    LIMIT 100
  LOOP
    BEGIN
      PERFORM public._wipe_account_content(v_id);
      DELETE FROM auth.users WHERE id = v_id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'purge_scheduled_rooms: account % was not removed: % (%)', v_id, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_scheduled_rooms() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_scheduled_rooms() FROM anon;
REVOKE ALL ON FUNCTION public.purge_scheduled_rooms() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_scheduled_rooms() TO service_role;

-- Every day at 03:23 UTC. Unscheduled first, so that running this twice leaves one job.
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.unschedule('purge-scheduled-rooms-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-scheduled-rooms-daily');

SELECT cron.schedule(
  'purge-scheduled-rooms-daily',
  '23 3 * * *',
  $cron$SELECT public.purge_scheduled_rooms();$cron$
);
