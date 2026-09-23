# Memory V3 Dialogue-Scope Historical Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give StaySEE a one-time, hand-run tool that reprocesses Настя's entire real message history through the extractor+reconciler pipeline, scoped per conversation instead of per account, so she can review real dialogue-scoped topic/fact placement before trusting it more broadly.

**Architecture:** Mirror the existing `scripts/memory-v3-pilot/lifecycle-history-backfill-*.ts` tool file-for-file for dialogue scope, reusing its source-reading and cost/budget layers unchanged, forking its contract/provider/engine/cli/import/import-run layers with dialogue-scope types and per-conversation state grouping, and adding two new pieces (an auto-generated review-approval file, a plain-Russian readable report) plus one new migration for the bulk per-conversation import RPC.

**Tech Stack:** Deno edge functions (Supabase, only for the new migration's SQL — everything else is a Node/tsx script), Node/tsx for the historical-backfill tooling and its tests, Postgres/PL-pgSQL.

**Spec:** `docs/superpowers/specs/2026-09-24-memory-v3-dialogue-history-backfill-design.md`

## Global Constraints

- Full history, all conversations, no subset — Настя's explicit choice.
- Two-step process: paid разбор (produces local files only, zero production writes) → separate перенос-в-память command (zero paid calls, writes to production).
- The review-approval file is auto-generated from the paid run's artifact after Настя reads the plain-Russian report — she never hand-writes it.
- Every conversation is processed and its dialogue state imported, whether it already had live data before this tool touched it or not — Настя explicitly chose full reprocessing over skipping (2026-09-24), since her most active conversation is exactly the one most likely to already have some organic data, and it's the one she most wants a careful historical read of. The only thing still guarded against is a race: each conversation's state revision is captured right before the paid run and re-checked immediately before the import write; if the conversation's actual current revision no longer matches (the live incremental pipeline wrote something new to it in between), that one conversation's import is rejected with a clear, named error instead of silently overwriting data it never saw — every other conversation in the same import batch is unaffected.
- Reuse `lifecycle-history-backfill-source.ts` and `lifecycle-history-backfill-profile.ts` completely unchanged — do not fork or modify them.
- `lifecycle-model-benchmark-*.ts`/`live-benchmark-*.ts` are out of scope — do not touch or port them.
- The live incremental dialogue pipeline (`dialogueShadowRunner.ts` and everything it calls) is out of scope — do not touch it.
- No `tsconfig` covers `scripts/` in this repo — do not add a type-check step for the new files; `npx tsx --test` is the only verification mechanism, matching the existing `scripts/memory-v3-pilot/*.ts` convention.
- Nothing in this plan may run a real paid extraction/reconciliation call or a real production import — all new-code verification uses synthetic/mocked adapters and a fake source reader, mirroring exactly how the existing lifecycle tool's own tests do this.

## Review Focus

- A conversation whose entire message history (up to the cutoff) has zero `user`-role messages: `chunkOneConversation` (reused unchanged from `lifecycle-history-backfill-contract.ts`, now called from the dialogue-scope contract fork) has no valid chunk boundary to select in that case (`selectedEnd` stays `-1` for every window) and calls `fail(token)` for the WHOLE preparation, aborting the run for every conversation, not just that one. Task 2's test must cover this and confirm the behavior matches the lifecycle original's (this is pre-existing behavior being mirrored, not new — the point is confirming the fork didn't accidentally change it, and documenting that a single all-assistant conversation blocks the whole batch, which the plain-Russian report in Task 8 should surface clearly if it happens).
- Two different conversations with overlapping/interleaved message timestamps: `prepared.chunks` arrives sorted into one global timeline, not grouped by conversation (see Task 4's core correction). A naive "conversation changed since the last chunk" adjacency check would silently corrupt cross-conversation state. Task 4's test must build a synthetic `prepared.chunks` array with deliberately interleaved `conversationOrdinal` values and confirm each conversation's state accumulates only its own chunks regardless of array order.
- A conversation that already had live data before this tool touched it must be clearly labeled in the plain-Russian report as "existing records replaced," never indistinguishable from a conversation that started empty — this is now a deliberately destructive operation for such a conversation, and Настя must never be surprised by that after the fact. Task 8's test must cover this.
- A conversation whose actual current state revision no longer matches what was recorded when the paid run inspected it — because the live incremental pipeline wrote something new to that exact conversation in the days between the paid run and the import, plausible for Настя's most active conversation specifically: the import step's re-check must reject that one conversation's import with a clear, named error, and must NOT abort the other conversations' imports in the same batch. Task 6's test must cover partial-batch success alongside one rejected conversation.
- The review-approval-file generator must refuse to produce a PASS decision for an artifact whose own `failureCount` is not zero, or whose `finalState`/per-conversation states are incomplete — mirroring `validateArtifact`'s own requirement that only a fully-succeeded artifact is reviewable at all. Task 7's test must cover a failed/partial artifact being rejected, not silently approved.

---

### Task 1: Migration — `import_memory_v3_dialogue_backfill_state` RPC

**Files:**
- Create: `supabase/migrations/20260924150000_050_memory_v3_dialogue_backfill_import.sql`
- Test: `supabase/functions/_shared/memoryV3/dialogueBackfillImportMigration.cases.test.ts`

**Interfaces:**
- Produces: `import_memory_v3_dialogue_backfill_state(p_import_id uuid, p_user_id uuid, p_conversation_id uuid, p_expected_state_revision bigint, p_artifact_digest text, p_source_snapshot_digest text, p_source_cutoff timestamptz, p_profile_id text, p_pipeline_version text, p_extractor_version text, p_reconciler_version text, p_state jsonb) RETURNS TABLE(result text, resulting_state_revision bigint)`, `SECURITY DEFINER`, service_role only. Later tasks' TypeScript import layer (Task 6) calls this RPC by name with exactly these parameters.

This is a direct mirror of `supabase/migrations/20260920120000_037_memory_v3_lifecycle_backfill_import.sql` (read that file first to confirm it still matches what's shown below — it has not been touched by any task today, so it should be unchanged), with these differences: scoped by `(user_id, conversation_id)` throughout instead of just `user_id`; writes into `memory_v3_dialogue_items`/`_evidence` instead of the lifecycle tables; item shape has 13 keys (adds `topic`) instead of 12, since `memory_v3_dialogue_items` already has the `topic` column from today's earlier work; `profile_id`/`pipeline_version`/`extractor_version`/`reconciler_version` check against the dialogue-scope constants; the audit table's uniqueness is per `(user_id, conversation_id)`, not per `user_id` alone (a user can have many conversations, each importable once); and `p_expected_state_revision` is no longer hardcoded to `0` — unlike the lifecycle original, this RPC is allowed to overwrite a conversation that already has live data, so it accepts whatever revision the conversation actually had when the paid run observed it, and only rejects the import if the conversation's current revision no longer matches that (see Task 4/5/6 for where this value is captured and threaded through).

- [ ] **Step 1: Write the migration**

```sql
-- Atomic, service-role-only initial import of a reviewed Memory V3
-- dialogue-scope historical backfill artifact, one conversation at a
-- time. Mirrors 037_memory_v3_lifecycle_backfill_import.sql's
-- lifecycle-scope function exactly in structure and validation rigor,
-- scoped by (user_id, conversation_id) instead of just user_id, and
-- with topic as a 13th required item key (memory_v3_dialogue_items
-- already has the topic column from today's earlier work, so this is
-- built correctly from the start -- no separate before/after patch
-- needed the way the lifecycle apply-state RPC needed one in 045).
--
-- Unlike the lifecycle original, which hardcodes an empty-only starting
-- state (p_expected_state_revision = 0), this one is allowed to
-- overwrite a conversation that already has live data -- Настя
-- explicitly asked for full reprocessing rather than skipping already-
-- active conversations (2026-09-24). It guards only against a narrow
-- race: the conversation's actual current revision must still match
-- whatever revision was observed right before the paid run started.

CREATE TABLE public.memory_v3_dialogue_backfill_imports (
  import_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  artifact_digest text NOT NULL UNIQUE CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_cutoff timestamptz NOT NULL,
  profile_id text NOT NULL CHECK (profile_id = 'memory-v3-dialogue-history-backfill-v1'),
  schema_version text NOT NULL CHECK (schema_version = 'memory-v3-dialogue-state-v1'),
  pipeline_version text NOT NULL CHECK (pipeline_version = 'memory-v3-dialogue-v1'),
  extractor_version text NOT NULL CHECK (extractor_version = 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2'),
  reconciler_version text NOT NULL CHECK (reconciler_version = 'memory-v3-dialogue-reconciler-v1'),
  expected_state_revision bigint NOT NULL CHECK (expected_state_revision >= 0),
  resulting_state_revision bigint NOT NULL CHECK (resulting_state_revision >= 1),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  evidence_count integer NOT NULL CHECK (evidence_count BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, conversation_id)
);

ALTER TABLE public.memory_v3_dialogue_backfill_imports ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.import_memory_v3_dialogue_backfill_state(
  p_import_id uuid,
  p_user_id uuid,
  p_conversation_id uuid,
  p_expected_state_revision bigint,
  p_artifact_digest text,
  p_source_snapshot_digest text,
  p_source_cutoff timestamptz,
  p_profile_id text,
  p_pipeline_version text,
  p_extractor_version text,
  p_reconciler_version text,
  p_state jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_date_pattern CONSTANT text := '^(0[1-9][0-9]{2}|[1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$';
  v_datetime_pattern CONSTANT text := '^(0[1-9][0-9]{2}|[1-9][0-9]{3})-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,9})?)?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$';
BEGIN
  IF p_import_id IS NULL
    OR p_user_id IS NULL
    OR p_conversation_id IS NULL
    OR p_expected_state_revision < 0
    OR p_artifact_digest IS NULL
    OR p_artifact_digest !~ '^[0-9a-f]{64}$'
    OR p_source_snapshot_digest IS NULL
    OR p_source_snapshot_digest !~ '^[0-9a-f]{64}$'
    OR p_source_cutoff IS NULL
    OR p_profile_id IS DISTINCT FROM 'memory-v3-dialogue-history-backfill-v1'
    OR p_pipeline_version IS DISTINCT FROM 'memory-v3-dialogue-v1'
    OR p_extractor_version IS DISTINCT FROM 'memory-v3-openrouter-gemini-3.7-flash-shadow-v2'
    OR p_reconciler_version IS DISTINCT FROM 'memory-v3-dialogue-reconciler-v1'
  THEN
    RAISE EXCEPTION 'invalid dialogue backfill import';
  END IF;

  IF pg_catalog.jsonb_typeof(p_state) IS DISTINCT FROM 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_state)) <> 6
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(p_state) AS state_key
      WHERE state_key <> ALL (ARRAY[
        'schemaVersion', 'userId', 'conversationId', 'stateRevision', 'nextMemoryOrdinal', 'items'
      ]::text[])
    )
    OR p_state->>'schemaVersion' IS DISTINCT FROM 'memory-v3-dialogue-state-v1'
    OR p_state->>'userId' IS DISTINCT FROM p_user_id::text
    OR p_state->>'conversationId' IS DISTINCT FROM p_conversation_id::text
    OR pg_catalog.jsonb_typeof(p_state->'stateRevision') IS DISTINCT FROM 'number'
    OR (p_state->>'stateRevision') !~ '^[0-9]+$'
    OR (p_state->>'stateRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR pg_catalog.jsonb_typeof(p_state->'nextMemoryOrdinal') IS DISTINCT FROM 'number'
    OR (p_state->>'nextMemoryOrdinal') !~ '^[0-9]+$'
    OR (p_state->>'nextMemoryOrdinal')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR pg_catalog.jsonb_typeof(p_state->'items') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF v_item_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item
    WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(item)) <> 13
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(item) AS item_key
        WHERE item_key <> ALL (ARRAY[
          'memoryKey', 'kind', 'claim', 'status', 'sensitivity', 'eventTimeStart',
          'eventTimeEnd', 'alternative', 'topic', 'firstSeenAt', 'updatedAt', 'revision', 'evidence'
        ]::text[])
      )
      OR pg_catalog.jsonb_typeof(item->'memoryKey') IS DISTINCT FROM 'string'
      OR item->>'memoryKey' !~ '^[0-9a-f]{64}$'
      OR pg_catalog.jsonb_typeof(item->'kind') IS DISTINCT FROM 'string'
      OR item->>'kind' NOT IN ('event', 'recurrence', 'hypothesis')
      OR pg_catalog.jsonb_typeof(item->'claim') IS DISTINCT FROM 'string'
      OR pg_catalog.length(pg_catalog.btrim(item->>'claim')) = 0
      OR pg_catalog.jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(item->'sensitivity') IS DISTINCT FROM 'string'
      OR item->>'sensitivity' NOT IN ('normal', 'sensitive')
      OR (
        (item->>'kind' = 'event' AND item->>'status' IN ('active', 'corrected', 'rejected'))
        OR (item->>'kind' = 'recurrence' AND item->>'status' IN ('candidate', 'active', 'stale', 'rejected'))
        OR (item->>'kind' = 'hypothesis' AND item->>'status' IN ('candidate', 'supported', 'stale', 'rejected'))
      ) IS DISTINCT FROM true
      OR (
        (item->>'kind' = 'hypothesis'
          AND pg_catalog.jsonb_typeof(item->'alternative') = 'string'
          AND pg_catalog.length(pg_catalog.btrim(item->>'alternative')) > 0)
        OR (item->>'kind' <> 'hypothesis' AND item->'alternative' = 'null'::jsonb)
      ) IS DISTINCT FROM true
      OR (
        item->'topic' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(item->'topic') = 'string'
          AND item->>'topic' IN ('person', 'fact', 'preference'))
      ) IS DISTINCT FROM true
      OR (
        item->'eventTimeStart' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(item->'eventTimeStart') = 'string'
          AND (item->>'eventTimeStart' ~ v_date_pattern
            OR item->>'eventTimeStart' ~ v_datetime_pattern))
      ) IS DISTINCT FROM true
      OR (
        item->'eventTimeEnd' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(item->'eventTimeEnd') = 'string'
          AND (item->>'eventTimeEnd' ~ v_date_pattern
            OR item->>'eventTimeEnd' ~ v_datetime_pattern))
      ) IS DISTINCT FROM true
      OR (item->'eventTimeStart' <> 'null'::jsonb
        AND pg_catalog.date_part('epoch', (item->>'eventTimeStart')::timestamptz) IS NULL)
      OR (item->'eventTimeEnd' <> 'null'::jsonb
        AND pg_catalog.date_part('epoch', (item->>'eventTimeEnd')::timestamptz) IS NULL)
      OR (item->'eventTimeStart' <> 'null'::jsonb
        AND item->'eventTimeEnd' <> 'null'::jsonb
        AND (CASE WHEN item->>'eventTimeStart' ~ v_date_pattern
          THEN (item->>'eventTimeStart')::date::timestamp AT TIME ZONE 'UTC'
          ELSE (item->>'eventTimeStart')::timestamptz END)
          > (CASE WHEN item->>'eventTimeEnd' ~ v_date_pattern
          THEN (item->>'eventTimeEnd')::date::timestamp AT TIME ZONE 'UTC'
          ELSE (item->>'eventTimeEnd')::timestamptz END))
      OR pg_catalog.jsonb_typeof(item->'firstSeenAt') IS DISTINCT FROM 'string'
      OR item->>'firstSeenAt' !~ v_datetime_pattern
      OR pg_catalog.jsonb_typeof(item->'updatedAt') IS DISTINCT FROM 'string'
      OR item->>'updatedAt' !~ v_datetime_pattern
      OR (item->>'updatedAt')::timestamptz < (item->>'firstSeenAt')::timestamptz
      OR pg_catalog.jsonb_typeof(item->'revision') IS DISTINCT FROM 'number'
      OR (item->>'revision') !~ '^[0-9]+$'
      OR (item->>'revision')::numeric NOT BETWEEN 1 AND 9007199254740991
      OR pg_catalog.jsonb_typeof(item->'evidence') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(item->'evidence') < 1
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item
    GROUP BY item->>'memoryKey'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  SELECT COALESCE(pg_catalog.sum(
    pg_catalog.jsonb_array_length(item->'evidence')
  ), 0::bigint)::integer
  INTO v_evidence_count
  FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item;
  IF v_evidence_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
      pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
    WHERE pg_catalog.jsonb_typeof(evidence) IS DISTINCT FROM 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(evidence)) <> 7
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(evidence) AS evidence_key
        WHERE evidence_key <> ALL (ARRAY[
          'conversationId', 'sourceMessageId', 'relation', 'supportType',
          'episodeKey', 'provenanceRole', 'mentionTime'
        ]::text[])
      )
      OR pg_catalog.jsonb_typeof(evidence->'conversationId') IS DISTINCT FROM 'string'
      OR evidence->>'conversationId' IS DISTINCT FROM p_conversation_id::text
      OR pg_catalog.jsonb_typeof(evidence->'sourceMessageId') IS DISTINCT FROM 'string'
      OR evidence->>'sourceMessageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR pg_catalog.jsonb_typeof(evidence->'relation') IS DISTINCT FROM 'string'
      OR evidence->>'relation' NOT IN ('supports', 'contradicts', 'corrects', 'rejects')
      OR pg_catalog.jsonb_typeof(evidence->'provenanceRole') IS DISTINCT FROM 'string'
      OR evidence->>'provenanceRole' IS DISTINCT FROM 'user'
      OR pg_catalog.jsonb_typeof(evidence->'mentionTime') IS DISTINCT FROM 'string'
      OR evidence->>'mentionTime' !~ v_datetime_pattern
      OR (
        (item->>'kind' = 'recurrence' AND evidence->>'relation' = 'supports'
          AND evidence->>'supportType' = 'episode_observation'
          AND pg_catalog.jsonb_typeof(evidence->'episodeKey') = 'string'
          AND pg_catalog.length(pg_catalog.btrim(evidence->>'episodeKey')) > 0)
        OR (item->>'kind' = 'recurrence' AND evidence->>'relation' = 'supports'
          AND evidence->>'supportType' IN ('pattern_confirmation', 'scope_boundary')
          AND evidence->'episodeKey' = 'null'::jsonb)
        OR (NOT (item->>'kind' = 'recurrence' AND evidence->>'relation' = 'supports')
          AND evidence->'supportType' = 'null'::jsonb
          AND pg_catalog.jsonb_typeof(evidence->'episodeKey') = 'string'
          AND pg_catalog.length(pg_catalog.btrim(evidence->>'episodeKey')) > 0)
      ) IS DISTINCT FROM true
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
      pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
    GROUP BY item->>'memoryKey', evidence->>'conversationId',
      evidence->>'sourceMessageId', evidence->>'relation'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
      WHERE evidence->>'relation' = CASE item->>'status'
        WHEN 'active' THEN 'supports'
        WHEN 'candidate' THEN 'supports'
        WHEN 'supported' THEN 'supports'
        WHEN 'corrected' THEN 'corrects'
        WHEN 'stale' THEN 'contradicts'
        WHEN 'rejected' THEN 'rejects'
      END
    )
      OR (
        item->>'kind' = 'recurrence'
        AND item->>'status' IN ('candidate', 'active')
        AND (
          SELECT pg_catalog.count(DISTINCT evidence->>'episodeKey')
          FROM pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
          WHERE evidence->>'relation' = 'supports'
            AND evidence->>'supportType' = 'episode_observation'
        ) < CASE WHEN item->>'status' = 'active' THEN 2 ELSE 1 END
      )
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
      pg_catalog.jsonb_array_elements(item->'evidence') AS evidence
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
        AND m.sender = 'user'
        AND m.created_at = (evidence->>'mentionTime')::timestamptz
        AND m.created_at <= p_source_cutoff
    )
  ) THEN
    RAISE EXCEPTION 'invalid dialogue backfill evidence' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.memory_v3_dialogue_heads(user_id, conversation_id)
  VALUES (p_user_id, p_conversation_id)
  ON CONFLICT (user_id, conversation_id) DO NOTHING;

  SELECT * INTO v_head
  FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dialogue backfill head is missing';
  END IF;

  IF v_head.state_revision <> p_expected_state_revision
    OR EXISTS (
      SELECT 1 FROM public.memory_v3_dialogue_backfill_imports
      WHERE user_id = p_user_id AND conversation_id = p_conversation_id
    )
    OR EXISTS (
      SELECT 1 FROM public.memory_v3_dialogue_backfill_imports
      WHERE artifact_digest = p_artifact_digest
    )
  THEN
    RAISE EXCEPTION 'dialogue backfill import conflict: conversation changed since the paid run, or this conversation/artifact was already imported';
  END IF;

  DELETE FROM public.memory_v3_dialogue_items
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  INSERT INTO public.memory_v3_dialogue_items(
    user_id, conversation_id, memory_key, kind, claim, status, sensitivity,
    event_time_start, event_time_end, alternative, topic, first_seen_at, updated_at, revision
  )
  SELECT p_user_id, p_conversation_id, item->>'memoryKey', item->>'kind', item->>'claim',
    item->>'status', item->>'sensitivity', item->>'eventTimeStart',
    item->>'eventTimeEnd', item->>'alternative', item->>'topic',
    (item->>'firstSeenAt')::timestamptz,
    (item->>'updatedAt')::timestamptz,
    (item->>'revision')::bigint
  FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item;

  INSERT INTO public.memory_v3_dialogue_evidence(
    user_id, conversation_id, memory_key, source_message_id, relation,
    support_type, episode_key, provenance_role, mention_time
  )
  SELECT p_user_id, p_conversation_id, item->>'memoryKey',
    (evidence->>'sourceMessageId')::uuid,
    evidence->>'relation', evidence->>'supportType', evidence->>'episodeKey',
    evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
  FROM pg_catalog.jsonb_array_elements(p_state->'items') AS item,
    pg_catalog.jsonb_array_elements(item->'evidence') AS evidence;

  UPDATE public.memory_v3_dialogue_heads
  SET state_revision = (p_state->>'stateRevision')::bigint,
    next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
    updated_at = pg_catalog.now()
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  INSERT INTO public.memory_v3_dialogue_backfill_imports(
    import_id, user_id, conversation_id, artifact_digest, source_snapshot_digest, source_cutoff,
    profile_id, schema_version, pipeline_version, extractor_version,
    reconciler_version, expected_state_revision, resulting_state_revision,
    item_count, evidence_count
  )
  VALUES (
    p_import_id, p_user_id, p_conversation_id, p_artifact_digest, p_source_snapshot_digest,
    p_source_cutoff, p_profile_id, p_state->>'schemaVersion', p_pipeline_version,
    p_extractor_version, p_reconciler_version, p_expected_state_revision,
    (p_state->>'stateRevision')::bigint, v_item_count, v_evidence_count
  );

  result := 'succeeded';
  resulting_state_revision := (p_state->>'stateRevision')::bigint;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON TABLE public.memory_v3_dialogue_backfill_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memory_v3_dialogue_backfill_imports FROM service_role;
GRANT SELECT, INSERT ON TABLE public.memory_v3_dialogue_backfill_imports TO service_role;

REVOKE ALL ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) FROM service_role;
GRANT EXECUTE ON FUNCTION public.import_memory_v3_dialogue_backfill_state(
  uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb
) TO service_role;
```

- [ ] **Step 2: Write the structural test**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260924150000_050_memory_v3_dialogue_backfill_import.sql"),
  "utf8",
);

describe("Memory V3 dialogue backfill import migration", () => {
  it("creates the audit table with a per-conversation uniqueness constraint, not per-user", () => {
    assert.match(sql, /CREATE TABLE public\.memory_v3_dialogue_backfill_imports/);
    assert.match(sql, /UNIQUE \(user_id, conversation_id\)/);
    assert.equal(/artifact_digest text NOT NULL UNIQUE.*\n.*user_id uuid NOT NULL UNIQUE/s.test(sql), false);
  });

  it("requires exactly 13 item keys, including topic with the dialogue enum", () => {
    assert.match(sql, /jsonb_object_keys\(item\)\) <> 13/);
    assert.match(sql, /'memoryKey', 'kind', 'claim', 'status', 'sensitivity', 'eventTimeStart',\s*\n\s*'eventTimeEnd', 'alternative', 'topic', 'firstSeenAt', 'updatedAt', 'revision', 'evidence'/);
    assert.match(sql, /item->>'topic' IN \('person', 'fact', 'preference'\)/);
  });

  it("checks dialogue-scope version constants, not lifecycle ones", () => {
    assert.match(sql, /p_profile_id IS DISTINCT FROM 'memory-v3-dialogue-history-backfill-v1'/);
    assert.match(sql, /p_pipeline_version IS DISTINCT FROM 'memory-v3-dialogue-v1'/);
    assert.match(sql, /p_reconciler_version IS DISTINCT FROM 'memory-v3-dialogue-reconciler-v1'/);
    assert.equal(/lifecycle/i.test(sql.replace(/-- .*/g, "")), false);
  });

  it("scopes the head lookup, item count, and delete by both user_id and conversation_id", () => {
    assert.match(sql, /FROM public\.memory_v3_dialogue_heads\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id\s*\n\s*FOR UPDATE/);
    assert.match(sql, /DELETE FROM public\.memory_v3_dialogue_items\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id/);
  });

  it("scopes evidence rows' conversationId to the target conversation, not any conversation the user owns", () => {
    assert.match(sql, /evidence->>'conversationId' IS DISTINCT FROM p_conversation_id::text/);
  });

  it("gates re-import on a revision-match race check, not on emptiness", () => {
    assert.match(sql, /v_head\.state_revision <> p_expected_state_revision/);
    assert.equal(/state_revision <> 0/.test(sql), false);
    assert.equal(/v_existing_item_count/.test(sql), false);
  });

  it("grants EXECUTE to service_role only", () => {
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.import_memory_v3_dialogue_backfill_state\(/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.import_memory_v3_dialogue_backfill_state\(\s*\n\s*uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb\s*\n\s*\) FROM PUBLIC, anon, authenticated;/);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/dialogueBackfillImportMigration.cases.test.ts`
Expected: 7/7 pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260924150000_050_memory_v3_dialogue_backfill_import.sql supabase/functions/_shared/memoryV3/dialogueBackfillImportMigration.cases.test.ts
git commit -m "feat: add the Memory V3 dialogue-scope historical backfill import RPC

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Fork `dialogue-history-backfill-contract.ts`

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-contract.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `prepareDialogueHistoryBackfill(input: { profileId: unknown; snapshot: unknown }): PreparedDialogueHistoryBackfill`, `canonicalDialogueHistoryDigest(value: unknown): string`, types `DialogueHistoryConversationInput`, `DialogueHistoryPreparedChunk`, `DialogueHistoryBackfillManifest`, `PreparedDialogueHistoryBackfill`. Task 4 (engine) and Task 5 (CLI) import these directly. `DialogueHistoryPreparedChunk` keeps the exact same field set as `LifecycleHistoryPreparedChunk` (including `conversationId`/`conversationOrdinal`/`chunkOrdinal` — these already exist on the lifecycle version and are reused as-is, since per-conversation chunk identity was already tracked there, just never used to reset state).

Read `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.ts` in full first (617 lines) to confirm it still matches what you find below before forking — it has not been touched by any task today.

- [ ] **Step 1: Create the fork**

Copy `lifecycle-history-backfill-contract.ts` to `dialogue-history-backfill-contract.ts` and apply exactly these renames throughout the file (a global find-and-replace covers all of them; there is no other change to any logic, comment, or structure):

| Find | Replace |
|---|---|
| `LifecycleHistoryConversationInput` | `DialogueHistoryConversationInput` |
| `LifecycleHistorySourceSnapshotInput` | `DialogueHistorySourceSnapshotInput` |
| `LifecycleHistoryPreparedChunk` | `DialogueHistoryPreparedChunk` |
| `LifecycleHistoryBackfillManifest` | `DialogueHistoryBackfillManifest` |
| `PreparedLifecycleHistoryBackfill` | `PreparedDialogueHistoryBackfill` |
| `prepareLifecycleHistoryBackfill` | `prepareDialogueHistoryBackfill` |
| `canonicalLifecycleHistoryDigest` | `canonicalDialogueHistoryDigest` |
| `LifecycleHistoryBackfillProfile` | `DialogueHistoryBackfillProfile` (this type does not exist yet — Task 3's fork of `-profile.ts` does NOT happen, since `-profile.ts` is reused unchanged per the Global Constraints; instead, keep importing the REAL, unchanged `LifecycleHistoryBackfillProfile`/`getLifecycleHistoryBackfillProfile`/`LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID` from `./lifecycle-history-backfill-profile.ts` verbatim — do NOT rename these three identifiers, they stay exactly as they are in the original file, imported from the same unforked `lifecycle-history-backfill-profile.ts`)
- The one string literal `'memory-v3-lifecycle-history-manifest-v1'` (schema version, appears once in the `LifecycleHistoryBackfillManifest`/now `DialogueHistoryBackfillManifest` interface's `schemaVersion` field type, and once more in `projectManifest`'s returned object literal) | `'memory-v3-dialogue-history-manifest-v1'`
- The error message string `'[memory-v3:lifecycle-history-backfill-contract] source is invalid'` | `'[memory-v3:dialogue-history-backfill-contract] source is invalid'`
- The error name `'MemoryV3LifecycleHistoryBackfillContractError'` | `'MemoryV3DialogueHistoryBackfillContractError'`

Do NOT rename anything else — every function name (`projectRecord`, `projectDenseArray`, `parseDateTimeNanoseconds`, `compareDateTimes`, `compareStrings`, `compareMessages`, `cloneJsonValue`, `digestCanonicalTrusted`, `validateAndCloneSourceSnapshot`, `canonicalizeConversations`, `serializeExtractorRequest`, `chunkOneConversation`, `comparePreparedChunks`, `projectManifest`, `deepFreeze`, `boundary`, `makeError`, `fail`), every constant (`INPUT_FIELDS`, `SNAPSHOT_FIELDS`, `CONVERSATION_FIELDS`, `MESSAGE_FIELDS`, `UUID`, `DATE_TIME`, `OWN_ERRORS`, `ERROR_TOKENS`), and every import from `../../supabase/functions/_shared/memoryV3/{contract,messages,prompt}.ts` stays exactly as-is — those modules are already scope-agnostic and shared by both the lifecycle and dialogue extraction paths.

- [ ] **Step 2: Write the test**

Read `scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts` in full first to see its exact fixture-building helpers and assertion style, then write `dialogue-history-backfill-contract.test.ts` as its mirror: same test cases (a normal multi-conversation snapshot chunks correctly, chunk boundaries respect `maxMessagesPerChunk` and `maxExtractorRequestBytes`, a conversation with zero user messages fails the whole preparation, duplicate message/conversation IDs are rejected, messages after the cutoff are rejected), importing from `./dialogue-history-backfill-contract.ts` instead of the lifecycle file, and asserting `schemaVersion === 'memory-v3-dialogue-history-manifest-v1'` wherever the lifecycle test asserts the lifecycle schema version string. Do not invent new test cases beyond what the lifecycle test already covers — this task is verifying the fork behaves identically, not adding new coverage (Task 4 is where new per-conversation-grouping coverage belongs, since that's where new behavior actually lives).

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts`
Expected: same pass count as `npx tsx --test scripts/memory-v3-pilot/lifecycle-history-backfill-contract.test.ts` (run both, compare counts explicitly in your report).

- [ ] **Step 4: Run the full `scripts/memory-v3-pilot` suite to confirm nothing regressed**

Run: `npx tsx --test scripts/memory-v3-pilot/*.test.ts`
Expected: every pre-existing lifecycle test still passes at its pre-task count (compare against a `git stash` baseline of this task's own diff), plus the new dialogue contract tests passing. This directory silently broke once already this week from an unrelated change — do not skip this check.

- [ ] **Step 5: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-contract.ts scripts/memory-v3-pilot/dialogue-history-backfill-contract.test.ts
git commit -m "feat: fork the history-backfill chunk/manifest contract for dialogue scope

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Fork `dialogue-history-backfill-provider.ts`

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-provider.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks in this plan (imports the already-shipped `createMemoryV3DialogueOpenRouterAdapter` from `supabase/functions/_shared/memoryV3/dialogueTransport.ts`, and the unchanged `lifecycle-history-backfill-profile.ts`).
- Produces: `createDialogueHistoryRoutedAdapters(input: { apiKey: string; fetchImpl: typeof fetch }): { extractorAdapter: DialogueHistoryExtractorAdapter; reconcilerAdapter: DialogueHistoryReconcilerAdapter }`, types `DialogueHistoryExtractorResult`, `DialogueHistoryReconcilerResult`, `DialogueHistoryExtractorAdapter`, `DialogueHistoryReconcilerAdapter`. Task 5 (CLI) calls `createDialogueHistoryRoutedAdapters` directly.

Read `scripts/memory-v3-pilot/lifecycle-history-backfill-provider.ts` in full first (359 lines) — you already read this file once today for an unrelated fix, but re-read it now since this task depends on its exact current shape.

- [ ] **Step 1: Create the fork**

Copy `lifecycle-history-backfill-provider.ts` to `dialogue-history-backfill-provider.ts` and apply these renames:

| Find | Replace |
|---|---|
| `LifecycleHistoryExtractorResult` | `DialogueHistoryExtractorResult` |
| `LifecycleHistoryReconcilerResult` | `DialogueHistoryReconcilerResult` |
| `LifecycleHistoryExtractorAdapter` | `DialogueHistoryExtractorAdapter` |
| `LifecycleHistoryReconcilerAdapter` | `DialogueHistoryReconcilerAdapter` |
| `createLifecycleHistoryRoutedAdapters` | `createDialogueHistoryRoutedAdapters` |
| `MemoryV3LifecycleTransportResult` | `MemoryV3DialogueTransportResult` (change the import source too, see below) |
| `MemoryV3LifecycleModelAdapter` | `MemoryV3DialogueModelAdapter` (change the import source too, see below) |
| `createMemoryV3LifecycleOpenRouterAdapter` | `createMemoryV3DialogueOpenRouterAdapter` |
| `'[memory-v3:lifecycle-history-provider] value is invalid'` | `'[memory-v3:dialogue-history-provider] value is invalid'` |
| `'MemoryV3LifecycleHistoryProviderError'` | `'MemoryV3DialogueHistoryProviderError'` |

Change the import line
```typescript
import {
  createMemoryV3LifecycleOpenRouterAdapter,
  type MemoryV3LifecycleModelAdapter,
  type MemoryV3LifecycleTransportResult,
} from '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts';
```
to
```typescript
import {
  createMemoryV3DialogueOpenRouterAdapter,
  type MemoryV3DialogueModelAdapter,
  type MemoryV3DialogueTransportResult,
} from '../../supabase/functions/_shared/memoryV3/dialogueTransport.ts';
```
(Confirm `dialogueTransport.ts` exports exactly `createMemoryV3DialogueOpenRouterAdapter`, `MemoryV3DialogueModelAdapter`, and `MemoryV3DialogueTransportResult` by reading its exports before assuming these three names — they were shipped earlier today and should mirror `lifecycleTransport.ts`'s equivalents exactly, but confirm rather than assume.)

Everything else — `OPENROUTER_URL`, `TIMEOUT_MS`, `MAX_RESPONSE_BYTES`, `CONFIG_FIELDS`, `INIT_FIELDS`, `HEADER_FIELDS`, `PROVIDER_FIELDS`, every function (`makeError`, `fail`, `boundary`, `projectRecord`, `parseRequestBody`, `assertHeaders`, `rewriteBody`, `projectResolvedModel`, `parseResolvedModel`, `readRawResponse`, `createObserver`, `wrapExtractor`, `wrapReconciler`), and the `LIFECYCLE_HISTORY_*` constants imported from `lifecycle-history-backfill-profile.ts` (`LIFECYCLE_HISTORY_BACKFILL_MAX_OUTPUT_TOKENS_PER_CALL`, `LIFECYCLE_HISTORY_MODEL_ROUTE`, `LIFECYCLE_HISTORY_PRIMARY_MODEL`, `LifecycleHistoryResolvedModel`) stay exactly as-is, imported from the same unforked profile file — the model routing/pricing/fallback logic is identical regardless of which memory scope the extracted facts end up in.

- [ ] **Step 2: Write the test**

Read `scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts` (if it exists — check with `ls scripts/memory-v3-pilot/lifecycle-history-backfill-provider.test.ts`; if no dedicated test file exists for the provider, check how `lifecycle-history-backfill-cli.test.ts` or `lifecycle-history-backfill-run.test.ts`-equivalent tests exercise `createLifecycleHistoryRoutedAdapters` indirectly, and mirror THAT pattern instead) and mirror it for the dialogue fork: a fake `fetchImpl` that returns a canned OpenRouter-shaped response, asserting the wrapped extractor/reconciler adapters correctly extract `resolvedModel` and reject a call that doesn't match the expected model route.

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts`
Expected: pass, same count as whatever the lifecycle equivalent's test coverage was.

- [ ] **Step 4: Run the full `scripts/memory-v3-pilot` suite**

Run: `npx tsx --test scripts/memory-v3-pilot/*.test.ts`
Expected: no regressions in any pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-provider.ts scripts/memory-v3-pilot/dialogue-history-backfill-provider.test.ts
git commit -m "feat: fork the history-backfill OpenRouter provider for dialogue scope

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Fork `dialogue-history-backfill-engine.ts` — per-conversation state grouping

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-engine.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts`

**Interfaces:**
- Consumes: `PreparedDialogueHistoryBackfill`/`DialogueHistoryPreparedChunk` from Task 2, `DialogueHistoryExtractorAdapter`/`DialogueHistoryReconcilerAdapter` from Task 3, `applyMemoryV3DialogueStep`/`createEmptyMemoryV3DialogueState` from `dialogueReducer.ts`, `validateMemoryV3DialogueProposal`/`validateMemoryV3DialogueState`/`MemoryV3DialogueState` from `dialogueContract.ts`, `buildMemoryV3DialogueReconcileRequest` from `dialoguePrompt.ts` (all already shipped and live — read each file's actual exports before assuming exact names, though these were all confirmed today during the topic-classification work), and a new `conversationRevisions: ReadonlyMap<string, number>` input (conversationId → the conversation's current dialogue-state revision, as observed by Task 5's CLI immediately before this run starts, `0` for a conversation that was empty). The engine never queries the database itself for this — it only carries the value through, mirroring how it already carries `prepared` through without touching the DB directly.
- Produces: `runDialogueHistoryBackfill(input: {...}): Promise<DialogueHistoryBackfillResult>`, where `DialogueHistoryBackfillResult` now has a `conversations: Array<{ conversationId: string; conversationOrdinal: number; expectedStateRevision: number; attemptedChunkCount: number; successChunkCount: number; failureCount: number; finalState: MemoryV3DialogueState | null; chunks: [...]; failures: [...] }>` array INSTEAD of the lifecycle version's single flat `finalState`/`chunks`/`failures`/`attemptedChunkCount`/`successChunkCount`/`failureCount` — this is the one real interface shape change from the lifecycle original, needed because there are now many independent per-conversation results instead of one account-wide result. `expectedStateRevision` is just the matching value copied out of the `conversationRevisions` input map (see Consumes above) — the engine doesn't compute or validate it, it echoes it so Task 6's import step later knows what revision to expect unchanged. Task 5 (CLI), Task 6 (import), Task 7 (approval generator), and Task 8 (report generator) all consume this per-conversation array shape — use this exact field name (`conversations`) and structure in all of them.

This is the task with the plan's core architectural change. Read `scripts/memory-v3-pilot/lifecycle-history-backfill-engine.ts` in full first (1053 lines) — you already read this file in full today, re-read it now to have it fresh, since this task's diff against it is substantial, not a pure rename.

- [ ] **Step 1: Copy and rename the file-level scaffolding**

Copy `lifecycle-history-backfill-engine.ts` to `dialogue-history-backfill-engine.ts`. Apply the same category of renames as Tasks 2-3 throughout (`LifecycleHistoryBackfillStage`→`DialogueHistoryBackfillStage`, `LifecycleHistoryBackfillResult`→`DialogueHistoryBackfillResult`, every `Lifecycle`-prefixed local type/error-name/message-string → `Dialogue`-prefixed, the imports from `lifecycleContract.ts`/`lifecyclePrompt.ts`/`lifecycleReducer.ts` → the dialogue equivalents, the import from `./lifecycle-history-backfill-contract.ts` → `./dialogue-history-backfill-contract.ts`, the import of `canonicalLifecycleHistoryDigest` → `canonicalDialogueHistoryDigest`). Keep the import of `calculateLifecycleHistoryBudget`/`getLifecycleHistoryBackfillProfile`/etc. from the UNFORKED `lifecycle-history-backfill-profile.ts` exactly as-is (same reasoning as Task 2/3 — this file is reused unchanged). Keep `canonicalStringify` imported from `./contracts.mjs` unchanged.

- [ ] **Step 2: Change `DialogueHistoryBackfillResult`'s shape to per-conversation**

Change the interface (originally `LifecycleHistoryBackfillResult`) from a single flat result to:

```typescript
export interface DialogueHistoryBackfillConversationResult {
  conversationId: string;
  conversationOrdinal: number;
  expectedStateRevision: number;
  attemptedChunkCount: number;
  successChunkCount: number;
  failureCount: number;
  finalState: MemoryV3DialogueState | null;
  chunks: Array<{
    chunkId: string;
    status: 'succeeded';
    changed: boolean;
    resultingStateRevision: number;
    itemCount: number;
    evidenceCount: number;
    transitionTypes: string[];
    extractorResolvedModel: DialogueHistoryResolvedModel;
    reconcilerResolvedModel: DialogueHistoryResolvedModel;
  }>;
  failures: Array<{
    chunkId: string;
    stage: DialogueHistoryBackfillStage;
    diagnosticCode: string;
  }>;
}

export interface DialogueHistoryBackfillResult {
  schemaVersion: 'memory-v3-dialogue-history-result-v1';
  profileId: 'memory-v3-dialogue-history-backfill-v1';
  model: 'google/gemini-3.7-flash';
  modelRoute: readonly [
    'google/gemini-3.7-flash',
    'mistralai/mistral-medium-3-5',
  ];
  manifest: DialogueHistoryBackfillManifest;
  priceSnapshot: LifecycleHistoryPriceSnapshot;
  budget: {
    maxRequests: number;
    reservedInputTokensPerCall: 32_768;
    maxOutputTokensPerCall: 4_096;
    ceilingUsd: string;
    hardMaxUsd: string;
    gate: 'PASS';
  };
  execute: boolean;
  conversations: DialogueHistoryBackfillConversationResult[];
  providerCallCount: number;
  providerModelFallbackCount: number;
  resolvedModelCounts: {
    primary: number;
    fallback: number;
  };
  maxActive: 1;
  retryCount: 0;
  repairCount: 0;
  fallbackCount: 0;
  actualUsage: { promptTokens: number; completionTokens: number } | null;
  actualCostUsd: number | null;
  semanticReview: { status: 'required' };
}
```

(`LifecycleHistoryPriceSnapshot`/`DialogueHistoryResolvedModel` — the price snapshot type stays imported from the unforked `lifecycle-history-backfill-profile.ts` unchanged; `DialogueHistoryResolvedModel` is the renamed `LifecycleHistoryResolvedModel` type, same values `LIFECYCLE_HISTORY_PRIMARY_MODEL`/`LIFECYCLE_HISTORY_FALLBACK_MODEL` reused unchanged from the same unforked profile file — only the TYPE alias name changes for readability in this file, the underlying string literal union is identical.)

- [ ] **Step 3: Rewrite the main loop to group by `conversationId` first**

The lifecycle original's `runLifecycleHistoryBackfill` has one loop: `for (const chunk of prepared.chunks) { ... state = ...(threaded across everything)... }`. Replace this with:

```typescript
  const chunksByConversation = new Map<number, DialogueHistoryPreparedChunk[]>();
  for (const chunk of prepared.chunks) {
    const bucket = chunksByConversation.get(chunk.conversationOrdinal);
    if (bucket) bucket.push(chunk);
    else chunksByConversation.set(chunk.conversationOrdinal, [chunk]);
  }
  for (const bucket of chunksByConversation.values()) {
    bucket.sort((left, right) => left.chunkOrdinal - right.chunkOrdinal);
  }
  const conversationOrdinals = [...chunksByConversation.keys()].sort((left, right) => left - right);

  const conversationResults: DialogueHistoryBackfillResult['conversations'] = [];
  for (const conversationOrdinal of conversationOrdinals) {
    const chunksForConversation = chunksByConversation.get(conversationOrdinal)!;
    const conversationId = chunksForConversation[0].conversationId;
    const expectedStateRevision = input.conversationRevisions.get(conversationId);
    if (expectedStateRevision === undefined) {
      throw makeError('reducer', 'missing_conversation_revision', `no captured state revision for conversation ${conversationId}`);
    }
    let state = createEmptyMemoryV3DialogueState({ userId: prepared.userId, conversationId });
    const chunkResults: DialogueHistoryBackfillConversationResult['chunks'] = [];
    const failures: DialogueHistoryBackfillConversationResult['failures'] = [];
    let attemptedChunkCount = 0;
    for (const chunk of chunksForConversation) {
      attemptedChunkCount += 1;
      try {
        // ... the exact same per-chunk body as the lifecycle original
        // (validateMemoryV3Dialogue, buildMemoryV3ExtractorRequest,
        // assertUtf8BytesAtMost, assertExtractorRequestDigest,
        // callExtractorOnce, parseJsonDataOnly, normalizeMemoryV3LayeredResponse,
        // buildMemoryV3DialogueReconcileRequest in place of the lifecycle
        // reconcile-request builder, callReconcilerOnce,
        // validateMemoryV3DialogueProposal in place of the lifecycle proposal
        // validator, applyMemoryV3DialogueStep in place of
        // applyMemoryV3LifecycleStep, validateMemoryV3DialogueState in place
        // of validateMemoryV3LifecycleState) -- copy that body verbatim from
        // the original per-chunk try block, substituting only the
        // dialogue-scope function names already established in this task's
        // Interfaces section, and using `state`/`chunkResults`/`failures`
        // (this conversation's own, not the account-wide ones).
      } catch (error) {
        const own = details(error);
        const stage = own?.stage ?? 'reducer';
        failures.push({
          chunkId: chunk.chunkId,
          stage,
          diagnosticCode: own?.code ?? 'reducer_invalid',
        });
        break;
      }
    }
    conversationResults.push({
      conversationId,
      conversationOrdinal,
      expectedStateRevision,
      attemptedChunkCount,
      successChunkCount: chunkResults.length,
      failureCount: failures.length,
      finalState: failures.length === 0 && chunkResults.length === chunksForConversation.length ? state : null,
      chunks: chunkResults,
      failures,
    });
  }
```

`buildMemoryV3LifecycleReconcileRequest({ userId, conversationId: chunk.conversationId, messages: chunk.messages, state, extraction })` in the original becomes `buildMemoryV3DialogueReconcileRequest({ userId: prepared.userId, conversationId, messages: chunk.messages, state, extraction })` — read `dialoguePrompt.ts`'s actual exported function signature first to confirm its exact parameter names before assuming this matches (it was built to mirror the lifecycle one exactly during today's earlier work, but confirm rather than assume). The `callExtractorOnce`/`callReconcilerOnce` closures, the `providerCallGate`, `usages`, `resolvedModelCounts`, and `successfulTransportCount` tracking stay OUTSIDE the per-conversation loop (shared across the whole run, since the cost ceiling and call-count budget are account-wide for this run, not per-conversation) — only the memory `state` itself resets per conversation.

The `throw makeError('reducer', 'missing_conversation_revision', ...)` guard added just before `let state = ...` is deliberately NOT caught by the per-chunk `try`/`catch` below it — a missing entry in `conversationRevisions` means Task 5's CLI failed to populate the map for every conversation present in `prepared.chunks`, which is a wiring bug, not a normal per-conversation failure a real run could hit. It aborts the whole `runDialogueHistoryBackfill` call, matching this project's standing preference for failing loud on broken invariants rather than degrading one conversation's result silently.

- [ ] **Step 4: Adjust `buildBaseResult` and the final result assembly**

`buildBaseResult`'s return type loses `attemptedChunkCount`/`successChunkCount`/`failureCount`/`finalState`/`chunks`/`failures` (now nested per-conversation) and the final `deepFreeze<DialogueHistoryBackfillResult>({...})` call spreads `conversations: conversationResults` instead of the lifecycle version's flat fields. The `execute: false` (dry-run) early-return branch returns `conversations: []` instead of the lifecycle version's `chunks: []`/`failures: []`/etc.

- [ ] **Step 5: Update `buildLifecycleHistoryReviewPacket`'s dialogue-scope equivalent**

Rename to `buildDialogueHistoryReviewPacket`. Its lifecycle version reads `benchmarkResult.finalState.items`/`failureCount`/`successChunkCount` directly off one flat result — for dialogue scope, it must iterate `benchmarkResult.conversations`, require EVERY conversation's `failureCount === 0` and `successChunkCount === manifest`'s chunk count for that conversation ordinal, and flatten all conversations' surviving `finalState.items` into one `items` array for the packet, but ALSO tag each item with which `conversationId` it came from (add a `conversationId` field to each packet item — the lifecycle packet item shape doesn't need this since it's all one account, but the dialogue version does, since Task 8's readable report needs to group by conversation). Keep the `payloadSha256` digest computation the same shape (hash over `{ benchmarkResult, items }`) but note it will now include the added `conversationId` per item, which is fine — the digest just needs to be internally consistent between this function and Task 6's `validateArtifact`-equivalent, which must expect the same added field.

- [ ] **Step 6: Write the test**

Read `lifecycle-history-backfill-engine.test.ts` in full first for its exact fixture-building helpers (fake extractor/reconciler adapters, a minimal synthetic `PreparedLifecycleHistoryBackfill`). Write `dialogue-history-backfill-engine.test.ts` mirroring its structure — every call to `runDialogueHistoryBackfill` now also needs a `conversationRevisions` map covering every conversation id present in the fixture's chunks (use `new Map([[conversationId, 0]])` for a fixture representing an empty conversation, unless a specific test needs a nonzero starting revision) — PLUS these new tests specific to the per-conversation behavior (per this plan's Review Focus section):

```typescript
it("keeps two conversations' states fully independent even when their chunks are interleaved in the input array", async () => {
  // Build a synthetic `prepared.chunks` array with chunks from TWO
  // conversationOrdinal values (0 and 1) placed in INTERLEAVED order
  // (e.g. [convo0-chunk0, convo1-chunk0, convo0-chunk1, convo1-chunk1]),
  // each conversation's chunks designed so a real extractor+reconciler
  // fake would create a distinct, identifiable item per conversation.
  // Run runDialogueHistoryBackfill with fake adapters that return
  // different canned claims depending on which conversationId is in the
  // request. Assert result.conversations has exactly 2 entries, each
  // with its OWN finalState containing only that conversation's own
  // item(s) -- not the other conversation's -- proving the engine
  // grouped by conversationOrdinal rather than assuming array adjacency.
});

it("fails only the affected conversation when one conversation has no user messages, not the whole run", async () => {
  // NOTE: verify this against the ACTUAL behavior of the reused
  // dialogue-history-backfill-contract.ts's chunkOneConversation first --
  // per this plan's Review Focus section, an all-assistant conversation
  // fails PREPARATION (in Task 2's contract fork), which happens BEFORE
  // this engine ever runs, so this specific engine-level test may not be
  // reachable that way. If preparation-time failure is confirmed to be
  // the actual behavior (matching the lifecycle original exactly), write
  // this test instead against `prepareDialogueHistoryBackfill` in
  // dialogue-history-backfill-contract.test.ts (Task 2) documenting that
  // a single bad conversation aborts the whole batch at the preparation
  // stage, and skip duplicating it here -- do not write a test asserting
  // behavior the code doesn't actually have.
});

it("throws and aborts the whole run if conversationRevisions is missing an entry for a conversation present in the chunks", async () => {
  // Build a synthetic prepared.chunks array with TWO conversations, but
  // pass a conversationRevisions map containing an entry for only ONE of
  // them. Assert runDialogueHistoryBackfill rejects (not: silently skips
  // the conversation with the missing entry) -- this is a wiring-bug
  // guard, not a normal per-conversation failure mode.
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts`
Expected: all pass, including the two new interleaving/isolation tests actually exercising the grouping logic (not passing vacuously — verify by temporarily reverting Step 3's grouping to a naive sequential-adjacency assumption and confirming the interleaving test fails, then restoring the correct code).

- [ ] **Step 8: Run the full `scripts/memory-v3-pilot` suite**

Run: `npx tsx --test scripts/memory-v3-pilot/*.test.ts`
Expected: no regressions.

- [ ] **Step 9: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-engine.ts scripts/memory-v3-pilot/dialogue-history-backfill-engine.test.ts
git commit -m "feat: fork the history-backfill engine with per-conversation state grouping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Fork `dialogue-history-backfill-cli.ts` + the per-conversation revision capture

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-cli.ts`
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-revision.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-revision.test.ts`

**Interfaces:**
- Consumes: `prepareDialogueHistoryBackfill`/`inspectLifecycleHistorySource` (this last one is REUSED, unforked, from `lifecycle-history-backfill-source.ts` per Global Constraints — it just reads raw conversation/message rows, nothing lifecycle-specific), `createDialogueHistoryRoutedAdapters` from Task 3, `runDialogueHistoryBackfill`/`buildDialogueHistoryReviewPacket` from Task 4.
- Produces: `runDialogueHistoryBackfillFromArgv(input: {...}): Promise<{...}>` (same shape as the lifecycle CLI's exported function, renamed), and one new standalone helper in `dialogue-history-backfill-revision.ts`: `captureConversationRevisions(conversationIds: readonly string[], readRevision: (conversationId: string) => Promise<number>): Promise<Map<string, number>>`. This captures, not filters — every conversation the source reader found gets an entry, none are ever excluded. Task 4's engine consumes the resulting map directly as its `conversationRevisions` input (see Task 4's Interfaces). Task 6 (import) reads each conversation's `expectedStateRevision` back out of the artifact (where Task 4 already echoed it per conversation) rather than calling this function again — this module's only job is the one-time capture right before the paid run.

Read `scripts/memory-v3-pilot/lifecycle-history-backfill-cli.ts` in full first (352 lines) — you already read this file in full today.

- [ ] **Step 1: Write `dialogue-history-backfill-revision.ts`**

```typescript
/** Captures each conversation's current dialogue-state revision right
 * before the paid run starts, so the import step can later verify
 * nothing changed in between (see dialogue-history-backfill-import.ts).
 * This never excludes a conversation -- Настя explicitly asked for every
 * conversation to be reprocessed, including ones that already have live
 * data (2026-09-24) -- it only records a number to check against later. */

export interface DialogueRevisionReader {
  (conversationId: string): Promise<number>;
}

export async function captureConversationRevisions(
  conversationIds: readonly string[],
  readRevision: DialogueRevisionReader,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const conversationId of conversationIds) {
    result.set(conversationId, await readRevision(conversationId));
  }
  return result;
}
```

- [ ] **Step 2: Write `dialogue-history-backfill-revision.test.ts`**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureConversationRevisions } from "./dialogue-history-backfill-revision.ts";

describe("dialogue history backfill revision capture", () => {
  it("calls the reader once per distinct conversation id and preserves each result", async () => {
    const calls: string[] = [];
    const map = await captureConversationRevisions(["x", "y"], async (id) => {
      calls.push(id);
      return id === "x" ? 0 : 7;
    });
    assert.deepEqual(calls, ["x", "y"]);
    assert.equal(map.get("x"), 0);
    assert.equal(map.get("y"), 7);
  });

  it("returns an empty map for an empty conversation id list without calling the reader", async () => {
    let calls = 0;
    const map = await captureConversationRevisions([], async () => {
      calls += 1;
      return 0;
    });
    assert.equal(calls, 0);
    assert.equal(map.size, 0);
  });
});
```

- [ ] **Step 3: Run the revision-capture tests**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-revision.test.ts`
Expected: 2/2 pass.

- [ ] **Step 4: Fork the CLI**

Copy `lifecycle-history-backfill-cli.ts` to `dialogue-history-backfill-cli.ts`. Apply the same rename category as prior tasks (`runLifecycleHistoryBackfillFromArgv`→`runDialogueHistoryBackfillFromArgv`, `LifecycleHistoryBackfillResult`→`DialogueHistoryBackfillResult`, `buildLifecycleHistoryReviewPacket`→`buildDialogueHistoryReviewPacket`, `runLifecycleHistoryBackfill`→`runDialogueHistoryBackfill`, `createLifecycleHistoryRoutedAdapters`→`createDialogueHistoryRoutedAdapters`, imports from the lifecycle contract/engine/provider files → the dialogue forks, error name/message strings → `dialogue`-flavored). Keep `getLifecycleHistoryBackfillProfile`/`validateLifecycleHistoryPriceSnapshot` imports from the unforked `lifecycle-history-backfill-profile.ts` unchanged. Keep `inspectLifecycleHistorySource`/`createLifecycleHistorySupabaseReader` imports from the unforked `lifecycle-history-backfill-source.ts` unchanged (these read raw rows, nothing scope-specific). Keep the existing `--source-cutoff`/`sourceCutoff` argv handling completely unchanged — it already lets whoever runs the tool freeze the message set at a fixed point in time (e.g. Настя could pass `2026-09-20T00:00:00.000Z` for her most active, still-growing conversation), and messages after that point are simply outside this run's scope rather than a source of instability; nothing about today's revision-capture change touches this mechanism.

Add the new revision-capture step: after `const prepared = await inspectLifecycleHistorySource({...})` succeeds (same call, reused source reader), before calling `runDialogueHistoryBackfill`, build a `readRevision` closure that queries `memory_v3_dialogue_heads` for the given `conversationId` (via the same `reader`'s underlying Supabase client — read how `createLifecycleHistorySupabaseReader` obtains its client in `lifecycle-history-backfill-source.ts` to access it the same way, do not open a second separate connection), returning `0` when no row exists yet for that conversation, otherwise its `state_revision` column. Call `captureConversationRevisions` from Task 5's own new revision module over every distinct `conversationId` found in `prepared.chunks`, and pass the resulting map as `runDialogueHistoryBackfill`'s `conversationRevisions` input — every conversation `prepared` found gets processed, none are filtered out.

- [ ] **Step 5: Write the CLI test**

Read `lifecycle-history-backfill-cli.test.ts` in full first for its exact fake-injection pattern (fake `sourceReader`, fake `readEnvText`, fake `fetchImpl`). Mirror it for the dialogue fork, PLUS a new test:

```typescript
it("captures each conversation's existing revision and still includes it in the run, even when the revision is nonzero", async () => {
  // Build a fake sourceReader returning two conversations. Build a fake
  // Supabase-client-shaped revision reader (matching whatever real
  // mechanism Step 4 settled on) that reports the first conversation at
  // revision 0 (never touched before) and the second at revision 4
  // (already has organic live data). Run in --execute-history-backfill-
  // paid-requests mode with fake extractor/reconciler adapters and
  // assert BOTH conversations appear in result.conversations, and the
  // second conversation's expectedStateRevision is 4, not 0 and not
  // excluded.
});
```

- [ ] **Step 6: Run the tests**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts`
Expected: pass, including the new revision-capture test.

- [ ] **Step 7: Run the full `scripts/memory-v3-pilot` suite**

Run: `npx tsx --test scripts/memory-v3-pilot/*.test.ts`
Expected: no regressions.

- [ ] **Step 8: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-cli.ts scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts scripts/memory-v3-pilot/dialogue-history-backfill-revision.ts scripts/memory-v3-pilot/dialogue-history-backfill-revision.test.ts
git commit -m "feat: fork the history-backfill CLI, capturing (not excluding) each conversation's revision

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Fork `dialogue-history-backfill-import.ts` + `-import-run.ts`

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-import.ts`
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-import-run.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts`

**Interfaces:**
- Consumes: Task 1's `import_memory_v3_dialogue_backfill_state` RPC (by name, called from the client wrapper), `MemoryV3DialogueState`/`MEMORY_V3_DIALOGUE_PIPELINE_VERSION`/`MEMORY_V3_DIALOGUE_RECONCILER_VERSION` from `dialogueContract.ts`, `validateMemoryV3DialogueState` from `dialogueContract.ts`, `DialogueHistoryBackfillResult`'s per-conversation shape from Task 4 (each conversation already carries its own `expectedStateRevision`, captured by Task 5 before the paid run — this task reads that value back out of the artifact, it does not recompute or re-derive it).
- Produces: `importReviewedDialogueHistory(input: {...}): Promise<{ status; results: Array<{ conversationId: string; status: 'succeeded' | 'rejected_state_changed'; ...}> }>`, `preflightReviewedDialogueHistoryFiles(input: {...})`. Task 8's report generator reads the per-conversation `status` field to list what actually happened, and `expectedStateRevision` (already on the artifact) to say whether existing records were replaced or the conversation started empty.

Read `scripts/memory-v3-pilot/lifecycle-history-backfill-import.ts` in full first (619 lines) — you already read this file in full today. Also re-read `scripts/memory-v3-pilot/lifecycle-history-backfill-import-run.ts` in full (270 lines) — also already read today.

- [ ] **Step 1: Fork `dialogue-history-backfill-import.ts`**

Copy `lifecycle-history-backfill-import.ts` to `dialogue-history-backfill-import.ts`. Apply the standard rename category. Key structural changes beyond renaming:

1. `LifecycleHistoryReviewDecision`/`validateDecision` — the lifecycle version's decision has ONE flat `items` array matching `artifact.state.items`. The dialogue version's artifact now has MULTIPLE conversations (Task 4's `conversations` array), each with its own `finalState.items` — change `validateDecision` to require the decision's `items` array to equal the FLATTENED concatenation of every successful conversation's `finalState.items`, in the same order Task 4's `buildDialogueHistoryReviewPacket` flattened them (conversation order, then item order within each conversation) — the ordering must match exactly what Task 7's approval-file generator produces, since that's the only thing that ever produces a decision file in practice.
2. `LifecycleHistoryImportClient`'s `loadCurrentHead(userId)` becomes `loadCurrentHead(userId, conversationId)`, returning that conversation's *actual current* `state_revision` (0 if the head row doesn't exist yet), querying `memory_v3_dialogue_heads` scoped by BOTH `user_id` and `conversation_id` (mirror the exact query shape from the real client factory at the bottom of `lifecycle-history-backfill-import-run.ts`, just add the `conversation_id` filter). Unlike the lifecycle version, this is read purely to compare against `expectedStateRevision` — it is never used to decide "should this be imported at all," only "has it changed since the paid run."
3. `importInitialState` becomes `importInitialState` taking an added `conversationId` field, calling `import_memory_v3_dialogue_backfill_state` (Task 1's RPC) with the added `p_conversation_id` parameter and `p_expected_state_revision` set to that conversation's `expectedStateRevision` from the artifact (NOT hardcoded to `0` — see Task 1's migration, which now accepts any non-negative starting revision and overwrites unconditionally once it matches).
4. `importReviewedLifecycleHistory` (main export) becomes `importReviewedDialogueHistory`, and its single `client.loadCurrentHead(userId)` + single `client.importInitialState(...)` + single return value become a LOOP over every conversation present in the artifact's `conversations` array (skipping any whose `finalState` was null, i.e. never succeeded in the paid run): for each conversation, call `loadCurrentHead(userId, conversationId)` and compare the result to that conversation's `expectedStateRevision` — if they don't match (the live incremental pipeline wrote something new to this exact conversation between the paid run and now), that conversation's result is `{ conversationId, status: 'rejected_state_changed' }` and the loop CONTINUES to the next conversation (does not abort the whole import, and does NOT overwrite the newer data it never saw) — otherwise call `importInitialState` for that conversation (which overwrites whatever was there, whether it started empty or not) and record `{ conversationId, status: 'succeeded', resultingStateRevision, itemCount, evidenceCount }`. Return `{ status: 'succeeded', results: [...] }` where `results` has one entry per attempted conversation. Note there is no "skip because already has data" branch anywhere in this loop anymore — every conversation with a non-null `finalState` is attempted, and only a revision mismatch turns an attempt into a rejection.
5. `validateFreshSource` needs to validate against the NEW multi-conversation manifest shape from Task 2's `DialogueHistoryBackfillManifest` — the core per-chunk digest/ordinal re-verification logic is unchanged, it now just needs to iterate `manifest.conversations` (already an array in both the lifecycle and dialogue manifest shapes) without further change, since manifest already tracked multiple conversations even in the lifecycle version (an account has many conversations feeding into one lifecycle state) — re-read `validateFreshSource`'s current body closely to confirm this claim before assuming no change is needed there; if the lifecycle version's manifest-conversation-array handling already works for "many conversations, one shared final state," the ONLY change needed for dialogue scope is what happens with the recomputed `state` at the end — the dialogue version doesn't recompute one shared state, it needs the SAME fresh-source check to still pass per distinct conversation without requiring a single combined final state to exist.

- [ ] **Step 2: Fork `dialogue-history-backfill-import-run.ts`**

Copy `lifecycle-history-backfill-import-run.ts` to `dialogue-history-backfill-import-run.ts` with the standard renames, calling `importReviewedDialogueHistory`/`preflightReviewedDialogueHistoryFiles` from Step 1. The `createImportClient` factory at the bottom (which calls `client.rpc('import_memory_v3_lifecycle_backfill_state', {...})`) changes to call `client.rpc('import_memory_v3_dialogue_backfill_state', {...})` with the added `p_conversation_id` parameter, and its `loadCurrentHead` implementation queries `memory_v3_dialogue_heads`/`memory_v3_dialogue_items` with both `user_id` and `conversation_id` filters. The CLI argv shape (`--import-reviewed-history --artifact-file <path> --review-file <path> --import-id <uuid>`) stays identical — no new flags needed, since the artifact itself already contains every conversation to import.

- [ ] **Step 3: Write the test**

Read `lifecycle-history-backfill-import.test.ts` in full first (check it exists — `ls scripts/memory-v3-pilot/lifecycle-history-backfill-import.test.ts`) for its exact fake-client injection pattern. Mirror it for `dialogue-history-backfill-import.test.ts`, PLUS this new test (per the plan's Review Focus section):

```typescript
it("rejects one conversation whose revision changed since the paid run, without aborting the other conversation's import", async () => {
  // Build a synthetic 2-conversation artifact (conversation A with
  // expectedStateRevision 0, conversation B with expectedStateRevision 4
  // -- proving this isn't gated on emptiness, B already had organic data
  // before the paid run even started and that's fine) + matching
  // auto-generated review decision (mirror whatever helper Task 7
  // provides, or build the decision object inline matching
  // validateDecision's exact shape if Task 7 isn't committed yet when
  // this test is written -- check with
  // `ls scripts/memory-v3-pilot/dialogue-history-backfill-approval.ts`
  // first). Build a fake client whose loadCurrentHead reports
  // conversation A still at revision 0 (unchanged) and conversation B
  // now at revision 5 (something new landed after the paid run).
  // Call importReviewedDialogueHistory and assert: conversation A's
  // result is { status: 'succeeded', ... } (importInitialState WAS
  // called for A, overwriting its empty state), conversation B's result
  // is { status: 'rejected_state_changed' }, and the fake client's
  // importInitialState was called exactly once (only for A, never for
  // B) -- B's pre-existing revision-4 data is left untouched, not
  // overwritten and not silently kept either; it's reported as rejected.
});
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts`
Expected: pass, including the new partial-rejection test.

- [ ] **Step 5: Run the full `scripts/memory-v3-pilot` suite**

Run: `npx tsx --test scripts/memory-v3-pilot/*.test.ts`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-import.ts scripts/memory-v3-pilot/dialogue-history-backfill-import-run.ts scripts/memory-v3-pilot/dialogue-history-backfill-import.test.ts
git commit -m "feat: fork the history-backfill import step for per-conversation dialogue import

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Review-approval-file generator

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-approval.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-approval.test.ts`

**Interfaces:**
- Consumes: the artifact shape produced by Task 4/5's CLI (`{ benchmarkResult: DialogueHistoryBackfillResult; semanticReviewPacket }`).
- Produces: `generateApprovalDecision(artifact: unknown): DialogueHistoryReviewDecision` (the type from Task 6). Настя's own manual workflow calls this via a tiny CLI wrapper this task also builds.

- [ ] **Step 1: Write `dialogue-history-backfill-approval.ts`**

```typescript
/** Auto-generates the review-decision file the import step requires,
 * from a completed paid run's artifact -- Настя never hand-writes this
 * structured JSON herself. Refuses to approve an artifact that isn't
 * fully successful, mirroring validateArtifact's own requirement that
 * only a complete, failure-free run is importable at all. */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';

interface ArtifactShape {
  benchmarkResult: {
    execute: boolean;
    conversations: Array<{
      finalState: { items: Array<{ memoryKey: string }> } | null;
      failureCount: number;
    }>;
  };
  semanticReviewPacket: { payloadSha256: string };
}

export function generateApprovalDecision(artifact: unknown): {
  schemaVersion: 'memory-v3-dialogue-history-review-v1';
  payloadSha256: string;
  verdict: 'PASS';
  reviewedAt: string;
  reviewer: 'Nastya';
  items: Array<{ memoryKey: string; semanticVerdict: 'PASS'; reviewerNotes: null }>;
} {
  const typed = artifact as ArtifactShape;
  if (
    typeof typed !== 'object' || typed === null ||
    typeof typed.benchmarkResult !== 'object' || typed.benchmarkResult === null ||
    typed.benchmarkResult.execute !== true ||
    !Array.isArray(typed.benchmarkResult.conversations) ||
    typed.benchmarkResult.conversations.length === 0 ||
    typed.benchmarkResult.conversations.some((row) => row.failureCount !== 0 || row.finalState === null) ||
    typeof typed.semanticReviewPacket !== 'object' || typed.semanticReviewPacket === null ||
    typeof typed.semanticReviewPacket.payloadSha256 !== 'string'
  ) {
    throw new Error('[memory-v3:dialogue-history-approval] artifact is not fully successful, refusing to approve');
  }
  const items = typed.benchmarkResult.conversations.flatMap((conversation) =>
    conversation.finalState!.items.map((item) => ({
      memoryKey: item.memoryKey,
      semanticVerdict: 'PASS' as const,
      reviewerNotes: null,
    }))
  );
  return {
    schemaVersion: 'memory-v3-dialogue-history-review-v1',
    payloadSha256: typed.semanticReviewPacket.payloadSha256,
    verdict: 'PASS',
    reviewedAt: new Date().toISOString(),
    reviewer: 'Nastya',
    items,
  };
}

async function direct(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 4 || argv[0] !== '--generate-approval' || argv[1] !== '--artifact-file' || argv[3] === undefined) {
    console.error('Usage: --generate-approval --artifact-file <absolute .json path>');
    process.exitCode = 1;
    return;
  }
  const artifactFile = argv[2];
  if (!isAbsolute(artifactFile) || extname(artifactFile).toLowerCase() !== '.json') {
    console.error('--artifact-file must be an absolute .json path');
    process.exitCode = 1;
    return;
  }
  const artifactText = await readFile(artifactFile, 'utf8');
  const decision = generateApprovalDecision(JSON.parse(artifactText));
  const reviewFile = artifactFile.replace(/\.json$/, '.review.json');
  await writeFile(reviewFile, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
  console.log(`Написан файл подтверждения: ${reviewFile}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  void direct();
}
```

- [ ] **Step 2: Write the test**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateApprovalDecision } from "./dialogue-history-backfill-approval.ts";

function successfulArtifact() {
  return {
    benchmarkResult: {
      execute: true,
      conversations: [
        { finalState: { items: [{ memoryKey: "a".repeat(64) }, { memoryKey: "b".repeat(64) }] }, failureCount: 0 },
        { finalState: { items: [{ memoryKey: "c".repeat(64) }] }, failureCount: 0 },
      ],
    },
    semanticReviewPacket: { payloadSha256: "d".repeat(64) },
  };
}

describe("dialogue history backfill approval generator", () => {
  it("generates a PASS decision covering every item from every conversation, in order", () => {
    const decision = generateApprovalDecision(successfulArtifact());
    assert.equal(decision.verdict, "PASS");
    assert.equal(decision.reviewer, "Nastya");
    assert.equal(decision.payloadSha256, "d".repeat(64));
    assert.deepEqual(decision.items.map((item) => item.memoryKey), ["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
    assert.ok(decision.items.every((item) => item.semanticVerdict === "PASS" && item.reviewerNotes === null));
  });

  it("refuses to approve an artifact where any conversation has a nonzero failureCount", () => {
    const artifact = successfulArtifact();
    artifact.benchmarkResult.conversations[0].failureCount = 1;
    assert.throws(() => generateApprovalDecision(artifact));
  });

  it("refuses to approve an artifact where any conversation's finalState is null", () => {
    const artifact = successfulArtifact();
    (artifact.benchmarkResult.conversations[1] as { finalState: unknown }).finalState = null;
    assert.throws(() => generateApprovalDecision(artifact));
  });

  it("refuses to approve a dry-run (execute: false) artifact", () => {
    const artifact = successfulArtifact();
    artifact.benchmarkResult.execute = false;
    assert.throws(() => generateApprovalDecision(artifact));
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-approval.test.ts`
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-approval.ts scripts/memory-v3-pilot/dialogue-history-backfill-approval.test.ts
git commit -m "feat: auto-generate the dialogue history backfill review-approval file

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Plain-Russian readable report generator

**Files:**
- Create: `scripts/memory-v3-pilot/dialogue-history-backfill-report.ts`
- Test: `scripts/memory-v3-pilot/dialogue-history-backfill-report.test.ts`

**Interfaces:**
- Consumes: the artifact shape from Task 4/5 (`DialogueHistoryBackfillResult`'s `conversations` array — each entry already carries its own `expectedStateRevision`, per Task 4).
- Produces: `buildReadableReport(input: { benchmarkResult: {...} }): string` — plain Russian text. A tiny CLI wrapper (mirroring Task 7's `direct()` pattern) writes it to a `.txt` file next to the artifact.

- [ ] **Step 1: Write `dialogue-history-backfill-report.ts`**

```typescript
/** Formats a completed dialogue history backfill run's result as plain
 * Russian text Настя can actually read -- grouped by conversation, each
 * surviving item's claim and topic label. Every conversation gets
 * reprocessed, including ones that already had live data (Настя's
 * explicit choice, 2026-09-24) -- so this report must say plainly, per
 * conversation, whether its existing records get replaced or it started
 * empty, never leave that ambiguous. Pure formatting over data the JSON
 * result already has; no new extraction logic, no model calls. */

const DIALOGUE_TOPIC_LABELS: Record<string, string> = {
  person: 'Люди',
  fact: 'Факты',
  preference: 'Предпочтения общения',
};

interface ReportItem {
  claim: string;
  topic: string | null;
}

interface ReportConversation {
  conversationId: string;
  finalState: { items: ReportItem[] } | null;
  failureCount: number;
  expectedStateRevision: number;
}

export function buildReadableReport(input: {
  benchmarkResult: { conversations: ReportConversation[] };
}): string {
  const lines: string[] = [];
  const succeeded = input.benchmarkResult.conversations.filter(
    (row) => row.failureCount === 0 && row.finalState !== null,
  );
  const failed = input.benchmarkResult.conversations.filter(
    (row) => row.failureCount !== 0 || row.finalState === null,
  );
  const replacedCount = succeeded.filter((row) => row.expectedStateRevision > 0).length;

  lines.push(`Разобрано диалогов: ${succeeded.length}`);
  if (replacedCount > 0) {
    lines.push(`Из них с заменой уже накопленной памяти: ${replacedCount}`);
  }
  if (failed.length > 0) lines.push(`Не удалось разобрать: ${failed.length}`);
  lines.push('');

  for (const conversation of succeeded) {
    const status = conversation.expectedStateRevision > 0
      ? '(в этом диалоге уже была своя память -- она заменена этим разбором)'
      : '(диалог был пустым)';
    lines.push(`Диалог ${conversation.conversationId} ${status}:`);
    if (conversation.finalState!.items.length === 0) {
      lines.push('  (ничего устойчивого не найдено)');
    }
    for (const item of conversation.finalState!.items) {
      const label = item.topic !== null ? (DIALOGUE_TOPIC_LABELS[item.topic] ?? item.topic) : 'без темы';
      lines.push(`  [${label}] ${item.claim}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('Диалоги, которые не удалось разобрать:');
    for (const conversation of failed) {
      lines.push(`  ${conversation.conversationId}`);
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Write the test**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReadableReport } from "./dialogue-history-backfill-report.ts";

describe("dialogue history backfill readable report", () => {
  it("lists each succeeded conversation's items with Russian topic labels", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [
          {
            conversationId: "convo-1",
            failureCount: 0,
            expectedStateRevision: 0,
            finalState: { items: [{ claim: "Живёт в Казани", topic: "fact" }, { claim: "Любит утренние прогулки", topic: "preference" }] },
          },
        ],
      },
    });
    assert.match(report, /Диалог convo-1 \(диалог был пустым\):/);
    assert.match(report, /\[Факты\] Живёт в Казани/);
    assert.match(report, /\[Предпочтения общения\] Любит утренние прогулки/);
  });

  it("labels a conversation that already had live data as replaced, not indistinguishable from an empty one", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [
          {
            conversationId: "convo-active",
            failureCount: 0,
            expectedStateRevision: 6,
            finalState: { items: [{ claim: "Работает психологом", topic: "fact" }] },
          },
        ],
      },
    });
    assert.match(report, /Из них с заменой уже накопленной памяти: 1/);
    assert.match(report, /Диалог convo-active \(в этом диалоге уже была своя память -- она заменена этим разбором\):/);
  });

  it("names failed conversations explicitly", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [{ conversationId: "convo-fail", failureCount: 1, expectedStateRevision: 0, finalState: null }],
      },
    });
    assert.match(report, /Не удалось разобрать: 1/);
    assert.match(report, /convo-fail/);
  });

  it("handles a conversation with zero surviving items without crashing", () => {
    const report = buildReadableReport({
      benchmarkResult: {
        conversations: [{ conversationId: "convo-empty", failureCount: 0, expectedStateRevision: 0, finalState: { items: [] } }],
      },
    });
    assert.match(report, /ничего устойчивого не найдено/);
  });
});
```

Note: dialogue scope's real topic enum is `person`/`fact`/`preference` (Люди/Факты/Предпочтения общения) — do not reach for the lifecycle-scope labels (`life_context`/`communication`/`preference` → Факты профиля/Стиль общения/Что помогает в контакте) here, they belong to a different scope entirely.

- [ ] **Step 3: Run the test**

Run: `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-report.test.ts`
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/memory-v3-pilot/dialogue-history-backfill-report.ts scripts/memory-v3-pilot/dialogue-history-backfill-report.test.ts
git commit -m "feat: add the plain-Russian readable report for the dialogue history backfill

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification, usage instructions, and PR

**Files:**
- Create: `scripts/memory-v3-pilot/README-dialogue-history-backfill.md` (usage instructions for Настя, mirroring whatever usage documentation exists for the lifecycle tool — check `scripts/memory-v3-pilot/README.md` for an existing lifecycle-tool usage section to mirror the style of; if none exists there, write a self-contained one)

- [ ] **Step 1: Run the full `scripts/memory-v3-pilot` suite one more time end to end**

Run: `npx tsx --test scripts/memory-v3-pilot/*.test.ts`
Expected: every lifecycle test still at its original count, every new dialogue test passing, zero failures beyond whatever pre-existing unrelated failures this session has already documented (confirm via `git stash` comparison against the branch's own start point if any count looks off).

- [ ] **Step 2: Run the full `_shared/memoryV3` suite**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/*.cases.test.ts`
Expected: unchanged from before this branch (this plan touches `scripts/` and one new migration/test pair in `_shared/memoryV3`, nothing else in `_shared`) — confirm the new Task 1 test is included and everything else is untouched.

- [ ] **Step 3: Write `README-dialogue-history-backfill.md`**

Cover, in plain Russian: what the tool is for, that it costs real money (technical spend), that it will overwrite any already-existing per-dialogue memory it finds (not skip it — read the report carefully before importing), and that a fixed `--source-cutoff` date can be passed to freeze the message set at a point in time so an actively-growing conversation (like her main chat) can still be safely included without messages arriving mid-review causing problems. Then the exact command sequence: `--inspect-source` dry run first to see the cost estimate, then `--execute-history-backfill-paid-requests` for the real paid run, both via `dialogue-history-backfill-cli.ts`, then running `dialogue-history-backfill-approval.ts --generate-approval --artifact-file <path>` to produce the approval file, reading the plain-Russian report (produced alongside the artifact by the CLI — confirm Task 5's CLI actually writes the report to a file, wiring in Task 8's `buildReadableReport` if that wasn't already part of Task 5's own deliverable; if it's missing, this task must add that one wiring step: after a successful paid run, call `buildReadableReport` and write its output next to the artifact/review-packet files), then running `dialogue-history-backfill-import-run.ts --import-reviewed-history --artifact-file <path> --review-file <path> --import-id <uuid>` for the actual import — flagging clearly that any conversation reported as `rejected_state_changed` needs a fresh paid run for just that one conversation, since something changed in it after the paid run captured its starting point. Mirror the exact env-var names (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, and whatever user-id env var the lifecycle tool's `-run.ts`-equivalent used — check if `dialogue-history-backfill-cli.ts` needs one of its own, matching the lifecycle CLI's own env var reads).

- [ ] **Step 4: Confirm the wiring gap from Step 3, if any, is real and fix it**

If Task 5's CLI does not already write Task 8's readable report to a file as part of a successful paid run, add that wiring now: after `runDialogueHistoryBackfillFromArgv` succeeds with `execute: true`, call `buildReadableReport({ benchmarkResult })` and write the result to a `.txt` file alongside wherever the artifact JSON gets written (check the lifecycle CLI's own `--safe-output-file` handling for the exact file-writing convention to mirror). Add a test to `dialogue-history-backfill-cli.test.ts` confirming the report file is written with content matching `buildReadableReport`'s own output for the same input. Re-run `npx tsx --test scripts/memory-v3-pilot/dialogue-history-backfill-cli.test.ts` and the full suite again after this fix.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/memory-v3-dialogue-history-backfill
gh pr create --base main --title "Разовый разбор истории сообщений по диалогам (для памяти Memory V3)" --body "$(cat <<'EOF'
## В чём была просьба

После вчерашнего разбора старых записей по темам Настя заметила, что памяти по отдельным диалогам почти нет — новая функция включена недавно и реальных данных пока не накопилось. Она попросила прогнать всю свою историю сообщений (1100+) через тот же механизм, что уже раньше строил сквозную память, но на этот раз разложить результат по отдельным диалогам, чтобы посмотреть, насколько разумно распределяются факты и темы, прежде чем доверять этому в бою.

## Что сделано

Зеркальная копия уже существующего инструмента разбора истории (`lifecycle-history-backfill-*`), приспособленная под память по диалогам:
- Читает историю сообщений тем же самым способом, что и раньше (код переиспользован без изменений).
- Группирует результат по каждому диалогу отдельно — это была главная переделка, включая находку, что кусочки истории изначально идут вперемешку по времени, а не по диалогам подряд.
- Разбирает вообще все диалоги, включая те, где уже что-то накопилось само по себе — по просьбе Насти такие диалоги не пропускаются, а разбираются заново и заменяются. Если прямо во время проверки в диалог придёт что-то новое, перенос для этого одного диалога честно откажет с понятной причиной, а не затрёт свежее вслепую.
- Можно задать дату среза (например, «учитывать сообщения только до 20.09») — тогда активный, постоянно растущий диалог всё равно можно спокойно разобрать: то, что придёт после этой даты, просто не участвует в разборе.
- Разбор — платный шаг, ничего не пишет в боевую память. Отдельная команда переносит уже готовый и проверенный результат.
- Простой читаемый отчёт по-русски — что нашлось в каждом диалоге и какая тема — чтобы Настя сама могла оценить результат до переноса.
- Файл-подтверждение для переноса собирается автоматически, вручную JSON писать не нужно.

## Проверено

- Полный набор тестов инструмента (`scripts/memory-v3-pilot`) и раздела памяти — без регрессий.
- Настоящий платный разбор и настоящий перенос в память НЕ запускались — это должна сделать сама Настя, следуя инструкции в README.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Stop here.** Do not merge, do not run the real `--execute-history-backfill-paid-requests` command, do not run the real import. Report the PR link and hand off usage instructions to Настя.
