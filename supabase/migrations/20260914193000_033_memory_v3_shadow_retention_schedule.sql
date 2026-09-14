-- Daily retention enforcement for the inactive Memory V3 shadow pilot.

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.unschedule('memory-v3-shadow-purge-daily')
WHERE EXISTS (
  SELECT 1
  FROM cron.job
  WHERE jobname = 'memory-v3-shadow-purge-daily'
);

SELECT cron.schedule(
  'memory-v3-shadow-purge-daily',
  '17 3 * * *',
  $cron$SELECT public.purge_memory_v3_shadow_runs();$cron$
);
