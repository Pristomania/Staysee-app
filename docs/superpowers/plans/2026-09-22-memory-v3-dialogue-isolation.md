# Memory V3 Dialogue Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline storage foundation (new Postgres tables/RPCs + TypeScript store) that lets Memory V3's deep extraction/reconciliation engine keep one independent lifecycle state per `(user_id, conversation_id)` instead of one shared state per `user_id` — with zero change to any existing live behavior.

**Architecture:** Duplicate the existing `memory_v3_lifecycle_shadow_*` tables and their three RPCs into a new `memory_v3_dialogue_*` set, re-keyed to include `conversation_id` everywhere `user_id` alone appears today (primary keys, advisory lock hash, row caps). Extend `contract.ts` so its extraction normalizer can tag items with a real `conversationId` when asked, instead of always hardcoding `null`. Build a new `dialogueStore.ts` / `dialogueReadStore.ts` TypeScript layer mirroring `lifecycleStore.ts` / `lifecycleReadStore.ts`.

**Tech Stack:** Deno (Edge Functions), Postgres/Supabase (SQL migrations, `plpgsql` SECURITY DEFINER RPCs), TypeScript, Node's built-in `node:test`/`node:assert/strict` run via `npx tsx --test <file>`.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-09-22-memory-v3-dialogue-isolation-design.md` (PR #49) — this plan implements domain 1 only.
- Zero live wiring: do not touch `supabase/functions/staysee-chat/index.ts`, do not read any new env var, do not call `supabase db push` or deploy anything.
- Zero changes to `memory_v3_lifecycle_shadow_*` tables, `contract.ts`'s existing `"cross_conversation"` behavior, or `сквозная` (`profiles.cross_memory_enabled` / `user_memory`).
- Every new/changed TypeScript file must type-check with `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config <file>` with the SAME error count as an unmodified `git stash` baseline (zero new errors — compare counts explicitly, don't eyeball it).
- Every `*.cases.test.ts` file runs via `npx tsx --test <file>`.
- Before/after every task, run the full `_shared` suite: `npx tsx --test $(find supabase/functions/_shared -name "*.cases.test.ts")` and confirm the same pass/fail counts as the pre-task baseline (461/462 as of this session, with the one pre-existing `narrativeEngine.cases.test.ts` failure unrelated and unchanged).
- Commit after every GREEN step. Use `[agent] feat: ...` / `[agent] test: ...` commit message style, matching this repo's existing convention.
- I (the agent executing this plan) cannot merge PRs or deploy to production myself in this environment — every task ends with a commit; PR creation and merge decision happen once at the end of the whole plan, not per-task.

---

## Task 1: Migration — new tables and RPCs

**Files:**
- Create: `supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql`

**Interfaces:**
- Produces: tables `memory_v3_dialogue_heads`, `memory_v3_dialogue_items`, `memory_v3_dialogue_evidence`, `memory_v3_dialogue_identities`, `memory_v3_dialogue_runs`; RPCs `reserve_memory_v3_dialogue_run(p_user_id uuid, p_conversation_id uuid, p_pipeline_version text, p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text, p_source_last_message_id uuid, p_source_last_created_at timestamptz, p_message_count integer, p_user_message_count integer) RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)`, `fail_memory_v3_dialogue_run(p_run_id uuid, p_user_id uuid, p_diagnostic_code text) RETURNS void`, `apply_memory_v3_dialogue_state(p_run_id uuid, p_user_id uuid, p_conversation_id uuid, p_expected_state_revision bigint, p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb, p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb) RETURNS TABLE(result text, resulting_state_revision bigint)`, `load_memory_v3_dialogue_read_context(p_user_id uuid, p_conversation_id uuid) RETURNS jsonb`. Only `service_role` may execute any of these (same grant pattern as the existing lifecycle RPCs).

This task has no automated test of its own (SQL migrations in this repo are verified by the RPC-consuming TypeScript store's tests in Task 3, exactly like `lifecycleStore.cases.test.ts` verifies `034_memory_v3_lifecycle_shadow.sql` without a dedicated SQL test file). Correctness here is verified by careful mirroring of the existing, already-production-proven migration plus the two review findings from the design doc.

**Execution note (found and fixed during Task 1 itself, not anticipated when this plan was written):** the SQL block below was drafted from a partial read of `034_memory_v3_lifecycle_shadow.sql` (only its first ~20 and last ~120 lines) and was missing real content on first pass: `apply`'s actual algorithm (full state replace with server-side evidence-ownership verification and a server-computed `actual_changed`/revision integrity check, not a naive per-item upsert), the `runs` table's full audit/usage columns and terminal-shape constraints, `BEFORE DELETE` triggers on `messages`/`conversations` that clean up orphaned items, a daily `purge_memory_v3_*_runs()` cron job, and table-level `REVOKE`/`GRANT` alongside the RLS-with-no-policies pattern. The actual file written to disk (`supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql`) is the corrected, complete version — read it directly rather than trusting the SQL block below as authoritative; it predates the fix. Verified structurally complete via: `diff <(grep -o '[a-z_]*(' supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql | sort -u) <(grep -o '[a-z_]*(' supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql | sort -u)` — every function/table family in the original has a matching renamed counterpart, plus the intentionally-added `load_memory_v3_dialogue_read_context` (which in the original lives in a later migration, 036, and is folded into domain 1 here since this design needs it from the start).

- [ ] **Step 1: Write the migration file**

Base this file on `supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql` plus the daily-cap value from `supabase/migrations/20260922120000_038_memory_v3_full_rollout_alerts.sql` (cap = 1/day, matching current production — domain 2 will decide later whether this should become a per-user aggregate across dialogues instead; this task keeps the same literal value `1` per `(user_id, conversation_id)` since no per-user aggregate mechanism is being built in this domain).

```sql
-- Memory V3 dialogue isolation: one independent lifecycle state per (user, conversation).
-- Mirrors memory_v3_lifecycle_shadow_* exactly, re-keyed to include conversation_id.
-- Domain 1 only: no live wiring reads these tables yet (see
-- docs/superpowers/specs/2026-09-22-memory-v3-dialogue-isolation-design.md).

CREATE TABLE public.memory_v3_dialogue_heads (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  schema_version text NOT NULL DEFAULT 'memory-v3-dialogue-state-v1'
    CHECK (schema_version = 'memory-v3-dialogue-state-v1'),
  state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision BETWEEN 0 AND 9007199254740991),
  next_memory_ordinal bigint NOT NULL DEFAULT 1 CHECK (next_memory_ordinal BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, conversation_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.memory_v3_dialogue_items (
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  memory_key text NOT NULL CHECK (memory_key ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('event', 'recurrence', 'hypothesis')),
  claim text NOT NULL CHECK (length(btrim(claim)) > 0),
  status text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  event_time_start text,
  event_time_end text,
  alternative text,
  first_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (user_id, conversation_id, memory_key),
  FOREIGN KEY (user_id, conversation_id)
    REFERENCES public.memory_v3_dialogue_heads(user_id, conversation_id) ON DELETE CASCADE
);

CREATE TABLE public.memory_v3_dialogue_evidence (
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  memory_key text NOT NULL,
  source_message_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'corrects', 'rejects')),
  support_type text CHECK (support_type IN ('episode_observation', 'pattern_confirmation', 'scope_boundary')),
  episode_key text,
  provenance_role text NOT NULL CHECK (provenance_role = 'user'),
  mention_time timestamptz NOT NULL,
  PRIMARY KEY (user_id, conversation_id, memory_key, source_message_id, relation),
  FOREIGN KEY (user_id, conversation_id, memory_key)
    REFERENCES public.memory_v3_dialogue_items(user_id, conversation_id, memory_key) ON DELETE CASCADE
);

CREATE TABLE public.memory_v3_dialogue_identities (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, conversation_id, pipeline_version, input_hash)
);

CREATE TABLE public.memory_v3_dialogue_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  pipeline_version text NOT NULL,
  input_hash text NOT NULL,
  extractor_version text NOT NULL,
  reconciler_version text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed')),
  diagnostic_code text,
  source_last_message_id uuid NOT NULL,
  source_last_created_at timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count BETWEEN 1 AND 60),
  user_message_count integer NOT NULL,
  expected_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  UNIQUE (user_id, conversation_id, pipeline_version, input_hash),
  FOREIGN KEY (user_id, conversation_id, pipeline_version, input_hash)
    REFERENCES public.memory_v3_dialogue_identities(user_id, conversation_id, pipeline_version, input_hash)
);

CREATE INDEX memory_v3_dialogue_runs_user_conversation_created_idx
  ON public.memory_v3_dialogue_runs(user_id, conversation_id, created_at DESC);
CREATE INDEX memory_v3_dialogue_runs_created_idx
  ON public.memory_v3_dialogue_runs(created_at);

ALTER TABLE public.memory_v3_dialogue_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_v3_dialogue_runs ENABLE ROW LEVEL SECURITY;
-- No policies: RLS enabled + zero policies = service_role-only access,
-- same pattern as memory_v3_lifecycle_shadow_* and protocol_events.

CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run(
  p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,
  p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,
  p_source_last_message_id uuid, p_source_last_created_at timestamptz,
  p_message_count integer, p_user_message_count integer
)
RETURNS TABLE(result text, run_id uuid, expected_state_revision bigint, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_daily_count integer;
  v_claimed boolean;
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_items jsonb;
  v_evidence_count integer;
BEGIN
  IF p_pipeline_version <> 'memory-v3-dialogue-v1' OR p_model <> 'google/gemini-3.7-flash' THEN
    RAISE EXCEPTION 'invalid dialogue reservation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.id = p_conversation_id AND c.user_id = p_user_id
      AND m.id = p_source_last_message_id AND m.created_at = p_source_last_created_at
  ) THEN RAISE EXCEPTION 'invalid dialogue reservation' USING ERRCODE = '42501'; END IF;

  -- Review finding fix: lock folds conversation_id into the hash, unlike
  -- the lifecycle-shadow lock which is user_id-only. This is the whole
  -- point of this table set — two dialogues of the same user must not
  -- serialize against each other.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':' || p_conversation_id::text || ':' ||
    ((pg_catalog.now() AT TIME ZONE 'UTC')::date)::text, 0));

  IF EXISTS (SELECT 1 FROM public.memory_v3_dialogue_identities
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND pipeline_version = p_pipeline_version AND input_hash = p_input_hash) THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_daily_count
  FROM public.memory_v3_dialogue_runs
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id
    AND created_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_daily_count >= 1 THEN
    result := 'daily_cap'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO public.memory_v3_dialogue_identities(user_id, conversation_id, pipeline_version, input_hash)
  VALUES (p_user_id, p_conversation_id, p_pipeline_version, p_input_hash)
  ON CONFLICT (user_id, conversation_id, pipeline_version, input_hash) DO NOTHING
  RETURNING true INTO v_claimed;
  IF v_claimed IS DISTINCT FROM true THEN
    result := 'duplicate'; run_id := NULL; expected_state_revision := NULL; state := NULL; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO public.memory_v3_dialogue_heads(user_id, conversation_id) VALUES (p_user_id, p_conversation_id)
  ON CONFLICT (user_id, conversation_id) DO NOTHING;
  SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue head is missing'; END IF;

  SELECT pg_catalog.count(*)::integer INTO v_evidence_count
  FROM public.memory_v3_dialogue_evidence WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
  IF (SELECT pg_catalog.count(*) FROM public.memory_v3_dialogue_items
      WHERE user_id = p_user_id AND conversation_id = p_conversation_id) > 100
     OR v_evidence_count > 500 THEN RAISE EXCEPTION 'dialogue state too large'; END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
      'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative,
      'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
      'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
        'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
        'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
        ORDER BY e.source_message_id, e.relation COLLATE "C")
        FROM public.memory_v3_dialogue_evidence e
        WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id AND e.memory_key = i.memory_key),
        '[]'::jsonb)
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_items
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;

  state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id,
    'conversationId', v_head.conversation_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_items);
  expected_state_revision := v_head.state_revision;
  INSERT INTO public.memory_v3_dialogue_runs(
    user_id, conversation_id, pipeline_version, input_hash, extractor_version,
    reconciler_version, model, status, source_last_message_id, source_last_created_at,
    message_count, user_message_count, expected_state_revision)
  VALUES (p_user_id, p_conversation_id, p_pipeline_version, p_input_hash, p_extractor_version,
    p_reconciler_version, p_model, 'reserved', p_source_last_message_id, p_source_last_created_at,
    p_message_count, p_user_message_count, expected_state_revision)
  RETURNING id INTO run_id;
  result := 'reserved'; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_memory_v3_dialogue_run(
  p_run_id uuid, p_user_id uuid, p_diagnostic_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'failed', diagnostic_code = p_diagnostic_code, completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state(
  p_run_id uuid, p_user_id uuid, p_conversation_id uuid, p_expected_state_revision bigint,
  p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb,
  p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_current_revision bigint;
  v_resulting_revision bigint;
  v_item jsonb;
  v_transition jsonb;
BEGIN
  SELECT state_revision INTO v_current_revision FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND OR v_current_revision <> p_expected_state_revision THEN
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

  v_resulting_revision := p_expected_state_revision + (CASE WHEN p_changed THEN 1 ELSE 0 END);

  FOR v_transition IN SELECT * FROM jsonb_array_elements(p_transitions) LOOP
    IF v_transition->>'type' = 'forget' THEN
      DELETE FROM public.memory_v3_dialogue_items
      WHERE user_id = p_user_id AND conversation_id = p_conversation_id
        AND memory_key = v_transition->>'targetMemoryKey';
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_state->'items') LOOP
    INSERT INTO public.memory_v3_dialogue_items(
      user_id, conversation_id, memory_key, kind, claim, status, sensitivity,
      event_time_start, event_time_end, alternative, updated_at, revision)
    VALUES (
      p_user_id, p_conversation_id, v_item->>'memoryKey', v_item->>'kind', v_item->>'claim',
      v_item->>'status', v_item->>'sensitivity', v_item->>'eventTimeStart', v_item->>'eventTimeEnd',
      v_item->>'alternative', pg_catalog.now(), COALESCE((v_item->>'revision')::bigint, 1))
    ON CONFLICT (user_id, conversation_id, memory_key) DO UPDATE SET
      status = EXCLUDED.status, sensitivity = EXCLUDED.sensitivity,
      event_time_start = EXCLUDED.event_time_start, event_time_end = EXCLUDED.event_time_end,
      alternative = EXCLUDED.alternative, updated_at = pg_catalog.now(),
      revision = public.memory_v3_dialogue_items.revision + 1;

    DELETE FROM public.memory_v3_dialogue_evidence
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id
      AND memory_key = v_item->>'memoryKey';
    INSERT INTO public.memory_v3_dialogue_evidence(
      user_id, conversation_id, memory_key, source_message_id, relation,
      support_type, episode_key, provenance_role, mention_time)
    SELECT p_user_id, p_conversation_id, v_item->>'memoryKey',
      (e->>'sourceMessageId')::uuid, e->>'relation', e->>'supportType', e->>'episodeKey',
      e->>'provenanceRole', (e->>'mentionTime')::timestamptz
    FROM jsonb_array_elements(v_item->'evidence') e;
  END LOOP;

  UPDATE public.memory_v3_dialogue_heads SET
    state_revision = v_resulting_revision,
    next_memory_ordinal = GREATEST(next_memory_ordinal, COALESCE((p_state->>'nextMemoryOrdinal')::bigint, next_memory_ordinal)),
    updated_at = pg_catalog.now()
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;

  UPDATE public.memory_v3_dialogue_runs SET status = 'succeeded', completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';

  result := 'succeeded'; resulting_state_revision := v_resulting_revision; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' STABLE AS $$
DECLARE
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_items jsonb;
BEGIN
  SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'kind', i.kind, 'claim', i.claim,
    'status', CASE WHEN i.kind = 'hypothesis' THEN 'supported' ELSE 'active' END,
    'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
    'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'updatedAt', i.updated_at)
    ORDER BY i.updated_at DESC), '[]'::jsonb) INTO v_items
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id
    AND i.status IN ('active', 'supported')
  LIMIT 12;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 'memory-v3-dialogue-read-context-v1',
    'stateRevision', v_head.state_revision, 'items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_memory_v3_dialogue_run(
  uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_memory_v3_dialogue_run(
  uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_memory_v3_dialogue_run(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.apply_memory_v3_dialogue_state(
  uuid, uuid, uuid, bigint, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_memory_v3_dialogue_state(
  uuid, uuid, uuid, bigint, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_read_context(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_read_context(uuid, uuid) TO service_role;
```

- [x] **Step 2: Sanity-check the file against the two mirrored originals**

Run: `diff <(grep -o '[a-z_]*(' supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql | sort -u) <(grep -o '[a-z_]*(' supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql | sort -u)`

Done — confirmed only naming differences plus the intentionally-added `load_memory_v3_dialogue_read_context` (see execution note above).

- [x] **Step 3: Commit**

```bash
git add supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql
git commit -m "[agent] feat: add memory_v3_dialogue_* tables and RPCs"
```

---

## Task 2: `contract.ts` — accept a real `conversationId`

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/contract.ts`
- Test: `supabase/functions/_shared/memoryV3/contract.cases.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `normalizeMemoryV3LayeredResponse(raw: unknown, input: unknown, extractorVersion: string, scopeMode: "cross_conversation" | "conversation")` — 4th parameter, **required**, no default. `MemoryV3Extraction["items"][number]` type gains `scope: "cross_conversation" | "conversation"` and `conversationId: string | null`. When `scopeMode === "conversation"`, `conversationId` is parsed from the already-validated `caseId` (its second UUID segment) and `scope` is `"conversation"`; when `"cross_conversation"`, behavior is byte-for-byte identical to today (`scope: "cross_conversation"`, `conversationId: null`).

- [ ] **Step 1: Write the failing test**

Add to `contract.cases.test.ts` (near the existing scope/conversationId assertion at line ~126):

```typescript
{
  const caseId = "memory-v3-shadow:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
  const dialogue = validateMemoryV3Dialogue({
    caseId,
    messages: [{
      id: "33333333-3333-4333-8333-333333333333",
      role: "user",
      text: "Тестовое сообщение для проверки диалоговой области видимости.",
      createdAt: "2026-09-22T10:00:00.000Z",
    }],
  });
  const raw = JSON.stringify({
    layerDecisions: [
      { kind: "event", decision: "emit", itemRefs: ["e1"] },
      { kind: "recurrence", decision: "omit", itemRefs: [] },
      { kind: "hypothesis", decision: "omit", itemRefs: [] },
    ],
    items: [{
      itemRef: "e1", kind: "event", claim: "Факт из одного диалога.",
      status: "active", sensitivity: "normal",
      eventTimeStart: null, eventTimeEnd: null, alternative: null,
    }],
    evidence: [{
      itemRef: "e1", sourceMessageId: "33333333-3333-4333-8333-333333333333",
      relation: "supports", supportType: null, episodeKey: null,
    }],
  });
  const output = await normalizeMemoryV3LayeredResponse(raw, dialogue, "test-extractor-v1", "conversation");
  assert.equal(output.items[0].scope, "conversation");
  assert.equal(output.items[0].conversationId, "22222222-2222-4222-8222-222222222222");
  console.log("✓ scopeMode=conversation tags items with the caseId's conversationId");
}

{
  const caseId = "memory-v3-shadow:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
  const dialogue = validateMemoryV3Dialogue({
    caseId,
    messages: [{
      id: "33333333-3333-4333-8333-333333333333",
      role: "user",
      text: "Тестовое сообщение для проверки сквозной области видимости.",
      createdAt: "2026-09-22T10:00:00.000Z",
    }],
  });
  const raw = JSON.stringify({
    layerDecisions: [
      { kind: "event", decision: "emit", itemRefs: ["e1"] },
      { kind: "recurrence", decision: "omit", itemRefs: [] },
      { kind: "hypothesis", decision: "omit", itemRefs: [] },
    ],
    items: [{
      itemRef: "e1", kind: "event", claim: "Факт сквозной памяти.",
      status: "active", sensitivity: "normal",
      eventTimeStart: null, eventTimeEnd: null, alternative: null,
    }],
    evidence: [{
      itemRef: "e1", sourceMessageId: "33333333-3333-4333-8333-333333333333",
      relation: "supports", supportType: null, episodeKey: null,
    }],
  });
  const output = await normalizeMemoryV3LayeredResponse(raw, dialogue, "test-extractor-v1", "cross_conversation");
  assert.equal(output.items[0].scope, "cross_conversation");
  assert.equal(output.items[0].conversationId, null);
  console.log("✓ scopeMode=cross_conversation is unchanged from today's behavior");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --yes tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts`
Expected: FAIL — `normalizeMemoryV3LayeredResponse` currently takes 3 arguments and always hardcodes `scope: "cross_conversation"`, `conversationId: null`, so the first new assertion (`output.items[0].scope === "conversation"`) fails.

- [ ] **Step 3: Implement**

In `contract.ts`:

1. Change the `MemoryV3Extraction["items"]` element type (around line 26-37):
```typescript
  items: Array<{
    localItemKey: string;
    kind: MemoryKind;
    claim: string;
    scope: "cross_conversation" | "conversation";
    conversationId: string | null;
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    status: string;
    sensitivity: "normal" | "sensitive";
    alternative: string | null;
  }>;
```

2. Add a small helper near `validateCaseId` (which already extracts and validates both UUID segments via `CASE_ID.exec`):
```typescript
function conversationIdFromCaseId(caseId: string): string {
  const match = CASE_ID.exec(caseId);
  if (!match) throw fail();
  return match[2];
}
```

3. Change the `normalizeMemoryV3LayeredResponse` signature and the two `scope`/`conversationId` assignment sites (the type in `localItemKey`'s structural hash input, and the `normalized` object built inside the `for` loop around line 250-264):
```typescript
export async function normalizeMemoryV3LayeredResponse(
  raw: unknown,
  input: unknown,
  extractorVersion: string,
  scopeMode: "cross_conversation" | "conversation",
): Promise<MemoryV3Extraction> {
  try {
    const validated = validateMemoryV3Dialogue(input);
    if (!isNonEmptyString(extractorVersion)) throw fail();
    if (scopeMode !== "cross_conversation" && scopeMode !== "conversation") throw fail();
    const scopedConversationId = scopeMode === "conversation"
      ? conversationIdFromCaseId(validated.caseId)
      : null;
    const response = inspectRecord(parseRaw(raw), RESPONSE_FIELDS);
    const rawItems = inspectDenseArray(response.items);
    const refs = new Map<string, { key: string; kind: MemoryKind }>();
    const items: MemoryV3Extraction["items"] = [];
    for (let index = 0; index < rawItems.length; index += 1) {
      const source = validateItemFields(rawItems[index]);
      const ref = source.itemRef as string;
      if (refs.has(ref)) throw fail();
      const normalized = {
        kind: source.kind as MemoryKind,
        claim: source.claim as string,
        scope: scopeMode,
        conversationId: scopedConversationId,
        eventTimeStart: source.eventTimeStart as string | null,
        eventTimeEnd: source.eventTimeEnd as string | null,
        status: source.status as string,
        sensitivity: source.sensitivity as "normal" | "sensitive",
        alternative: source.alternative as string | null,
      };
      const key = await localItemKey(normalized, index);
      refs.set(ref, { key, kind: normalized.kind });
      items.push({ ...normalized, localItemKey: key });
    }
```
(the rest of the function body — decisions/evidence loops — is unchanged; only the two lines building `normalized` change from the literal `"cross_conversation"` / `null` to the new variables, plus the new signature and validation line above them)

4. Update the ONE existing production call site so live behavior is unchanged. Find it:

Run: `grep -rn "normalizeMemoryV3LayeredResponse(" supabase/functions/_shared/memoryV3/*.ts`

Add `"cross_conversation"` as the 4th argument at that call site (it is inside `lifecycleShadowRunner.ts`'s extractor-response handling — do not change any other argument or surrounding logic).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx --yes tsx supabase/functions/_shared/memoryV3/contract.cases.test.ts`
Expected: all cases pass, including the two new ones and the pre-existing line-126 assertion (still `"cross_conversation"`/`null`, unchanged since that test doesn't pass a 4th argument — update that one pre-existing call site in the test file to pass `"cross_conversation"` explicitly too, since the parameter is now required).

- [ ] **Step 5: Type-check**

Run: `cd "D:/Project/GPT JARVIS/tmp/staysee-audit-repo" && git stash && "/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/staysee-chat/index.ts 2>&1 | grep "Found.*error"` — record the baseline count, then `git stash pop` and re-run the same command. Expected: identical count (this file transitively imports `contract.ts` via the shadow runner chain, so it is the right file to check for new errors).

- [ ] **Step 6: Full regression sweep**

Run: `npx --yes tsx --test $(find supabase/functions/_shared -name "*.cases.test.ts")`
Expected: same pass count as the pre-task baseline (461 + however many new cases this task added, only the pre-existing unrelated `narrativeEngine.cases.test.ts` failure present).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/contract.ts supabase/functions/_shared/memoryV3/contract.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts
git commit -m "[agent] feat: let Memory V3 extraction tag items with a real conversationId"
```

---

## Task 3: `dialogueStore.ts` — write-side TypeScript store

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueStore.ts`
- Test: `supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts`

**Interfaces:**
- Consumes: `MemoryV3Extraction` from `contract.ts` (Task 2).
- Produces: `createMemoryV3DialogueStore(client: MemoryV3DialogueRpcClient): MemoryV3DialogueStore` where `MemoryV3DialogueStore = { reserve(input): Promise<MemoryV3DialogueReservationResult>; fail(input): Promise<void>; compareAndSwap(input): Promise<{status:"succeeded",resultingStateRevision:number}|{status:"state_conflict"}> }`. Used only by tests in this task — no production call site is wired yet (that is domain 2, out of scope).

- [ ] **Step 0 (prerequisite, found during plan self-review): mirror `lifecycleContract.ts` too**

`lifecycleStore.ts` imports `validateMemoryV3LifecycleState` and the `MemoryV3LifecycleOperationType`/`MemoryV3LifecycleProposal`/`MemoryV3LifecycleState` types, plus `MEMORY_V3_LIFECYCLE_MAX_CANDIDATES` and friends, from a separate file: `supabase/functions/_shared/memoryV3/lifecycleContract.ts` (564 lines — the reducer/state-shape contract, not just the RPC store). If `dialogueStore.ts` is created by mirroring only `lifecycleStore.ts` and keeps importing from the unmodified `lifecycleContract.ts`, its state validator will reject the new `'memory-v3-dialogue-state-v1'` schema version (that file hardcodes `'memory-v3-lifecycle-state-v1'`) — a real bug, not a style issue.

Fix: before Step 1, create `supabase/functions/_shared/memoryV3/dialogueContract.ts` by copying `lifecycleContract.ts` in full and applying the same mechanical replacement list as the rest of this task (`Lifecycle` → `Dialogue` in every exported name, `memory-v3-lifecycle-state-v1` → `memory-v3-dialogue-state-v1`, `memory-v3-lifecycle-shadow-v1` → `memory-v3-dialogue-v1`) — no behavior differences beyond naming, this file's validation logic itself needs no `conversationId`-awareness change (state-shape/operation validation, not RPC key scoping). `dialogueStore.ts` (Step 3 below) imports from this new file, not from `lifecycleContract.ts`. Do not modify `lifecycleContract.ts` itself (non-goal: zero change to the existing lifecycle path).

Also copy its test file, `lifecycleContract.cases.test.ts` → `dialogueContract.cases.test.ts`, with the same replacements, so the mirror gets the same test coverage before anything else in this task depends on it. Run: `npx --yes tsx --test supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts` (or `npx --yes tsx <file>` if it predates the `node:test` convention — check the original file's style first) — expect the same pass count as running the equivalent command against `lifecycleContract.cases.test.ts`.

Verify the code mirror is complete before moving on:
Run: `diff <(grep -oE '^export (const|type|function|interface) [A-Za-z0-9_]+' supabase/functions/_shared/memoryV3/lifecycleContract.ts | sed 's/Lifecycle/Dialogue/;s/lifecycle/dialogue/') <(grep -oE '^export (const|type|function|interface) [A-Za-z0-9_]+' supabase/functions/_shared/memoryV3/dialogueContract.ts)`
Expected: no output (every exported name in the original has a matching renamed counterpart in the mirror).

**Done.** `conversationId` added as a real, validated field throughout (state, evidence identity, extraction item scope). Test mirror reuses the same 80-scenario synthetic dataset retagged onto one fixed conversation; found and fixed a real evidence-identity collision in a handful of scenarios that reuse placeholder `sourceMessageId`s across synthetic conversations (folded the original conversationId into the retagged sourceMessageId to keep identities unique — a test-fixture fix, not a contract fix, since production sourceMessageId is always a globally unique UUID). 107/107 new tests pass; full suite 570/571 (same pre-existing unrelated failure). Commit `ac28673`.

- [ ] **Step 1: Write the failing test**

Create `dialogueStore.cases.test.ts` by copying `lifecycleStore.cases.test.ts` in full, then applying exactly these mechanical replacements (verify with `grep -c` before/after that nothing else changed):

- `lifecycleStore.ts` → `dialogueStore.ts` (the import path)
- `createMemoryV3LifecycleStore` → `createMemoryV3DialogueStore`
- `MemoryV3LifecycleStore` → `MemoryV3DialogueStore` (and its `Reservation`/`FailureWrite`/`SuccessWrite`/`Usage`/`RpcClient` sibling type names, same prefix swap)
- `reserve_memory_v3_lifecycle_shadow_run` → `reserve_memory_v3_dialogue_run`
- `fail_memory_v3_lifecycle_shadow_run` → `fail_memory_v3_dialogue_run`
- `apply_memory_v3_lifecycle_shadow_state` → `apply_memory_v3_dialogue_state`
- `memory-v3-lifecycle-shadow-v1` → `memory-v3-dialogue-v1` (the `pipelineVersion` literal)
- `[memory-v3:lifecycle-store]` → `[memory-v3:dialogue-store]` (error message prefix assertions, if the mirrored test file checks them)

Then add one new test case (this codebase's existing suite has no case for cross-conversation isolation, since the old store never had two conversations to isolate — this is the one genuinely new behavior, not present in the mirrored file):

```typescript
test("two conversations of the same user reserve and apply completely independently", async () => {
  const CONVERSATION_A = "44444444-4444-4444-8444-444444444444";
  const CONVERSATION_B = "55555555-5555-4555-8555-555555555555";
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeState = (conversationId: string, revision: number) => ({
    schemaVersion: "memory-v3-dialogue-state-v1",
    userId: NASTYA,
    conversationId,
    stateRevision: revision,
    nextMemoryOrdinal: 1,
    items: [],
  });
  const client: MemoryV3LifecycleRpcClient = {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === "reserve_memory_v3_dialogue_run") {
        return {
          data: [{
            result: "reserved",
            run_id: "66666666-6666-4666-8666-666666666666",
            expected_state_revision: 0,
            state: fakeState(args.p_conversation_id as string, 0),
          }],
          error: null,
        };
      }
      throw new Error("unexpected rpc: " + name);
    },
  };
  const store = createMemoryV3DialogueStore(client);
  const inputFor = (conversationId: string) => ({
    userId: NASTYA, conversationId, pipelineVersion: "memory-v3-dialogue-v1" as const,
    extractorVersion: "test-v1", reconcilerVersion: "test-v1", model: "google/gemini-3.7-flash" as const,
    inputHash: "a".repeat(64), sourceLastMessageId: MESSAGE_ID,
    sourceLastCreatedAt: "2026-09-22T10:00:00.000Z", messageCount: 1, userMessageCount: 1,
  });
  const resultA = await store.reserve(inputFor(CONVERSATION_A));
  const resultB = await store.reserve(inputFor(CONVERSATION_B));
  assert.equal(resultA.status, "reserved");
  assert.equal(resultB.status, "reserved");
  assert.equal(rpcCalls[0].args.p_conversation_id, CONVERSATION_A);
  assert.equal(rpcCalls[1].args.p_conversation_id, CONVERSATION_B);
  console.log("✓ two conversations reserve independently, each keyed by its own conversation_id");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts`
Expected: FAIL — `dialogueStore.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Implement**

Create `dialogueStore.ts` by copying `lifecycleStore.ts` in full, applying exactly the same mechanical replacement list as Step 1 above (name swaps only — every adversarial-hardening helper: `inspectClient`, `record`, `projectedRecord`, `array`, `cloneJson`, `isoDateTime`, etc. stays byte-for-byte identical, this file's whole value is that it does NOT deviate from the proven validation style) — **including changing the top `import ... from "./lifecycleContract.ts"` to `import ... from "./dialogueContract.ts"`** (the file created in Step 0), plus these two real (non-mechanical) differences:

1. `projectExtraction`'s item validation (around the line that currently reads `item.scope !== "cross_conversation" || item.conversationId !== null`) becomes:
```typescript
if (item.scope !== "conversation" || typeof item.conversationId !== "string" || !UUID.test(item.conversationId)) throw fail();
```
2. `apply`'s RPC call gains `p_conversation_id: input.conversationId` in its `callRpc(client, "apply_memory_v3_dialogue_state", { ... })` argument object (the `MemoryV3LifecycleSuccessWrite`-equivalent input type gains a required `conversationId: string` field, validated the same way `userId` already is — `typeof input.conversationId !== "string" || !UUID.test(input.conversationId)` alongside the existing `userId` check in both `compareAndSwap` and `reserve`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts`
Expected: all cases pass, including the new cross-conversation-independence case.

- [ ] **Step 5: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialogueStore.ts`
Expected: `Found N errors` where N matches the count you get running the identical command against `lifecycleStore.ts` (the same pre-existing unrelated baseline debt applies to both, since both are reached from the same `_shared` module graph) — compare explicitly, do not assume 0.

- [ ] **Step 6: Full regression sweep**

Run: `npx --yes tsx --test $(find supabase/functions/_shared -name "*.cases.test.ts")`
Expected: previous pass count + this task's new test count, same single pre-existing unrelated failure.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueContract.ts supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts supabase/functions/_shared/memoryV3/dialogueStore.ts supabase/functions/_shared/memoryV3/dialogueStore.cases.test.ts
git commit -m "[agent] feat: add dialogue-scoped Memory V3 write store"
```

---

## Task 4: `dialogueReadStore.ts` — read-side TypeScript store

**Files:**
- Create: `supabase/functions/_shared/memoryV3/dialogueReadStore.ts`
- Test: `supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts`

**Interfaces:**
- Consumes: nothing from Task 3 (read and write stores are independent, matching the existing `lifecycleStore.ts` / `lifecycleReadStore.ts` split).
- Produces: `createMemoryV3DialogueReadStore(client: MemoryV3DialogueReadRpcClient): MemoryV3DialogueReadStore` where `MemoryV3DialogueReadStore = { load(userId: string, conversationId: string): Promise<MemoryV3DialogueReadContext | null> }` — note the added `conversationId` parameter on `load`, the one real signature difference from `lifecycleReadStore.ts`'s `load(userId)`.

- [ ] **Step 1: Write the failing test**

Create `dialogueReadStore.cases.test.ts` by copying `lifecycleReadStore.cases.test.ts` in full (if one exists — confirm with `ls supabase/functions/_shared/memoryV3/lifecycleReadStore.cases.test.ts`; if it does not exist, write a new test file following the exact structural style of `contract.cases.test.ts` — numbered comment-delimited cases, a local `assert` helper, `console.log("✓ ...")` per case, a final `console.log("=== ... OK ===")`), applying the same mechanical name-swap list as Task 3 plus `load_memory_v3_lifecycle_read_context` → `load_memory_v3_dialogue_read_context`.

Add one new case for the added parameter:

```typescript
{
  const calls: Array<{ userId: string; conversationId: string }> = [];
  const client: MemoryV3DialogueReadRpcClient = {
    async rpc(name, args) {
      calls.push({ userId: args.p_user_id as string, conversationId: args.p_conversation_id as string });
      return {
        data: {
          schemaVersion: "memory-v3-dialogue-read-context-v1",
          stateRevision: 3,
          items: [],
        },
        error: null,
      };
    },
  };
  const store = createMemoryV3DialogueReadStore(client);
  const result = await store.load(NASTYA, CONVERSATION_A);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, NASTYA);
  assert.equal(calls[0].conversationId, CONVERSATION_A);
  assert.equal(result?.stateRevision, 3);
  console.log("✓ load() passes both userId and conversationId through to the RPC");
}
```
(define `CONVERSATION_A = "44444444-4444-4444-8444-444444444444"` alongside the file's existing `NASTYA` constant if not already present)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts` (or `npx --yes tsx --test ...` if the file uses `node:test` — match whichever the source file you copied from actually uses)
Expected: FAIL — `dialogueReadStore.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `dialogueReadStore.ts` by copying `lifecycleReadStore.ts` in full, applying the same mechanical replacement list, plus these real differences:

1. `MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION` → `MEMORY_V3_DIALOGUE_READ_SCHEMA_VERSION = "memory-v3-dialogue-read-context-v1"`.
2. `MemoryV3LifecycleReadStore.load(userId: string)` → `MemoryV3DialogueReadStore.load(userId: string, conversationId: string)`.
3. `callRpc`'s signature gains `conversationId: string` and its RPC args object becomes `{ p_user_id: userId, p_conversation_id: conversationId }` (currently `{ p_user_id: userId }` only), and it calls `"load_memory_v3_dialogue_read_context"` instead of `"load_memory_v3_lifecycle_read_context"`.
4. Inside `createMemoryV3DialogueReadStore(...).load`, add the same `UUID.test(conversationId)` guard that already exists for `userId`, throwing `fail()` on failure — both parameters get equal validation rigor.

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: all cases pass.

- [ ] **Step 5: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/dialogueReadStore.ts`
Expected: same error count as the equivalent check against `lifecycleReadStore.ts`.

- [ ] **Step 6: Full regression sweep**

Run: `npx --yes tsx --test $(find supabase/functions/_shared -name "*.cases.test.ts")`
Expected: previous count + this task's new cases, same single pre-existing unrelated failure.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/dialogueReadStore.ts supabase/functions/_shared/memoryV3/dialogueReadStore.cases.test.ts
git commit -m "[agent] feat: add dialogue-scoped Memory V3 read store"
```

---

## Task 5: Final sweep and PR

**Files:** none new — this task only verifies and packages Tasks 1–4.

- [x] **Step 1: Full baseline comparison**

Done: `deno check` on `staysee-chat/index.ts` — 41/41, unchanged from main throughout every task. Full `_shared` suite — 603/604 (main's 461 baseline + 142 new cases across Tasks 2–4), same single pre-existing `narrativeEngine.cases.test.ts` failure, confirmed unrelated on unmodified main earlier this session.

- [x] **Step 2: Confirm zero live wiring**

Done, and better than planned: `staysee-chat/index.ts` does not appear in `git diff main --stat` at all — Task 2's call-site update landed in `shadowRunner.ts` and `lifecycleShadowRunner.ts` instead (two production call sites were found, not the one the plan anticipated). No `.env`, no `supabase/config.toml`, only one migration (`039_memory_v3_dialogue_isolation.sql`) in the diff.

- [x] **Step 3: Push and open PR**

```bash
git push -u origin <feature-branch-name>
gh pr create --title "feat: dialogue-isolated Memory V3 storage foundation" --body "$(cat <<'EOF'
## Summary
Implements domain 1 of docs/superpowers/specs/2026-09-22-memory-v3-dialogue-isolation-design.md (PR #49): new memory_v3_dialogue_* tables/RPCs keyed by (user_id, conversation_id), contract.ts now accepts a real conversationId via a new required scopeMode parameter, new dialogueStore.ts/dialogueReadStore.ts TypeScript layer mirroring the existing lifecycle store test-for-test plus one new cross-conversation-independence test.

Zero live behavior change: no wiring into staysee-chat/index.ts beyond the one call-site argument update needed to keep existing behavior identical, no migration deployed, no env var read, no paid calls. Domain 2 (live wiring) and domain 3 (deploy/activation) are separate future gates per the design doc.

## Test plan
- [x] deno check on staysee-chat/index.ts: same error count as main
- [x] Full _shared suite: same pass count as main plus new cases, same single pre-existing unrelated failure
- [x] New cross-conversation-independence test proves two conversations reserve/apply without interfering

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Do not merge — per this session's established process, merge/deploy decisions go to the product owner or the Codex-based agent with production access.
