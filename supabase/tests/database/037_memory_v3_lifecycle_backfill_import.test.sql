BEGIN;

SELECT plan(18);

CREATE OR REPLACE FUNCTION pg_temp.test_uuid(p_label text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    pg_catalog.substr(digest, 1, 12) || '4' ||
    pg_catalog.substr(digest, 14, 3) || '8' ||
    pg_catalog.substr(digest, 18)
  )::uuid
  FROM (SELECT pg_catalog.md5(p_label) AS digest) AS source;
$$;

CREATE OR REPLACE FUNCTION pg_temp.test_user()
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.test_uuid('memory-v3-backfill-valid-user');
$$;

CREATE OR REPLACE FUNCTION pg_temp.rollback_user()
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.test_uuid('memory-v3-backfill-forced-audit-failure-user');
$$;

CREATE OR REPLACE FUNCTION pg_temp.case_label(p_case_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_case_name = 'duplicate-user' THEN 'valid' ELSE p_case_name END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.case_user(p_case_name text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.test_uuid('memory-v3-backfill-' || pg_temp.case_label(p_case_name) || '-user');
$$;

CREATE OR REPLACE FUNCTION pg_temp.case_conversation(p_case_name text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.test_uuid('memory-v3-backfill-' || pg_temp.case_label(p_case_name) || '-conversation');
$$;

CREATE OR REPLACE FUNCTION pg_temp.case_message(p_case_name text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.test_uuid('memory-v3-backfill-' || pg_temp.case_label(p_case_name) || '-message');
$$;

DO $fixtures$
DECLARE
  v_case text;
  v_user uuid;
  v_conversation uuid;
  v_message uuid;
BEGIN
  FOREACH v_case IN ARRAY ARRAY[
    'valid', 'duplicate-digest', 'nonzero-head', 'foreign-conversation',
    'foreign-message', 'assistant-message', 'mention-time-mismatch',
    'message-after-cutoff', 'invalid-status', 'item-cap', 'evidence-cap',
    'forced-audit-failure', 'foreign-owner'
  ] LOOP
    v_user := pg_temp.case_user(v_case);
    v_conversation := pg_temp.case_conversation(v_case);
    v_message := pg_temp.case_message(v_case);

    INSERT INTO auth.users(id, email)
    VALUES (v_user, v_case || '@memory-v3-backfill.invalid');
    INSERT INTO public.profiles(id) VALUES (v_user)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.conversations(id, user_id, title, created_at, last_message_at)
    VALUES (
      v_conversation, v_user, 'synthetic Memory V3 backfill fixture',
      '2026-09-18T00:00:00Z'::timestamptz,
      CASE WHEN v_case = 'message-after-cutoff'
        THEN '2026-09-21T00:00:00Z'::timestamptz
        ELSE '2026-09-19T00:00:00Z'::timestamptz END
    );
    INSERT INTO public.messages(id, conversation_id, sender, content, created_at)
    VALUES (
      v_message, v_conversation,
      CASE WHEN v_case = 'assistant-message' THEN 'ai' ELSE 'user' END,
      'synthetic Memory V3 evidence',
      CASE WHEN v_case = 'message-after-cutoff'
        THEN '2026-09-21T00:00:00Z'::timestamptz
        ELSE '2026-09-19T00:00:00Z'::timestamptz END
    );
  END LOOP;

  INSERT INTO public.memory_v3_lifecycle_shadow_heads(
    user_id, state_revision, next_memory_ordinal
  ) VALUES (pg_temp.case_user('nonzero-head'), 1, 2);
  INSERT INTO public.memory_v3_lifecycle_shadow_heads(user_id)
  VALUES (pg_temp.rollback_user());
END;
$fixtures$;

CREATE OR REPLACE FUNCTION pg_temp.base_state(
  p_user_id uuid, p_conversation_id uuid, p_message_id uuid,
  p_mention_time timestamptz
)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-lifecycle-state-v1',
    'userId', p_user_id::text,
    'stateRevision', 4,
    'nextMemoryOrdinal', 5,
    'items', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'memoryKey', pg_catalog.repeat('1', 64),
        'kind', 'event',
        'claim', 'Синтетический проверяемый факт',
        'status', 'active',
        'sensitivity', 'normal',
        'eventTimeStart', '2026-09-19',
        'eventTimeEnd', '2026-09-19',
        'alternative', NULL,
        'firstSeenAt', '2026-09-19T00:00:00.000Z',
        'updatedAt', '2026-09-19T00:00:00.000Z',
        'revision', 1,
        'evidence', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'conversationId', p_conversation_id::text,
            'sourceMessageId', p_message_id::text,
            'relation', 'supports',
            'supportType', NULL,
            'episodeKey', 'episode:synthetic',
            'provenanceRole', 'user',
            'mentionTime', pg_catalog.to_char(
              p_mention_time AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          )
        )
      )
    )
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.valid_import_sql(p_case_name text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := pg_temp.case_user(p_case_name);
  v_conversation uuid := pg_temp.case_conversation(p_case_name);
  v_message uuid := pg_temp.case_message(p_case_name);
  v_mention_time timestamptz := CASE WHEN p_case_name = 'message-after-cutoff'
    THEN '2026-09-21T00:00:00Z'::timestamptz
    ELSE '2026-09-19T00:00:00Z'::timestamptz END;
  v_state jsonb;
  v_artifact_digest text;
BEGIN
  IF p_case_name = 'foreign-conversation' THEN
    v_conversation := pg_temp.case_conversation('foreign-owner');
    v_message := pg_temp.case_message('foreign-owner');
  ELSIF p_case_name = 'foreign-message' THEN
    v_message := pg_temp.case_message('foreign-owner');
  ELSIF p_case_name = 'mention-time-mismatch' THEN
    v_mention_time := '2026-09-18T00:00:00Z'::timestamptz;
  END IF;

  v_state := pg_temp.base_state(v_user, v_conversation, v_message, v_mention_time);
  IF p_case_name = 'invalid-status' THEN
    v_state := pg_catalog.jsonb_set(v_state, '{items,0,status}', '"invented"'::jsonb);
  ELSIF p_case_name = 'item-cap' THEN
    SELECT pg_catalog.jsonb_set(
      v_state, '{items}',
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_set(
          v_state->'items'->0, '{memoryKey}',
          pg_catalog.to_jsonb(pg_catalog.lpad(pg_catalog.to_hex(n), 64, '0'))
        ) ORDER BY n
      )
    ) INTO v_state FROM pg_catalog.generate_series(1, 101) AS n;
  ELSIF p_case_name = 'evidence-cap' THEN
    SELECT pg_catalog.jsonb_set(
      v_state, '{items,0,evidence}',
      pg_catalog.jsonb_agg(v_state->'items'->0->'evidence'->0 ORDER BY n)
    ) INTO v_state FROM pg_catalog.generate_series(1, 501) AS n;
  END IF;

  v_artifact_digest := CASE
    WHEN p_case_name IN ('valid', 'duplicate-digest') THEN pg_catalog.repeat('a', 64)
    ELSE pg_catalog.md5('artifact-' || p_case_name) || pg_catalog.md5('artifact-2-' || p_case_name)
  END;

  RETURN pg_catalog.format(
    'SELECT * FROM public.import_memory_v3_lifecycle_backfill_state(%L::uuid,%L::uuid,0,%L,%L,%L::timestamptz,%L,%L,%L,%L,%L::jsonb)',
    pg_temp.test_uuid('memory-v3-backfill-import-' || p_case_name)::text,
    v_user::text, v_artifact_digest,
    pg_catalog.md5('source-' || p_case_name) || pg_catalog.md5('source-2-' || p_case_name),
    '2026-09-20T00:00:00Z',
    'memory-v3-lifecycle-history-backfill-v1',
    'memory-v3-lifecycle-shadow-v1',
    'memory-v3-openrouter-gemini-3.7-flash-shadow-v2',
    'memory-v3-lifecycle-reconciler-v1', v_state::text
  );
END;
$$;

SELECT lives_ok(pg_temp.valid_import_sql('valid'), 'valid initial import');
SELECT ok(
  (SELECT pg_catalog.count(*) = 1 FROM public.memory_v3_lifecycle_shadow_items
    WHERE user_id = pg_temp.test_user())
  AND pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'SELECT'
  )
  AND pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'INSERT'
  )
  AND NOT pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'UPDATE'
  )
  AND NOT pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'DELETE'
  )
  AND NOT pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'TRUNCATE'
  )
  AND NOT pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'REFERENCES'
  )
  AND NOT pg_catalog.has_table_privilege(
    'service_role', 'public.memory_v3_lifecycle_backfill_imports', 'TRIGGER'
  )
  AND pg_catalog.has_function_privilege(
    'service_role',
    'public.import_memory_v3_lifecycle_backfill_state(uuid,uuid,bigint,text,text,timestamp with time zone,text,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'one item imported and service_role has exact import privileges'
);
SELECT throws_ok(pg_temp.valid_import_sql('duplicate-user'), NULL, NULL, 'duplicate user import rejected');
SELECT throws_ok(pg_temp.valid_import_sql('duplicate-digest'), NULL, NULL, 'duplicate digest rejected');
SELECT throws_ok(pg_temp.valid_import_sql('nonzero-head'), NULL, NULL, 'nonzero head rejected');
SELECT throws_ok(pg_temp.valid_import_sql('foreign-conversation'), NULL, NULL, 'foreign conversation rejected');
SELECT throws_ok(pg_temp.valid_import_sql('foreign-message'), NULL, NULL, 'foreign message rejected');
SELECT throws_ok(pg_temp.valid_import_sql('assistant-message'), NULL, NULL, 'assistant evidence rejected');
SELECT throws_ok(pg_temp.valid_import_sql('mention-time-mismatch'), NULL, NULL, 'evidence mention time mismatch rejected');
SELECT throws_ok(pg_temp.valid_import_sql('message-after-cutoff'), NULL, NULL, 'evidence newer than cutoff rejected');
SELECT throws_ok(pg_temp.valid_import_sql('invalid-status'), NULL, NULL, 'invalid status rejected');
SELECT throws_ok(pg_temp.valid_import_sql('item-cap'), NULL, NULL, 'item cap rejected');
SELECT throws_ok(pg_temp.valid_import_sql('evidence-cap'), NULL, NULL, 'evidence cap rejected');

