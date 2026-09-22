BEGIN;

SELECT plan(12);

SELECT has_table(
  'public',
  'memory_v3_alert_windows',
  'alert window table exists'
);

SELECT has_function(
  'public',
  'reserve_memory_v3_alert_window',
  ARRAY['text'],
  'alert reservation RPC exists'
);

SELECT ok(
  public.reserve_memory_v3_alert_window('read:load_failed'),
  'first read diagnostic reserves the UTC hour'
);

SELECT is(
  public.reserve_memory_v3_alert_window('read:load_failed'),
  false,
  'duplicate read diagnostic is suppressed in the same UTC hour'
);

SELECT ok(
  public.reserve_memory_v3_alert_window('write:state_write_failed'),
  'different closed diagnostic reserves independently'
);

SELECT throws_ok(
  $$ SELECT public.reserve_memory_v3_alert_window('invalid:sentinel') $$,
  'P0001',
  'invalid memory v3 alert key',
  'unknown alert key is rejected'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.reserve_memory_v3_alert_window(text)',
    'EXECUTE'
  ),
  'service role can execute the alert reservation RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.reserve_memory_v3_alert_window(text)',
    'EXECUTE'
  ),
  'authenticated cannot execute the alert reservation RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.reserve_memory_v3_alert_window(text)',
    'EXECUTE'
  ),
  'anon cannot execute the alert reservation RPC'
);

SELECT ok(
  NOT has_table_privilege(
    'service_role',
    'public.memory_v3_alert_windows',
    'SELECT'
  ),
  'service role has no direct alert-table read access'
);

SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'public.memory_v3_alert_windows',
    'INSERT'
  ),
  'authenticated cannot insert alert windows'
);

SELECT ok(
  NOT has_table_privilege(
    'anon',
    'public.memory_v3_alert_windows',
    'SELECT'
  ),
  'anon cannot read alert windows'
);

SELECT * FROM finish();
ROLLBACK;
