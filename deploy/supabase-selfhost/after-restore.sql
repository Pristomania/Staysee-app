-- What a dump of the "public" schema does NOT carry, taken from the production database on 2026-11-20 (read-only look):
--   1) two triggers on auth.users (the signup consents and the usage tier of a new person);
--   2) the four daily jobs of pg_cron (the table cron.job belongs to the extension and is not dumped).
-- Run once, after the production structure is restored and the auth service has created its schema:
--   docker exec -i staysee-selfhost-db psql -U postgres -v ON_ERROR_STOP=1 < after-restore.sql

CREATE OR REPLACE TRIGGER "on_auth_user_created_consents"
  AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."record_signup_consents"();

CREATE OR REPLACE TRIGGER "on_auth_user_created_usage_tier"
  AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."create_usage_tier_for_new_user"();

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule('memory-v3-shadow-purge-daily',            '17 3 * * *', 'SELECT public.purge_memory_v3_shadow_runs();');
SELECT cron.schedule('memory-v3-lifecycle-shadow-purge-daily',  '29 3 * * *', 'SELECT public.purge_memory_v3_lifecycle_shadow_runs();');
SELECT cron.schedule('memory-v3-dialogue-purge-daily',          '31 3 * * *', 'SELECT public.purge_memory_v3_dialogue_runs();');
SELECT cron.schedule('purge-scheduled-rooms-daily',             '23 3 * * *', 'SELECT public.purge_scheduled_rooms();');