CREATE OR REPLACE FUNCTION pg_temp.fail_backfill_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id = pg_temp.rollback_user() THEN
    RAISE EXCEPTION 'forced audit failure';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER force_backfill_audit_failure
BEFORE INSERT ON public.memory_v3_lifecycle_backfill_imports
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_backfill_audit();

SELECT throws_ok(
  pg_temp.valid_import_sql('forced-audit-failure'), NULL, NULL,
  'forced final audit failure rolls back'
);
SELECT is(
  (SELECT state_revision FROM public.memory_v3_lifecycle_shadow_heads
    WHERE user_id = pg_temp.rollback_user()),
  0::bigint, 'forced failure leaves head unchanged'
);
SELECT is(
  (SELECT pg_catalog.count(*) FROM public.memory_v3_lifecycle_shadow_items
    WHERE user_id = pg_temp.rollback_user()),
  0::bigint, 'forced failure leaves no items'
);
SELECT is(
  (SELECT pg_catalog.count(*) FROM public.memory_v3_lifecycle_shadow_evidence
    WHERE user_id = pg_temp.rollback_user()),
  0::bigint, 'forced failure leaves no evidence'
);
SELECT is(
  (SELECT pg_catalog.count(*) FROM public.memory_v3_lifecycle_backfill_imports
    WHERE user_id = pg_temp.rollback_user()),
  0::bigint, 'forced failure leaves no audit row'
);

SELECT * FROM finish();

ROLLBACK;
