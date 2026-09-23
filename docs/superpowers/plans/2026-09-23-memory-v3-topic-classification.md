# Memory V3 Topic Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Memory V3 item (account-wide "lifecycle" scope and per-dialogue scope) an AI-classified `topic`, decided by the reconciler step, so the viewer screen can group records the way the two old memory screens already do instead of by `event`/`recurrence` kind.

**Architecture:** Topic is a new, scope-specific enum field the reconciler LLM call outputs on every `create`/`revise` operation (and `null` on every other operation type), validated and persisted end to end through the same contract/reducer/RPC pipeline that already exists for every other item field. The extractor and its frozen prompt are untouched. A one-time standalone Node script backfills topic for the handful of pre-existing untagged items, logged as a `technical` spend.

**Tech Stack:** Deno edge functions (Supabase), Postgres/PL-pgSQL migrations, Node/tsx for `.cases.test.ts` and the backfill script, React/TypeScript frontend (Vite).

## Global Constraints

- Dialogue-scope topic enum: `person` (Люди), `fact` (Факты), `preference` (Предпочтения общения).
- Lifecycle-scope topic enum: `life_context` (Факты профиля), `communication` (Стиль общения), `preference` (Что помогает в контакте).
- `topic` is nullable at the DB layer (existing rows have none yet); `create`/`revise` reconciler operations must always supply a non-null value from that scope's enum; every other operation type (`confirm`/`mark_stale`/`reject`/`ignore`) must supply exactly `null`.
- Topic is display-only — never read by the live chat prompt-building code, never sent back to the extractor.
- Every backend change is verified against a pre-change baseline (`git stash` or equivalent) for zero new type-check/test regressions, per this repo's established discipline.
- No React component test harness exists in this repo — frontend tasks verify via `npm run typecheck`, `npx eslint <file>`, `npm run build` only.
- I (the agent executing this) cannot run anything against the production Supabase project (no `db push`, no `functions deploy`, no running the backfill script for real) and cannot merge the final PR without the user's explicit real-time confirmation. The last task stops at "PR opened."

---

### Task 1: Add nullable `topic` column to both item tables

**Files:**
- Create: `supabase/migrations/20260924090000_044_memory_v3_topic_columns.sql`
- Test: `supabase/functions/_shared/memoryV3/topicColumnsMigration.cases.test.ts`

**Interfaces:**
- Produces: a `topic text` column (nullable) on `memory_v3_lifecycle_shadow_items` and `memory_v3_dialogue_items`, each with its own `CHECK` constraint restricting non-null values to that scope's 3-value enum. Later tasks' `INSERT`/`SELECT` statements read and write this column by name.

- [ ] **Step 1: Write the migration**

```sql
-- Adds a nullable topic classification to both Memory V3 item tables, so the
-- viewer screen can group records by subject (Люди/Факты/Предпочтения for
-- dialogue scope, Факты профиля/Стиль общения/Что помогает в контакте for
-- lifecycle scope) instead of by event/recurrence kind. Nullable because a
-- migration is instant but classifying the handful of pre-existing rows
-- needs one AI call per row (see the standalone backfill script) -- the two
-- steps cannot happen atomically. NOT NULL is intentionally not enforced;
-- the viewer groups any null-topic row into a "Разное" bucket until the
-- backfill (or the next revise) fills it in.

ALTER TABLE public.memory_v3_lifecycle_shadow_items
  ADD COLUMN IF NOT EXISTS topic text NULL
    CHECK (topic IS NULL OR topic IN ('life_context', 'communication', 'preference'));

ALTER TABLE public.memory_v3_dialogue_items
  ADD COLUMN IF NOT EXISTS topic text NULL
    CHECK (topic IS NULL OR topic IN ('person', 'fact', 'preference'));
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
  join(here, "..", "..", "..", "migrations", "20260924090000_044_memory_v3_topic_columns.sql"),
  "utf8",
);

describe("Memory V3 topic columns migration", () => {
  it("adds a nullable topic column to the lifecycle items table with the life_context/communication/preference enum", () => {
    assert.match(
      sql,
      /ALTER TABLE public\.memory_v3_lifecycle_shadow_items\s+ADD COLUMN IF NOT EXISTS topic text NULL\s+CHECK \(topic IS NULL OR topic IN \('life_context', 'communication', 'preference'\)\)/,
    );
  });

  it("adds a nullable topic column to the dialogue items table with the person/fact/preference enum", () => {
    assert.match(
      sql,
      /ALTER TABLE public\.memory_v3_dialogue_items\s+ADD COLUMN IF NOT EXISTS topic text NULL\s+CHECK \(topic IS NULL OR topic IN \('person', 'fact', 'preference'\)\)/,
    );
  });

  it("never introduces a NOT NULL constraint on either topic column", () => {
    assert.equal(/topic text NOT NULL/.test(sql), false);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/topicColumnsMigration.cases.test.ts`
Expected: 3/3 pass (this is a pure text-matching test against a file that already exists after Step 1, so there is no red/green cycle here — write the migration first, then the test, then run it).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260924090000_044_memory_v3_topic_columns.sql supabase/functions/_shared/memoryV3/topicColumnsMigration.cases.test.ts
git commit -m "feat: add nullable topic column to Memory V3 item tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Persist and round-trip `topic` through the apply-proposal RPCs

**Files:**
- Create: `supabase/migrations/20260924100000_045_memory_v3_topic_apply_state.sql`
- Test: `supabase/functions/_shared/memoryV3/topicApplyStateMigration.cases.test.ts`

**Interfaces:**
- Consumes: the `topic` column from Task 1.
- Produces: `apply_memory_v3_lifecycle_shadow_state` and `apply_memory_v3_dialogue_state` now read/write `topic` in three places each: the `v_current_items` JSON reconstruction (used to detect whether the incoming state actually changed), the item `INSERT` column list, and (implicitly) the JSON the TypeScript reducer already produces in Task 6 (`item->>'topic'`). Later tasks' reducer code must emit a `topic` key on every item object in the state it hands to these RPCs, or every state will read back as `topic: null` after insert.

`apply_memory_v3_lifecycle_shadow_state` currently reads (found in `supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql`, lines 258-397) — reproduce the FULL function body via `CREATE OR REPLACE FUNCTION`, with `topic` added at the three marked spots below (nothing else changes):

- [ ] **Step 1: Write the migration**

```sql
-- Extends apply_memory_v3_lifecycle_shadow_state and apply_memory_v3_dialogue_state
-- (originally defined in 034_memory_v3_lifecycle_shadow.sql and
-- 039_memory_v3_dialogue_isolation.sql) to round-trip the new topic column
-- added in 044_memory_v3_topic_columns.sql. Three touch points per function:
-- the v_current_items reconstruction (used to detect real state changes),
-- the item INSERT column list, and nothing else -- the reducer already
-- decides the value in TypeScript before calling this RPC.

CREATE OR REPLACE FUNCTION public.apply_memory_v3_lifecycle_shadow_state(
  p_run_id uuid, p_user_id uuid, p_expected_state_revision bigint,
  p_state jsonb, p_changed boolean, p_extraction jsonb, p_operations jsonb,
  p_transitions jsonb, p_extractor_usage jsonb, p_reconciler_usage jsonb
)
RETURNS TABLE(result text, resulting_state_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_head public.memory_v3_lifecycle_shadow_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_transition_count integer;
  v_locked_run_id uuid;
  v_run_conversation_id uuid;
  v_current_items jsonb;
  v_current_state jsonb;
  v_actual_changed boolean;
  v_resulting_state_revision bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(p_state) <> 'object'
    OR p_state->>'schemaVersion' <> 'memory-v3-lifecycle-state-v1'
    OR p_state->>'userId' <> p_user_id::text
    OR pg_catalog.jsonb_typeof(p_state->'items') <> 'array'
    OR pg_catalog.jsonb_array_length(p_state->'items') > 100 THEN
    RAISE EXCEPTION 'invalid lifecycle state';
  END IF;
  SELECT COALESCE(pg_catalog.sum(pg_catalog.jsonb_array_length(item->'evidence')), 0)::integer
    INTO v_evidence_count FROM pg_catalog.jsonb_array_elements(p_state->'items') item;
  IF v_evidence_count > 500 THEN RAISE EXCEPTION 'invalid lifecycle state'; END IF;
  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF pg_catalog.jsonb_typeof(p_extraction) <> 'object' OR pg_catalog.jsonb_typeof(p_operations) <> 'array'
    OR pg_catalog.jsonb_typeof(p_transitions) <> 'array' THEN RAISE EXCEPTION 'invalid lifecycle audit'; END IF;
  v_transition_count := pg_catalog.jsonb_array_length(p_transitions);

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = (evidence->>'conversationId')::uuid
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid lifecycle evidence ownership' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_head FROM public.memory_v3_lifecycle_shadow_heads
  WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle head is missing'; END IF;
  SELECT id, conversation_id INTO v_locked_run_id, v_run_conversation_id
    FROM public.memory_v3_lifecycle_shadow_runs
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved'
      AND expected_state_revision = p_expected_state_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run is not reservable'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_extraction->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = v_run_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid lifecycle extraction ownership' USING ERRCODE = '42501'; END IF;
  IF v_head.state_revision <> p_expected_state_revision THEN
    UPDATE public.memory_v3_lifecycle_shadow_runs SET
      status = 'failed', diagnostic_code = 'state_conflict', completed_at = pg_catalog.now()
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
      'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
      'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
      'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
        'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
        'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
        ORDER BY e.conversation_id, e.source_message_id, e.relation COLLATE "C")
        FROM public.memory_v3_lifecycle_shadow_evidence e
        WHERE e.user_id = i.user_id AND e.memory_key = i.memory_key), '[]'::jsonb)
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_current_items
  FROM public.memory_v3_lifecycle_shadow_items i WHERE i.user_id = p_user_id;
  v_current_state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_current_items);
  v_actual_changed := (p_state - 'stateRevision') IS DISTINCT FROM (v_current_state - 'stateRevision');
  IF p_changed IS DISTINCT FROM v_actual_changed THEN
    RAISE EXCEPTION 'invalid lifecycle changed flag';
  END IF;
  v_resulting_state_revision := p_expected_state_revision
    + CASE WHEN v_actual_changed THEN 1 ELSE 0 END;
  IF (p_state->>'stateRevision')::bigint <> v_resulting_state_revision THEN
    RAISE EXCEPTION 'invalid lifecycle revision';
  END IF;

  IF v_actual_changed THEN
    DELETE FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id;
    INSERT INTO public.memory_v3_lifecycle_shadow_items(
      user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,
      alternative, topic, first_seen_at, updated_at, revision)
    SELECT p_user_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
      item->>'topic',
      (item->>'firstSeenAt')::timestamptz, (item->>'updatedAt')::timestamptz, (item->>'revision')::bigint
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item;

    INSERT INTO public.memory_v3_lifecycle_shadow_evidence(
      user_id, memory_key, conversation_id, source_message_id, relation, support_type,
      episode_key, provenance_role, mention_time)
    SELECT p_user_id, item->>'memoryKey', (evidence->>'conversationId')::uuid,
      (evidence->>'sourceMessageId')::uuid, evidence->>'relation', evidence->>'supportType',
      evidence->>'episodeKey', evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence;

    UPDATE public.memory_v3_lifecycle_shadow_heads SET
      state_revision = state_revision + 1,
      next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
      updated_at = pg_catalog.now()
    WHERE user_id = p_user_id;
  END IF;
  resulting_state_revision := v_resulting_state_revision;
  UPDATE public.memory_v3_lifecycle_shadow_runs SET
    status = 'succeeded',
    resulting_state_revision = v_resulting_state_revision,
    extraction = p_extraction, operations = p_operations, transitions = p_transitions,
    item_count = v_item_count, evidence_count = v_evidence_count, transition_count = v_transition_count,
    extractor_prompt_tokens = (p_extractor_usage->>'promptTokens')::integer,
    extractor_completion_tokens = (p_extractor_usage->>'completionTokens')::integer,
    extractor_cost_usd = (p_extractor_usage->>'costUsd')::numeric,
    reconciler_prompt_tokens = (p_reconciler_usage->>'promptTokens')::integer,
    reconciler_completion_tokens = (p_reconciler_usage->>'completionTokens')::integer,
    reconciler_cost_usd = (p_reconciler_usage->>'costUsd')::numeric,
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle run completion failed'; END IF;
  result := 'succeeded'; RETURN NEXT;
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
  v_head public.memory_v3_dialogue_heads%ROWTYPE;
  v_item_count integer;
  v_evidence_count integer;
  v_transition_count integer;
  v_locked_run_id uuid;
  v_current_items jsonb;
  v_current_state jsonb;
  v_actual_changed boolean;
  v_resulting_state_revision bigint;
BEGIN
  IF pg_catalog.jsonb_typeof(p_state) <> 'object'
    OR p_state->>'schemaVersion' <> 'memory-v3-dialogue-state-v1'
    OR p_state->>'userId' <> p_user_id::text
    OR p_state->>'conversationId' <> p_conversation_id::text
    OR pg_catalog.jsonb_typeof(p_state->'items') <> 'array'
    OR pg_catalog.jsonb_array_length(p_state->'items') > 100 THEN
    RAISE EXCEPTION 'invalid dialogue state';
  END IF;
  SELECT COALESCE(pg_catalog.sum(pg_catalog.jsonb_array_length(item->'evidence')), 0)::integer
    INTO v_evidence_count FROM pg_catalog.jsonb_array_elements(p_state->'items') item;
  IF v_evidence_count > 500 THEN RAISE EXCEPTION 'invalid dialogue state'; END IF;
  v_item_count := pg_catalog.jsonb_array_length(p_state->'items');
  IF pg_catalog.jsonb_typeof(p_extraction) <> 'object' OR pg_catalog.jsonb_typeof(p_operations) <> 'array'
    OR pg_catalog.jsonb_typeof(p_transitions) <> 'array' THEN RAISE EXCEPTION 'invalid dialogue audit'; END IF;
  v_transition_count := pg_catalog.jsonb_array_length(p_transitions);

  -- Stricter than the cross-conversation original: evidence must come from THIS
  -- conversation specifically, not just any conversation owned by the user --
  -- that is the entire point of dialogue isolation.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid dialogue evidence ownership' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_head FROM public.memory_v3_dialogue_heads
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue head is missing'; END IF;

  SELECT id INTO v_locked_run_id
    FROM public.memory_v3_dialogue_runs
    WHERE id = p_run_id AND user_id = p_user_id AND conversation_id = p_conversation_id AND status = 'reserved'
      AND expected_state_revision = p_expected_state_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run is not reservable'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_extraction->'evidence') evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = (evidence->>'sourceMessageId')::uuid
        AND m.conversation_id = p_conversation_id
        AND c.user_id = p_user_id
    )
  ) THEN RAISE EXCEPTION 'invalid dialogue extraction ownership' USING ERRCODE = '42501'; END IF;

  IF v_head.state_revision <> p_expected_state_revision THEN
    UPDATE public.memory_v3_dialogue_runs SET
      status = 'failed', diagnostic_code = 'state_conflict', completed_at = pg_catalog.now()
    WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
    result := 'state_conflict'; resulting_state_revision := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key, 'kind', i.kind, 'claim', i.claim, 'status', i.status,
      'sensitivity', i.sensitivity, 'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end, 'alternative', i.alternative, 'topic', i.topic,
      'firstSeenAt', i.first_seen_at, 'updatedAt', i.updated_at, 'revision', i.revision,
      'evidence', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'conversationId', e.conversation_id, 'sourceMessageId', e.source_message_id,
        'relation', e.relation, 'supportType', e.support_type, 'episodeKey', e.episode_key,
        'provenanceRole', e.provenance_role, 'mentionTime', e.mention_time)
        ORDER BY e.source_message_id, e.relation COLLATE "C")
        FROM public.memory_v3_dialogue_evidence e
        WHERE e.user_id = i.user_id AND e.conversation_id = i.conversation_id AND e.memory_key = i.memory_key),
        '[]'::jsonb)
    ) ORDER BY i.memory_key COLLATE "C"), '[]'::jsonb) INTO v_current_items
  FROM public.memory_v3_dialogue_items i WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
  v_current_state := pg_catalog.jsonb_build_object(
    'schemaVersion', v_head.schema_version, 'userId', v_head.user_id, 'conversationId', v_head.conversation_id,
    'stateRevision', v_head.state_revision, 'nextMemoryOrdinal', v_head.next_memory_ordinal,
    'items', v_current_items);
  v_actual_changed := (p_state - 'stateRevision') IS DISTINCT FROM (v_current_state - 'stateRevision');
  IF p_changed IS DISTINCT FROM v_actual_changed THEN
    RAISE EXCEPTION 'invalid dialogue changed flag';
  END IF;
  v_resulting_state_revision := p_expected_state_revision + CASE WHEN v_actual_changed THEN 1 ELSE 0 END;
  IF (p_state->>'stateRevision')::bigint <> v_resulting_state_revision THEN
    RAISE EXCEPTION 'invalid dialogue revision';
  END IF;

  IF v_actual_changed THEN
    DELETE FROM public.memory_v3_dialogue_items WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
    INSERT INTO public.memory_v3_dialogue_items(
      user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,
      alternative, topic, first_seen_at, updated_at, revision)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey', item->>'kind', item->>'claim', item->>'status',
      item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',
      item->>'topic',
      (item->>'firstSeenAt')::timestamptz, (item->>'updatedAt')::timestamptz, (item->>'revision')::bigint
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item;

    INSERT INTO public.memory_v3_dialogue_evidence(
      user_id, conversation_id, memory_key, source_message_id, relation, support_type,
      episode_key, provenance_role, mention_time)
    SELECT p_user_id, p_conversation_id, item->>'memoryKey',
      (evidence->>'sourceMessageId')::uuid, evidence->>'relation', evidence->>'supportType',
      evidence->>'episodeKey', evidence->>'provenanceRole', (evidence->>'mentionTime')::timestamptz
    FROM pg_catalog.jsonb_array_elements(p_state->'items') item,
      pg_catalog.jsonb_array_elements(item->'evidence') evidence;

    UPDATE public.memory_v3_dialogue_heads SET
      state_revision = state_revision + 1,
      next_memory_ordinal = (p_state->>'nextMemoryOrdinal')::bigint,
      updated_at = pg_catalog.now()
    WHERE user_id = p_user_id AND conversation_id = p_conversation_id;
  END IF;
  resulting_state_revision := v_resulting_state_revision;
  UPDATE public.memory_v3_dialogue_runs SET
    status = 'succeeded',
    resulting_state_revision = v_resulting_state_revision,
    extraction = p_extraction, operations = p_operations, transitions = p_transitions,
    item_count = v_item_count, evidence_count = v_evidence_count, transition_count = v_transition_count,
    extractor_prompt_tokens = (p_extractor_usage->>'promptTokens')::integer,
    extractor_completion_tokens = (p_extractor_usage->>'completionTokens')::integer,
    extractor_cost_usd = (p_extractor_usage->>'costUsd')::numeric,
    reconciler_prompt_tokens = (p_reconciler_usage->>'promptTokens')::integer,
    reconciler_completion_tokens = (p_reconciler_usage->>'completionTokens')::integer,
    reconciler_cost_usd = (p_reconciler_usage->>'costUsd')::numeric,
    completed_at = pg_catalog.now()
  WHERE id = p_run_id AND user_id = p_user_id AND status = 'reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'dialogue run completion failed'; END IF;
  result := 'succeeded'; RETURN NEXT;
END;
$$;
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
  join(here, "..", "..", "..", "migrations", "20260924100000_045_memory_v3_topic_apply_state.sql"),
  "utf8",
);

describe("Memory V3 topic apply-state migration", () => {
  it("recreates apply_memory_v3_lifecycle_shadow_state with topic in the current-items reconstruction", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_memory_v3_lifecycle_shadow_state/);
    assert.match(sql, /'alternative', i\.alternative, 'topic', i\.topic,/);
  });

  it("recreates apply_memory_v3_lifecycle_shadow_state's INSERT with a topic column and source", () => {
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_lifecycle_shadow_items\(\s*user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*alternative, topic, first_seen_at, updated_at, revision\)/,
    );
    assert.match(sql, /item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',\s*item->>'topic',/);
  });

  it("recreates apply_memory_v3_dialogue_state with topic in the current-items reconstruction and INSERT", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_memory_v3_dialogue_state/);
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_dialogue_items\(\s*user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*alternative, topic, first_seen_at, updated_at, revision\)/,
    );
  });

  it("does not touch the evidence tables or any other function in these two migrations", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.reserve_memory_v3/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3/.test(sql), false);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/topicApplyStateMigration.cases.test.ts`
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260924100000_045_memory_v3_topic_apply_state.sql supabase/functions/_shared/memoryV3/topicApplyStateMigration.cases.test.ts
git commit -m "feat: round-trip topic through the Memory V3 apply-state RPCs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Add `topic` to the two viewer-read RPCs

**Files:**
- Create: `supabase/migrations/20260924110000_046_memory_v3_viewer_topic.sql`
- Test: `supabase/functions/_shared/memoryV3/viewerTopicMigration.cases.test.ts`

**Interfaces:**
- Consumes: the `topic` column from Task 1.
- Produces: `load_memory_v3_lifecycle_viewer_items(p_user_id)` and `load_memory_v3_dialogue_viewer_items(p_user_id, p_conversation_id)` now include `'topic', i.topic` in their returned JSON. Task 9's `viewerProjection.ts` reads this new field.

- [ ] **Step 1: Write the migration**

```sql
-- Adds topic to the two Memory V3 viewer-read RPCs from
-- 043_memory_v3_viewer_read.sql, so the viewer screen can group by subject.
-- Same deliberate separation from the hot-path read RPCs as the original --
-- this never touches load_memory_v3_lifecycle_read_context or
-- load_memory_v3_dialogue_read_context.

CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_viewer_items(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_lifecycle_shadow_items i
  WHERE i.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_lifecycle_viewer_items(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_lifecycle_viewer_items(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_viewer_items(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_viewer_items(uuid, uuid) TO service_role;
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
  join(here, "..", "..", "..", "migrations", "20260924110000_046_memory_v3_viewer_topic.sql"),
  "utf8",
);

describe("Memory V3 viewer topic migration", () => {
  it("adds topic to load_memory_v3_lifecycle_viewer_items's returned JSON", () => {
    const [, lifecycleBody] = sql.split("load_memory_v3_dialogue_viewer_items");
    assert.match(sql.slice(0, sql.indexOf("load_memory_v3_dialogue_viewer_items")), /'topic', i\.topic/);
    assert.ok(lifecycleBody !== undefined);
  });

  it("adds topic to load_memory_v3_dialogue_viewer_items's returned JSON", () => {
    const dialogueBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items"));
    assert.match(dialogueBody, /'topic', i\.topic/);
  });

  it("still restricts EXECUTE to service_role only, matching the original", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.load_memory_v3_lifecycle_viewer_items\(uuid\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_lifecycle_viewer_items\(uuid\) TO service_role;/);
  });

  it("never touches the hot-path read context RPCs", () => {
    assert.equal(/load_memory_v3_lifecycle_read_context/.test(sql), false);
    assert.equal(/load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerTopicMigration.cases.test.ts`
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260924110000_046_memory_v3_viewer_topic.sql supabase/functions/_shared/memoryV3/viewerTopicMigration.cases.test.ts
git commit -m "feat: return topic from the Memory V3 viewer-read RPCs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `cost_category` column on `ai_usage_logs` (automatic vs technical)

**Files:**
- Create: `supabase/migrations/20260924120000_047_ai_usage_logs_cost_category.sql`
- Modify: `supabase/functions/_shared/usageAnalytics.ts`
- Test: Create `supabase/functions/_shared/usageAnalytics.cases.test.ts` (this file does not exist yet — check with `ls supabase/functions/_shared/usageAnalytics*` first; if it already exists by the time you run this task, add to it instead of overwriting)

**Interfaces:**
- Produces: `UsageLogRow` gains `costCategory: "automatic" | "technical"`, defaulting to `"automatic"` inside `buildUsageLogRow` when the caller doesn't specify one. `logOpenRouterUsage` writes it to the new `cost_category` column. Task 12's backfill script writes `cost_category: 'technical'` directly via its own plain `INSERT` (it does not import this Deno-only module).

- [ ] **Step 1: Write the migration**

```sql
-- Splits ai_usage_logs (built in 040_memory_v3_lifecycle_cost_tracking.sql)
-- into automatic spend (anything the system does on its own in response to
-- real user activity: chat replies, summaries, cross-memory synthesis, both
-- Memory V3 extractor/reconciler stages) versus technical spend (manual,
-- one-off invocations: this project's backfill scripts, future smoke
-- tests). Defaults to 'technical' -- every row logged so far is
-- development-phase spend with no real outside users yet, so the default
-- correctly reclassifies all history without a separate backfill UPDATE.
-- Everything logged through buildUsageLogRow from this point on defaults to
-- 'automatic' instead (see usageAnalytics.ts); only a caller that
-- explicitly asks for 'technical' gets it.

ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS cost_category text NOT NULL DEFAULT 'technical'
    CHECK (cost_category IN ('automatic', 'technical'));
```

- [ ] **Step 2: Read `usageAnalytics.ts`'s current `UsageLogRow`/`buildUsageLogRow`/`logOpenRouterUsage`**

Run: `sed -n '44,190p' supabase/functions/_shared/usageAnalytics.ts` and confirm the three pieces below still match what's on disk before editing (this file was last touched today in PR #52 -- if it has changed since, adapt the edits to the current shape rather than blindly overwriting).

- [ ] **Step 3: Add `costCategory` to the type, the builder, and the insert**

In `supabase/functions/_shared/usageAnalytics.ts`, change:

```typescript
export interface UsageLogRow extends UsageAuditFields {
  userId: string;
  conversationId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  memoryTokens: number;
  summaryTokens: number;
  cost: number;
  callKind?: UsageCallKind | null;
}
```

to:

```typescript
export type UsageCostCategory = "automatic" | "technical";

export interface UsageLogRow extends UsageAuditFields {
  userId: string;
  conversationId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  memoryTokens: number;
  summaryTokens: number;
  cost: number;
  callKind?: UsageCallKind | null;
  costCategory: UsageCostCategory;
}
```

In `buildUsageLogRow`'s input type, add the optional field, and in its return object default it to `"automatic"`:

```typescript
export function buildUsageLogRow(input: {
  userId: string;
  conversationId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usage?: OpenRouterUsagePayload;
  packet?: ContextPacket | null;
  memoryTokens?: number;
  summaryTokens?: number;
  audit?: UsageAuditFields;
  callKind?: UsageCallKind | null;
  costCategory?: UsageCostCategory;
}): UsageLogRow {
```

and in the returned object, add:

```typescript
    cost,
    callKind: input.callKind ?? null,
    costCategory: input.costCategory ?? "automatic",
```

(insert `costCategory` right after `callKind` in the returned object literal, matching the property order already used for the other optional-with-default fields.)

In `logOpenRouterUsage`'s insert, add the column:

```typescript
  const { error } = await supabase.from("ai_usage_logs").insert({
    user_id: row.userId,
    conversation_id: row.conversationId,
    model: row.model,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    total_tokens: row.totalTokens,
    memory_tokens: row.memoryTokens,
    summary_tokens: row.summaryTokens,
    cost: row.cost,
    call_kind: row.callKind ?? null,
    cost_category: row.costCategory,
```

(insert `cost_category: row.costCategory,` right after `call_kind`, before `request_id`.)

- [ ] **Step 4: Write the test**

Create `supabase/functions/_shared/usageAnalytics.cases.test.ts` (or add to it if it already exists):

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUsageLogRow } from "./usageAnalytics.ts";

describe("usageAnalytics cost category", () => {
  it("defaults costCategory to automatic when the caller does not specify one", () => {
    const row = buildUsageLogRow({
      userId: "11111111-1111-4111-8111-111111111111",
      model: "google/gemini-3.7-flash",
      promptTokens: 10,
      completionTokens: 5,
      memoryTokens: 0,
      summaryTokens: 0,
    });
    assert.equal(row.costCategory, "automatic");
  });

  it("respects an explicit technical costCategory", () => {
    const row = buildUsageLogRow({
      userId: "11111111-1111-4111-8111-111111111111",
      model: "google/gemini-3.7-flash",
      promptTokens: 10,
      completionTokens: 5,
      memoryTokens: 0,
      summaryTokens: 0,
      costCategory: "technical",
    });
    assert.equal(row.costCategory, "technical");
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/usageAnalytics.cases.test.ts`
Expected: 2/2 pass.

- [ ] **Step 6: Type-check against baseline**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/usageAnalytics.ts`
Compare the error count against `git stash` on the same command — expect identical counts (this file has pre-existing unrelated errors from other imports in its tree; the point is zero *new* ones).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260924120000_047_ai_usage_logs_cost_category.sql supabase/functions/_shared/usageAnalytics.ts supabase/functions/_shared/usageAnalytics.cases.test.ts
git commit -m "feat: split ai_usage_logs into automatic vs technical spend

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Topic enums and per-operation validation in the two contract files

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleContract.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueContract.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts` (add to existing if present, else create)
- Test: `supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts` (add to existing if present, else create)

**Interfaces:**
- Produces: `MemoryV3LifecycleItem`/`MemoryV3DialogueItem` gain `topic: LifecycleTopic | null` / `topic: DialogueTopic | null`. `MemoryV3LifecycleProposal`/`MemoryV3DialogueProposal` (the internal, key-based operation array) gain `topic` on every entry. `validateMemoryV3LifecycleProposal`/`validateMemoryV3DialogueProposal` now require the model's wire-shaped operation object to carry a 4th key, `topic`, enforced as: non-null enum member for `create`/`revise`, exactly `null` for every other type.
- Consumes: nothing new from other tasks (this is the ground truth other tasks build on).

**In `lifecycleContract.ts`:**

- [ ] **Step 1: Add the topic enum and item field**

Change:

```typescript
type MemoryKind = "event" | "recurrence" | "hypothesis";
type EvidenceRelation = "supports" | "contradicts" | "corrects" | "rejects";
type SupportType = "episode_observation" | "pattern_confirmation" | "scope_boundary";
```

to:

```typescript
type MemoryKind = "event" | "recurrence" | "hypothesis";
type EvidenceRelation = "supports" | "contradicts" | "corrects" | "rejects";
type SupportType = "episode_observation" | "pattern_confirmation" | "scope_boundary";

export const MEMORY_V3_LIFECYCLE_TOPICS = ["life_context", "communication", "preference"] as const;
export type MemoryV3LifecycleTopic = (typeof MEMORY_V3_LIFECYCLE_TOPICS)[number];
```

Change the item interface:

```typescript
export interface MemoryV3LifecycleItem {
  memoryKey: string;
  kind: MemoryKind;
  claim: string;
  status: string;
  sensitivity: "normal" | "sensitive";
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  alternative: string | null;
  firstSeenAt: string;
  updatedAt: string;
  revision: number;
  evidence: MemoryV3LifecycleEvidence[];
}
```

to:

```typescript
export interface MemoryV3LifecycleItem {
  memoryKey: string;
  kind: MemoryKind;
  claim: string;
  status: string;
  sensitivity: "normal" | "sensitive";
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  alternative: string | null;
  topic: MemoryV3LifecycleTopic | null;
  firstSeenAt: string;
  updatedAt: string;
  revision: number;
  evidence: MemoryV3LifecycleEvidence[];
}
```

Change the proposal type:

```typescript
export type MemoryV3LifecycleProposal = Array<{
  type: MemoryV3LifecycleOperationType;
  candidateLocalItemKey: string;
  targetMemoryKey: string | null;
}>;
```

to:

```typescript
export type MemoryV3LifecycleProposal = Array<{
  type: MemoryV3LifecycleOperationType;
  candidateLocalItemKey: string;
  targetMemoryKey: string | null;
  topic: MemoryV3LifecycleTopic | null;
}>;
```

Change the field-list constants:

```typescript
const ITEM_FIELDS = [
  "memoryKey", "kind", "claim", "status", "sensitivity", "eventTimeStart",
  "eventTimeEnd", "alternative", "firstSeenAt", "updatedAt", "revision", "evidence",
] as const;
```

to:

```typescript
const ITEM_FIELDS = [
  "memoryKey", "kind", "claim", "status", "sensitivity", "eventTimeStart",
  "eventTimeEnd", "alternative", "topic", "firstSeenAt", "updatedAt", "revision", "evidence",
] as const;
```

and:

```typescript
const MODEL_OPERATION_FIELDS = ["type", "candidateRef", "targetMemoryRef"] as const;
```

to:

```typescript
const MODEL_OPERATION_FIELDS = ["type", "candidateRef", "targetMemoryRef", "topic"] as const;
```

- [ ] **Step 2: Validate `topic` inside `validateStateInternal`'s per-item mapping**

In the `items = rawItems.map((raw): MemoryV3LifecycleItem => { ... })` body, right after the existing block that checks `item.kind`/`item.claim`/`item.sensitivity` (the `if (typeof item.memoryKey !== "string" || ... ) fail(token, code);` block), add:

```typescript
    if (item.topic !== null && !MEMORY_V3_LIFECYCLE_TOPICS.includes(item.topic as MemoryV3LifecycleTopic)) {
      fail(token, code);
    }
```

- [ ] **Step 3: Validate `topic` per operation type inside `validateMemoryV3LifecycleProposal`**

The current per-operation loop body is:

```typescript
    for (const operation of operations) {
      if (!OPERATION_TYPES.includes(operation.type as MemoryV3LifecycleOperationType) || !nonEmpty(operation.candidateRef)) {
        fail(token, code);
      }
      const localItemKey = candidateByRef.get(operation.candidateRef);
      if (!localItemKey || consumed.has(localItemKey)) fail(token, code);
      consumed.add(localItemKey);
      const candidate = candidateByKey.get(localItemKey)!;
      const type = operation.type as MemoryV3LifecycleOperationType;
      let targetMemoryKey: string | null = null;
      if (type === "create" || type === "ignore") {
        ...
      } else {
        ...
      }
      translated.push({ type, candidateLocalItemKey: localItemKey, targetMemoryKey });
    }
```

Change it to add the topic check right after `const type = operation.type as MemoryV3LifecycleOperationType;` and thread `topic` into the pushed object:

```typescript
    for (const operation of operations) {
      if (!OPERATION_TYPES.includes(operation.type as MemoryV3LifecycleOperationType) || !nonEmpty(operation.candidateRef)) {
        fail(token, code);
      }
      const localItemKey = candidateByRef.get(operation.candidateRef);
      if (!localItemKey || consumed.has(localItemKey)) fail(token, code);
      consumed.add(localItemKey);
      const candidate = candidateByKey.get(localItemKey)!;
      const type = operation.type as MemoryV3LifecycleOperationType;
      const requiresTopic = type === "create" || type === "revise";
      if (requiresTopic
        ? (operation.topic === null || !MEMORY_V3_LIFECYCLE_TOPICS.includes(operation.topic as MemoryV3LifecycleTopic))
        : operation.topic !== null) fail(token, code);
      const topic = operation.topic as MemoryV3LifecycleTopic | null;
      let targetMemoryKey: string | null = null;
      if (type === "create" || type === "ignore") {
        ...
      } else {
        ...
      }
      translated.push({ type, candidateLocalItemKey: localItemKey, targetMemoryKey, topic });
    }
```

(Keep the existing `if (type === "create" || type === "ignore") { ... } else { ... }` block exactly as it is — only the lines shown above change.)

**In `dialogueContract.ts`:** apply the identical four edits from Steps 1-3, with these substitutions: `MEMORY_V3_LIFECYCLE_TOPICS` → `MEMORY_V3_DIALOGUE_TOPICS`, its values → `["person", "fact", "preference"]`, `MemoryV3LifecycleTopic` → `MemoryV3DialogueTopic`, `MemoryV3LifecycleItem` → `MemoryV3DialogueItem`, `MemoryV3LifecycleProposal` → `MemoryV3DialogueProposal`, `MemoryV3LifecycleOperationType` → `MemoryV3DialogueOperationType`. The surrounding file structure (confirmed identical today, same constant names at the same relative positions: `ITEM_FIELDS`, `MODEL_OPERATION_FIELDS`, the `validateMemoryV3DialogueProposal` per-operation loop) mirrors `lifecycleContract.ts` exactly — read `dialogueContract.ts` once before editing to confirm nothing has drifted, then apply the same four edits.

- [ ] **Step 4: Write the tests**

In `lifecycleContract.cases.test.ts` (create if it doesn't exist yet — check first with `ls supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts`):

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MEMORY_V3_LIFECYCLE_TOPICS,
  validateMemoryV3LifecycleProposal,
} from "./lifecycleContract.ts";

function baseState(userId: string) {
  return {
    schemaVersion: "memory-v3-lifecycle-state-v1",
    userId,
    stateRevision: 0,
    nextMemoryOrdinal: 1,
    items: [],
  };
}

function baseExtraction(localItemKey: string) {
  return {
    run: { caseId: "case-1", extractorVersion: "v1" },
    items: [{
      localItemKey, kind: "event", claim: "переезд в Казань", scope: "cross_conversation",
      conversationId: null, eventTimeStart: null, eventTimeEnd: null, status: "active",
      sensitivity: "normal", alternative: null,
    }],
    evidence: [{
      itemKey: localItemKey, sourceMessageId: "m1", relation: "supports", supportType: null,
      episodeKey: "episode:m1", provenanceRole: "user", mentionTime: "2026-09-24T10:00:00.000Z",
    }],
  };
}

function bindings(localItemKey: string) {
  return {
    memories: [],
    candidates: [{ candidateRef: "candidate:0001", localItemKey }],
  };
}

describe("Memory V3 lifecycle contract topic", () => {
  it("requires a valid topic on a create operation", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: bindings("item-1") };
    for (const topic of MEMORY_V3_LIFECYCLE_TOPICS) {
      const result = validateMemoryV3LifecycleProposal(
        { operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic }] },
        context,
      );
      assert.equal(result[0].topic, topic);
    }
  });

  it("rejects a create operation with a null topic", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: bindings("item-1") };
    assert.throws(() => validateMemoryV3LifecycleProposal(
      { operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic: null }] },
      context,
    ));
  });

  it("rejects a create operation with a topic from the wrong scope's enum", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: bindings("item-1") };
    assert.throws(() => validateMemoryV3LifecycleProposal(
      { operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic: "person" }] },
      context,
    ));
  });

  it("rejects an ignore operation that supplies a non-null topic", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: bindings("item-1") };
    assert.throws(() => validateMemoryV3LifecycleProposal(
      { operations: [{ type: "ignore", candidateRef: "candidate:0001", targetMemoryRef: null, topic: "life_context" }] },
      context,
    ));
  });
});
```

In `dialogueContract.cases.test.ts` (create if it doesn't exist yet), write the mirror of the four tests above: same structure, `MEMORY_V3_DIALOGUE_TOPICS` (`person`/`fact`/`preference`) in place of `MEMORY_V3_LIFECYCLE_TOPICS`, `validateMemoryV3DialogueProposal` in place of `validateMemoryV3LifecycleProposal`, and the "wrong scope's enum" test asserting that `topic: "life_context"` (a lifecycle-only value) is rejected on a dialogue create. `baseExtraction`'s `conversationId` field will need a real UUID string instead of `null` and `baseState`/`bindings` need the dialogue schema's extra `conversationId` field — read `dialogueContract.ts`'s `validateMemoryV3DialogueState`/`EXTRACTION_ITEM_FIELDS` first to get the exact required shape right before writing this test file.

- [ ] **Step 5: Run both test files and verify they pass**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts`
Expected: all new tests pass, and none of the pre-existing tests in either file regress (run the full file, not just the new `describe` block).

- [ ] **Step 6: Type-check against baseline**

Run `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/lifecycleContract.ts supabase/functions/_shared/memoryV3/dialogueContract.ts` before and after (via `git stash`) — expect identical error counts.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleContract.ts supabase/functions/_shared/memoryV3/dialogueContract.ts supabase/functions/_shared/memoryV3/lifecycleContract.cases.test.ts supabase/functions/_shared/memoryV3/dialogueContract.cases.test.ts
git commit -m "feat: add scope-specific topic enums and validation to Memory V3 contracts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Thread `topic` through the two reducers

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReducer.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueReducer.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts` (add to existing)
- Test: `supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts` (add to existing)

**Interfaces:**
- Consumes: `MemoryV3LifecycleProposal`/`MemoryV3DialogueProposal` with `topic` from Task 5.
- Produces: `applyMemoryV3LifecycleStep`/`applyMemoryV3DialogueStep` write `topic` on `create`, re-decide it on `revise` (bumping revision when topic differs even if every other field is identical), and leave it untouched on `confirm`/`mark_stale`/`reject`.

**In `lifecycleReducer.ts`:**

- [ ] **Step 1: Add `topic` to `INTERNAL_OPERATION_FIELDS` and thread it through `validateInternalProposal`**

Change:

```typescript
const INTERNAL_OPERATION_FIELDS = ["type", "candidateLocalItemKey", "targetMemoryKey"] as const;
```

to:

```typescript
const INTERNAL_OPERATION_FIELDS = ["type", "candidateLocalItemKey", "targetMemoryKey", "topic"] as const;
```

In `validateInternalProposal`, the current per-row mapping is:

```typescript
  const operations = cloned.map((raw) => {
    const row = inspectRecord(token, raw, INTERNAL_OPERATION_FIELDS);
    if (!OPERATION_TYPES.includes(row.type as MemoryV3LifecycleOperationType) ||
        typeof row.candidateLocalItemKey !== "string" || !candidateRefByKey.has(row.candidateLocalItemKey) ||
        (row.targetMemoryKey !== null &&
          (typeof row.targetMemoryKey !== "string" || !MEMORY_KEY.test(row.targetMemoryKey) ||
            !memoryRefByKey.has(row.targetMemoryKey)))) {
      fail(token, "lifecycle_reducer_invalid_input");
    }
    const candidateLocalItemKey = row.candidateLocalItemKey as string;
    const targetMemoryKey = row.targetMemoryKey as string | null;
    return {
      type: row.type,
      candidateRef: candidateRefByKey.get(candidateLocalItemKey),
      targetMemoryRef: targetMemoryKey === null ? null : memoryRefByKey.get(targetMemoryKey),
    };
  });
```

Change to:

```typescript
  const operations = cloned.map((raw) => {
    const row = inspectRecord(token, raw, INTERNAL_OPERATION_FIELDS);
    if (!OPERATION_TYPES.includes(row.type as MemoryV3LifecycleOperationType) ||
        typeof row.candidateLocalItemKey !== "string" || !candidateRefByKey.has(row.candidateLocalItemKey) ||
        (row.targetMemoryKey !== null &&
          (typeof row.targetMemoryKey !== "string" || !MEMORY_KEY.test(row.targetMemoryKey) ||
            !memoryRefByKey.has(row.targetMemoryKey))) ||
        (row.topic !== null && typeof row.topic !== "string")) {
      fail(token, "lifecycle_reducer_invalid_input");
    }
    const candidateLocalItemKey = row.candidateLocalItemKey as string;
    const targetMemoryKey = row.targetMemoryKey as string | null;
    return {
      type: row.type,
      candidateRef: candidateRefByKey.get(candidateLocalItemKey),
      targetMemoryRef: targetMemoryKey === null ? null : memoryRefByKey.get(targetMemoryKey),
      topic: row.topic as string | null,
    };
  });
```

(The full enum-membership + per-type null/non-null check still happens inside the `validateMemoryV3LifecycleProposal` call right below this map, which now receives `topic` in the reconstructed object — no further change needed there.)

- [ ] **Step 2: Write `topic` on `create`, re-decide it on `revise`**

The `create` branch currently reads:

```typescript
      if (operation.type === "create") {
        resultingMemoryKey = await memoryKeyFor(working.userId, working.nextMemoryOrdinal);
        if (working.items.some((item) => item.memoryKey === resultingMemoryKey)) {
          fail(token, "lifecycle_reducer_transition_invalid");
        }
        working.items.push({
          memoryKey: resultingMemoryKey,
          ...materialFromCandidate(candidate),
          firstSeenAt: projected.at,
          updatedAt: projected.at,
          revision: 1,
          evidence: incomingEvidence,
        } as MemoryV3LifecycleItem);
        working.nextMemoryOrdinal += 1;
```

Change the `working.items.push` call to add `topic`:

```typescript
        working.items.push({
          memoryKey: resultingMemoryKey,
          ...materialFromCandidate(candidate),
          topic: operation.topic,
          firstSeenAt: projected.at,
          updatedAt: projected.at,
          revision: 1,
          evidence: incomingEvidence,
        } as MemoryV3LifecycleItem);
```

The `revise` branch currently reads:

```typescript
        } else if (operation.type === "revise") {
          const candidateMaterial = materialFromCandidate(candidate);
          const targetMaterial = Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, target[field]]));
          working.items[index] = canonicalStringify(candidateMaterial) === canonicalStringify(targetMaterial)
            ? { ...target, evidence }
            : {
              ...target,
              ...candidateMaterial,
              updatedAt: projected.at,
              revision: target.revision + 1,
              evidence,
            } as MemoryV3LifecycleItem;
        } else {
```

Change to (topic is compared separately from `MATERIAL_FIELDS` since it never comes from the extraction candidate — it's the reconciler's own decision, so a topic-only change must still count as a real revision):

```typescript
        } else if (operation.type === "revise") {
          const candidateMaterial = materialFromCandidate(candidate);
          const targetMaterial = Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, target[field]]));
          const topicChanged = operation.topic !== target.topic;
          const materialUnchanged = !topicChanged &&
            canonicalStringify(candidateMaterial) === canonicalStringify(targetMaterial);
          working.items[index] = materialUnchanged
            ? { ...target, evidence }
            : {
              ...target,
              ...candidateMaterial,
              topic: operation.topic,
              updatedAt: projected.at,
              revision: target.revision + 1,
              evidence,
            } as MemoryV3LifecycleItem;
        } else {
```

Leave the final `else` branch (confirm/mark_stale/reject) completely untouched — it already does `{ ...target, ... }`, which carries `target.topic` forward unchanged since `topic` is now part of every stored `target` object.

**In `dialogueReducer.ts`:** apply the identical two edits (Steps 1-2) with `MemoryV3LifecycleOperationType` → `MemoryV3DialogueOperationType`, `MemoryV3LifecycleItem` → `MemoryV3DialogueItem`; everything else (variable names, branch structure) is already named identically in both files (confirmed today: both use `working`, `target`, `candidateMaterial`, `targetMaterial`, `MATERIAL_FIELDS`).

- [ ] **Step 3: Write the tests**

First check whether `lifecycleReducer.cases.test.ts` already has fixture-building helpers for a minimal state/extraction/proposal (`grep -n "^function\|^const" supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts`). If it does, use those helpers instead of the inline literals below (same values, just built through the existing helper calls) — do not maintain two parallel ways of constructing fixtures in one file. If it doesn't, add this self-contained `describe` block as-is:

```typescript
describe("Memory V3 lifecycle reducer topic", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
  const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

  function extraction(localItemKey: string, claim: string) {
    return {
      run: { caseId: "case-1", extractorVersion: "v1" },
      items: [{
        localItemKey, kind: "event", claim, scope: "cross_conversation", conversationId: null,
        eventTimeStart: null, eventTimeEnd: null, status: "active", sensitivity: "normal", alternative: null,
      }],
      evidence: [{
        itemKey: localItemKey, sourceMessageId: MESSAGE_ID, relation: "supports", supportType: null,
        episodeKey: "episode:m1", provenanceRole: "user", mentionTime: "2026-09-24T10:00:00.000Z",
      }],
    };
  }

  it("writes the operation's topic on a create", async () => {
    const state = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    const result = await applyMemoryV3LifecycleStep({
      state, at: "2026-09-24T10:05:00.000Z", conversationId: CONVERSATION_ID,
      extraction: extraction("item-1", "Переехала в Казань"),
      proposal: [{ type: "create", candidateLocalItemKey: "item-1", targetMemoryKey: null, topic: "life_context" }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(result.state.items.length, 1);
    assert.equal(result.state.items[0].topic, "life_context");
  });

  it("bumps revision and updates topic on a revise even when every other field is identical", async () => {
    const state0 = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    const created = await applyMemoryV3LifecycleStep({
      state: state0, at: "2026-09-24T10:05:00.000Z", conversationId: CONVERSATION_ID,
      extraction: extraction("item-1", "Переехала в Казань"),
      proposal: [{ type: "create", candidateLocalItemKey: "item-1", targetMemoryKey: null, topic: "communication" }],
      trustedForgetMemoryKeys: [],
    });
    const memoryKey = created.state.items[0].memoryKey;
    const revised = await applyMemoryV3LifecycleStep({
      state: created.state, at: "2026-09-24T10:10:00.000Z", conversationId: CONVERSATION_ID,
      extraction: extraction("item-2", "Переехала в Казань"),
      proposal: [{ type: "revise", candidateLocalItemKey: "item-2", targetMemoryKey: memoryKey, topic: "preference" }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(revised.state.items[0].topic, "preference");
    assert.equal(revised.state.items[0].revision, created.state.items[0].revision + 1);
  });

  it("leaves topic untouched on confirm", async () => {
    const state0 = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    const created = await applyMemoryV3LifecycleStep({
      state: state0, at: "2026-09-24T10:05:00.000Z", conversationId: CONVERSATION_ID,
      extraction: extraction("item-1", "Переехала в Казань"),
      proposal: [{ type: "create", candidateLocalItemKey: "item-1", targetMemoryKey: null, topic: "communication" }],
      trustedForgetMemoryKeys: [],
    });
    const memoryKey = created.state.items[0].memoryKey;
    const confirmed = await applyMemoryV3LifecycleStep({
      state: created.state, at: "2026-09-24T10:10:00.000Z", conversationId: CONVERSATION_ID,
      extraction: extraction("item-2", "Переехала в Казань"),
      proposal: [{ type: "confirm", candidateLocalItemKey: "item-2", targetMemoryKey: memoryKey, topic: null }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(confirmed.state.items[0].topic, "communication");
  });
});
```

Add the mirror three tests to `dialogueReducer.cases.test.ts`, substituting `createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID })` for `createEmptyMemoryV3LifecycleState`, `applyMemoryV3DialogueStep` for `applyMemoryV3LifecycleStep`, and topic values from `person`/`fact`/`preference` in place of `life_context`/`communication`/`preference`.

- [ ] **Step 4: Run both test files and verify they pass**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts`
Expected: all new tests pass, no regressions in the existing tests in either file.

- [ ] **Step 5: Type-check against baseline**

Run `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/lifecycleReducer.ts supabase/functions/_shared/memoryV3/dialogueReducer.ts`, compare against `git stash` baseline.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleReducer.ts supabase/functions/_shared/memoryV3/dialogueReducer.ts supabase/functions/_shared/memoryV3/lifecycleReducer.cases.test.ts supabase/functions/_shared/memoryV3/dialogueReducer.cases.test.ts
git commit -m "feat: write and re-decide topic in the Memory V3 reducers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Response schema (transport) and instruction text (prompt) for both reconcilers

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleTransport.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueTransport.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecyclePrompt.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialoguePrompt.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleTransport.cases.test.ts` (add to existing)
- Test: `supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts` (add to existing)
- Test: `supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts` (add to existing)
- Test: `supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts` (add to existing)

**Interfaces:**
- Consumes: nothing new (this is the outward-facing half: what StaySEE asks the model for, and what it accepts back).
- Produces: the OpenRouter `response_format.json_schema` for both reconcilers now declares a `topic` property per operation (`type: ["string", "null"]`, with the scope's 3 values plus `null` in its `enum`). Note this schema-level declaration is intentionally loose about WHICH operation types allow non-null topic (JSON Schema conditionals aren't used here, matching how this same schema already handles `targetMemoryRef` today) — the per-type requirement is enforced entirely by Task 5's `validateMemoryV3*Proposal`, exactly the same division of responsibility already used for `targetMemoryRef`.

**In `lifecycleTransport.ts`:**

- [ ] **Step 1: Add `topic` to `LIFECYCLE_RESPONSE_SCHEMA`**

Change:

```typescript
const LIFECYCLE_RESPONSE_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "candidateRef", "targetMemoryRef"],
        properties: {
          type: {
            type: "string",
            enum: ["create", "confirm", "revise", "mark_stale", "reject", "ignore"],
          },
          candidateRef: { type: "string" },
          targetMemoryRef: { type: ["string", "null"] },
        },
      },
    },
  },
});
```

to:

```typescript
const LIFECYCLE_RESPONSE_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "candidateRef", "targetMemoryRef", "topic"],
        properties: {
          type: {
            type: "string",
            enum: ["create", "confirm", "revise", "mark_stale", "reject", "ignore"],
          },
          candidateRef: { type: "string" },
          targetMemoryRef: { type: ["string", "null"] },
          topic: { type: ["string", "null"], enum: ["life_context", "communication", "preference", null] },
        },
      },
    },
  },
});
```

**In `dialogueTransport.ts`:** apply the identical edit to `DIALOGUE_RESPONSE_SCHEMA`, with the `topic` enum values `["person", "fact", "preference", null]`.

- [ ] **Step 2: Update the system instruction text in `lifecyclePrompt.ts`**

Change the shape line and key-count line near the top of `MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION`:

```
The response must have exactly this shape:
{"operations":[{"type":"create|confirm|revise|mark_stale|reject|ignore","candidateRef":"candidate:0001","targetMemoryRef":"memory:0001 or null"}]}

The top-level object has exactly one key: "operations".
Every operation has exactly three keys: "type", "candidateRef", and "targetMemoryRef".
```

to:

```
The response must have exactly this shape:
{"operations":[{"type":"create|confirm|revise|mark_stale|reject|ignore","candidateRef":"candidate:0001","targetMemoryRef":"memory:0001 or null","topic":"life_context|communication|preference or null"}]}

The top-level object has exactly one key: "operations".
Every operation has exactly four keys: "type", "candidateRef", "targetMemoryRef", and "topic".
```

Insert a new numbered rule immediately after rule 9 (`reject means the candidate provides valid rejection...`) and renumber every rule from the old 10 onward by +1 (old rule 10 "A target must have the same kind..." becomes 11, and so on through old rule 28, which becomes 29):

```
10. Every create and revise operation requires a non-null topic, exactly one of life_context (stable facts about the person's life situation), communication (how this person prefers to be communicated with), or preference (what helps or doesn't help in contact with them). Every confirm, mark_stale, reject, and ignore operation requires topic null. A revise re-decides topic from the current claim; do not simply copy the memory's previous topic forward without reconsidering it.
```

- [ ] **Step 3: Update the system instruction text in `dialoguePrompt.ts`**

Apply the same two edits to `MEMORY_V3_DIALOGUE_SYSTEM_INSTRUCTION`, with the topic enum in the shape line and new rule text using `"person|fact|preference or null"` and: `person` (a specific person mentioned in this conversation), `fact` (a durable fact or decision from this conversation), `preference` (a preference about how this conversation should go).

- [ ] **Step 4: Write the tests**

Add to `lifecycleTransport.cases.test.ts` (find this file's existing test that asserts on `LIFECYCLE_RESPONSE_SCHEMA`'s shape via the exported adapter or a re-exported schema constant — read the file first to see whether the schema is exported or only asserted indirectly through a full request/response round-trip, and match that existing style):

```typescript
it("requires topic as a fourth key on every reconciler operation, scoped to the lifecycle enum plus null", () => {
  // Mirror however this file already asserts on schema shape today (either
  // importing an exported schema constant, or building a fetchImpl stub
  // that inspects the outgoing request body) -- read the existing tests in
  // this file first and follow that pattern rather than introducing a new one.
});
```

Add the dialogue-scope mirror to `dialogueTransport.cases.test.ts`.

Add to `lifecyclePrompt.cases.test.ts`:

```typescript
it("documents topic as a required fourth operation key with the lifecycle enum", () => {
  assert.match(
    MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION,
    /Every create and revise operation requires a non-null topic, exactly one of life_context .*, communication .*, or preference/,
  );
  assert.match(MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION, /Every operation has exactly four keys/);
});
```

Add the dialogue-scope mirror (`person`/`fact`/`preference`) to `dialoguePrompt.cases.test.ts`.

- [ ] **Step 5: Run all four test files and verify they pass**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/lifecycleTransport.cases.test.ts supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts`
Expected: all pass, no regressions.

- [ ] **Step 6: Type-check against baseline**

Run `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config` on all four modified files, compare against `git stash` baseline.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleTransport.ts supabase/functions/_shared/memoryV3/dialogueTransport.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.ts supabase/functions/_shared/memoryV3/dialoguePrompt.ts supabase/functions/_shared/memoryV3/lifecycleTransport.cases.test.ts supabase/functions/_shared/memoryV3/dialogueTransport.cases.test.ts supabase/functions/_shared/memoryV3/lifecyclePrompt.cases.test.ts supabase/functions/_shared/memoryV3/dialoguePrompt.cases.test.ts
git commit -m "feat: ask both Memory V3 reconcilers to classify a topic per operation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Update the shadow runners' shape pre-check

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts`
- Test: `supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts` (add to existing)
- Test: `supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts` (add to existing)

**Interfaces:**
- Consumes: Task 5's contract validators, Task 6's reducers.
- Produces: nothing new downstream — this task only keeps the runners' own local pre-check in sync with the now-4-key operation shape, so a malformed response fails with the existing `reconciler_shape_invalid` diagnostic instead of an unrelated error surfacing later.

- [ ] **Step 1: Update the pre-check field list**

In `lifecycleShadowRunner.ts`, the current block reads:

```typescript
    for (const operation of inspectDenseArray(
      proposalRoot.operations,
      MEMORY_V3_LIFECYCLE_MAX_CANDIDATES,
      "reconciler_shape_invalid",
    )) {
      inspectExactRecord(
        operation,
        ["type", "candidateRef", "targetMemoryRef"],
        "reconciler_shape_invalid",
      );
    }
```

Change the field list to:

```typescript
      inspectExactRecord(
        operation,
        ["type", "candidateRef", "targetMemoryRef", "topic"],
        "reconciler_shape_invalid",
      );
```

In `dialogueShadowRunner.ts`, apply the identical change to its matching block (same `["type", "candidateRef", "targetMemoryRef"]` array, confirmed today at the same relative position).

- [ ] **Step 2: Write the tests**

Add to `lifecycleShadowRunner.cases.test.ts` (this file already has tests that feed a malformed reconciler response through the runner and assert on `persistFailure`'s diagnostic code — read one of those existing tests first and copy its exact fixture-building pattern):

```typescript
it("fails with reconciler_shape_invalid when an operation is missing the topic key", async () => {
  // Reuse this file's existing "malformed reconciler response" test
  // fixture, but omit `topic` from one operation object in the mocked
  // reconciler.rawContent JSON, and assert the run fails with
  // diagnosticCode "reconciler_shape_invalid" -- follow the exact mocking
  // pattern (fake transport/store) already used by the neighboring test in
  // this file for "missing candidateRef", just swapping which key is
  // dropped.
});
```

Add the dialogue-scope mirror to `dialogueShadowRunner.cases.test.ts`.

- [ ] **Step 3: Run both test files and verify they pass**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts`
Expected: all pass, no regressions.

- [ ] **Step 4: Type-check against baseline**

Run `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config` on both modified files, compare against `git stash` baseline.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts supabase/functions/_shared/memoryV3/lifecycleShadowRunner.cases.test.ts supabase/functions/_shared/memoryV3/dialogueShadowRunner.cases.test.ts
git commit -m "feat: keep the Memory V3 shadow runners' shape pre-check in sync with topic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `topic` through `viewerProjection.ts` and the frontend fetch layer

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/viewerProjection.ts`
- Modify: `src/lib/memoryV3Viewer.ts`
- Test: `supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts` (add to existing)

**Interfaces:**
- Consumes: Task 3's viewer RPCs now return `topic`.
- Produces: `MemoryV3ViewerSourceItem`/`MemoryV3ViewerItem` (backend) and `MemoryV3ViewerItem` (frontend) all carry `topic: string | null`, passed straight through with no filtering (topic never affects the existing event/recurrence/hypothesis filter).

- [ ] **Step 1: Add `topic` to `viewerProjection.ts`**

Change:

```typescript
export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
}
```

to:

```typescript
export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
}
```

Change the `.map()` inside `projectMemoryV3ViewerItems`:

```typescript
    .map((item) => ({
      memoryKey: item.memoryKey,
      kind: item.kind,
      claim: stripLeadingSubjectWord(item.claim),
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
    }));
```

to:

```typescript
    .map((item) => ({
      memoryKey: item.memoryKey,
      kind: item.kind,
      claim: stripLeadingSubjectWord(item.claim),
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
      topic: item.topic,
    }));
```

(Read the current file first — it was touched today for the "пользователь" phrasing fix and may have the `stripLeadingSubjectWord` call already; if the exact `.map()` body differs slightly from what's shown here, keep whatever it currently does to `claim` and add only the `topic: item.topic,` line.)

- [ ] **Step 2: Add `topic` to the frontend fetch layer**

In `src/lib/memoryV3Viewer.ts`, change:

```typescript
export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: 'event' | 'recurrence';
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: 'normal' | 'sensitive';
}
```

to:

```typescript
export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: 'event' | 'recurrence';
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: 'normal' | 'sensitive';
  topic: string | null;
}
```

No other change is needed in this file — the rest of it passes the fetched JSON through untouched, so `topic` arrives automatically once the edge function returns it.

- [ ] **Step 3: Write the test**

Add to `viewerProjection.cases.test.ts`:

```typescript
it("passes topic through unchanged, including null", () => {
  const result = projectMemoryV3ViewerItems([
    { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context" },
    { memoryKey: "b", kind: "recurrence", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null },
  ]);
  assert.equal(result[0].topic, "life_context");
  assert.equal(result[1].topic, null);
});
```

(Update every other existing test fixture object literal in this file to include a `topic` field too — TypeScript will flag the omissions as compile errors against the now-required `topic` property on `MemoryV3ViewerSourceItem`, so this is not optional busywork, it's required for the file to type-check.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: all pass including the pre-existing tests (now with `topic` added to their fixtures).

- [ ] **Step 5: Type-check against baseline**

Run `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/_shared/memoryV3/viewerProjection.ts` and `npm run typecheck` (for the frontend file), compare both against baseline.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/memoryV3/viewerProjection.ts supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts src/lib/memoryV3Viewer.ts
git commit -m "feat: pass Memory V3 topic through the viewer projection and frontend fetch layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Group the viewer screen by topic

**Files:**
- Modify: `src/components/MemoryV3ItemList.tsx`
- Modify: `src/components/screens/MemoryScreen.tsx`

**Interfaces:**
- Consumes: `MemoryV3ViewerItem.topic` from Task 9.
- Produces: `MemoryV3ItemList` now takes a new required `topicLabels: Record<string, string>` prop and groups its items by `topic` using that map, in the map's own key order, followed by an always-last "Разное" group for any item whose `topic` is `null`. Within each group, items keep arriving pre-sorted newest-first from the RPC (Task 3) and are still capped at 5 visible with a "Показать ещё N" expand button — the same mechanism already used for this component (re-derive it fresh here since the PR that shipped it, #56, was closed unmerged and superseded; the file on `main` right now is the plain flat list from PR #54, confirmed by reading it — do not assume any `kind`-grouping code is already present).

- [ ] **Step 1: Rewrite `MemoryV3ItemList.tsx`**

Replace the full file content with:

```typescript
import { useState } from 'react';
import type { Theme } from '../context/ThemeContext';
import { ConfirmDeleteButton } from './ConfirmDeleteButton';
import type { MemoryV3ViewerItem } from '../lib/memoryV3Viewer';

const VISIBLE_PER_GROUP = 5;
const UNCATEGORIZED_GROUP_KEY = '__uncategorized__';
const UNCATEGORIZED_LABEL = 'Разное';

/** Список подтверждённых записей "умной" памяти, сгруппированный по теме
 * (переданной вызывающим экраном через topicLabels, свой набор для памяти
 * беседы и для сквозной памяти) — посмотреть и удалить. Записи без темы
 * (ещё не разобраны разовым проходом нейросети) попадают в отдельную
 * группу "Разное" в конце. Каждая группа показывает только 5 самых свежих
 * записей (сервер уже отдаёт их в этом порядке), остальное — за кнопкой
 * "Показать ещё". Чувствительные записи по умолчанию свёрнуты. */
export function MemoryV3ItemList({
  items,
  theme,
  cardBase,
  onDelete,
  emptyMessage,
  topicLabels,
}: {
  items: MemoryV3ViewerItem[];
  theme: Theme;
  cardBase: string;
  onDelete: (item: MemoryV3ViewerItem) => void;
  emptyMessage: string;
  topicLabels: Record<string, string>;
}) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (items.length === 0) {
    return (
      <div className={`${cardBase} px-4 py-3.5`}>
        <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>{emptyMessage}</p>
      </div>
    );
  }

  const groups = [
    ...Object.keys(topicLabels).map((topic) => ({
      key: topic,
      label: topicLabels[topic],
      groupItems: items.filter((item) => item.topic === topic),
    })),
    {
      key: UNCATEGORIZED_GROUP_KEY,
      label: UNCATEGORIZED_LABEL,
      groupItems: items.filter((item) => item.topic === null || !Object.hasOwn(topicLabels, item.topic)),
    },
  ].filter((group) => group.groupItems.length > 0);

  return (
    <div className="space-y-3">
      {groups.map(({ key, label, groupItems }) => {
        const isExpanded = expandedGroups.has(key);
        const visibleItems = isExpanded ? groupItems : groupItems.slice(0, VISIBLE_PER_GROUP);
        const hiddenCount = groupItems.length - visibleItems.length;
        return (
          <div key={key} className="space-y-1.5">
            <p className={`${theme.textMuted} text-[11px] font-light px-1 opacity-80`}>
              {label}
            </p>
            <ul className="space-y-1.5">
              {visibleItems.map((item) => {
                const isSensitive = item.sensitivity === 'sensitive';
                const isRevealed = revealed.has(item.memoryKey);
                return (
                  <li key={item.memoryKey} className={`${cardBase} px-4 py-3 flex items-center justify-between gap-2`}>
                    {isSensitive && !isRevealed ? (
                      <button
                        type="button"
                        onClick={() => setRevealed((prev) => new Set(prev).add(item.memoryKey))}
                        className={`${theme.textMuted} text-sm font-light text-left flex-1`}
                      >
                        Чувствительная запись — показать
                      </button>
                    ) : (
                      <p className={`${theme.textPrimary} text-sm font-light flex-1`}>{item.claim}</p>
                    )}
                    <ConfirmDeleteButton theme={theme} onConfirm={() => onDelete(item)} />
                  </li>
                );
              })}
            </ul>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpandedGroups((prev) => new Set(prev).add(key))}
                className={`${theme.textMuted} text-xs font-light px-1`}
              >
                Показать ещё {hiddenCount}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add the two label maps and pass them into `MemoryScreen.tsx`'s four `MemoryV3ItemList` usages**

Read `src/components/screens/MemoryScreen.tsx` first (its exact `MemoryV3ItemList` usages were last confirmed today at approximately lines 666, 819, 839, and 849, inside the "Память беседы" new-account branch, the "Сквозная память" new-account branch, and the two calls inside the "Умная память" section for existing accounts — confirm the current line numbers and surrounding JSX before editing, since this file may have shifted since).

Near the top of the file, alongside the other module-level constants (find where `MEMORY_V3_VIEWER_LAUNCH_CUTOFF` is defined and add these next to it):

```typescript
const MEMORY_V3_DIALOGUE_TOPIC_LABELS: Record<string, string> = {
  person: 'Люди',
  fact: 'Факты',
  preference: 'Предпочтения общения',
};

const MEMORY_V3_LIFECYCLE_TOPIC_LABELS: Record<string, string> = {
  life_context: 'Факты профиля',
  communication: 'Стиль общения',
  preference: 'Что помогает в контакте',
};
```

Then, at every call site in this file where `<MemoryV3ItemList items={memoryV3Dialogue} ... />` appears, add `topicLabels={MEMORY_V3_DIALOGUE_TOPIC_LABELS}`; at every call site where `<MemoryV3ItemList items={memoryV3AccountWide} ... />` appears, add `topicLabels={MEMORY_V3_LIFECYCLE_TOPIC_LABELS}`. There are four call sites total (two dialogue, two account-wide) — find each with `grep -n "MemoryV3ItemList" src/components/screens/MemoryScreen.tsx` and add the matching prop to every one; do not skip any, since TypeScript will fail to compile if the now-required `topicLabels` prop is missing from even one call site.

- [ ] **Step 3: Start the dev server and manually verify the viewer screen**

Run: `npm run dev` (in the background), open the app, sign in as the canary account, open the memory screen, and confirm: items are grouped under the right Russian labels, groups with more than 5 items show "Показать ещё", and any item without a topic yet appears under "Разное" at the end. This repo has no automated UI test harness (confirmed multiple times this session) — this manual check is the only verification for the actual rendered screen, so do not skip it or claim it as done without actually running the dev server and looking.

- [ ] **Step 4: Type-check, lint, and build**

Run: `npm run typecheck`
Run: `npx eslint src/components/MemoryV3ItemList.tsx src/components/screens/MemoryScreen.tsx`
Run: `npm run build`
Compare `npm run typecheck`'s error count against a `git stash` baseline — expect identical (zero, per today's established pattern for this codebase).

- [ ] **Step 5: Commit**

```bash
git add src/components/MemoryV3ItemList.tsx src/components/screens/MemoryScreen.tsx
git commit -m "feat: group the Memory V3 viewer by topic instead of event/recurrence kind

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: One-time backfill script for pre-existing untagged items

**Files:**
- Create: `scripts/memory-v3-topic-backfill/backfill-topics.ts`
- Create: `scripts/memory-v3-topic-backfill/README.md`
- Test: `scripts/memory-v3-topic-backfill/backfill-topics.test.ts`

**Interfaces:**
- Consumes: `MEMORY_V3_LIFECYCLE_TOPICS`/`MEMORY_V3_DIALOGUE_TOPICS` from Task 5's contract files (import them directly rather than redefining the enums).
- Produces: a script Настя runs once by hand from her own terminal. Not wired into any CI, cron, or edge function. Deliberately NOT built on the heavy `scripts/memory-v3-pilot/lifecycle-history-backfill-*` machinery (that tooling re-runs the full historical extractor+reconciler pipeline over entire conversation transcripts with cost-ceiling enforcement and review packets — a much bigger job than reclassifying a handful of already-extracted claims with one small call each). This is a plain, self-contained Node script.

- [ ] **Step 1: Write the script**

```typescript
/**
 * One-time backfill: classifies a topic for every Memory V3 lifecycle and
 * dialogue item that doesn't have one yet (pre-existing items from before
 * this feature shipped). Run once by hand -- see README.md in this
 * directory for the exact command. Never wired into the live pipeline.
 */

import { createClient } from '@supabase/supabase-js';
import {
  MEMORY_V3_LIFECYCLE_TOPICS,
  type MemoryV3LifecycleTopic,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import {
  MEMORY_V3_DIALOGUE_TOPICS,
  type MemoryV3DialogueTopic,
} from '../../supabase/functions/_shared/memoryV3/dialogueContract.ts';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-3.7-flash';

interface ClassifyInput {
  claim: string;
  kind: 'event' | 'recurrence' | 'hypothesis';
  scopeLabel: string;
  topics: readonly string[];
}

function buildSchema(topics: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['topic'],
    properties: {
      topic: { type: 'string', enum: [...topics] },
    },
  };
}

async function classifyTopic(input: ClassifyInput, apiKey: string): Promise<{
  topic: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}> {
  const system = `You classify one existing StaySEE memory claim into exactly one topic.
Topics for ${input.scopeLabel}: ${input.topics.join(', ')}.
Return JSON only, matching the given schema. Pick the single best-fitting topic; never invent a value outside the given list.`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ claim: input.claim, kind: input.kind }) },
    ],
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'topic_backfill_response', strict: true, schema: buildSchema(input.topics) },
    },
    reasoning: { effort: 'low' },
    provider: { allow_fallbacks: true, require_parameters: true, data_collection: 'deny', zdr: true },
    max_tokens: 50,
    usage: { include: true },
  };
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const content = data.choices[0].message.content as string;
  const parsed = JSON.parse(content) as { topic: string };
  if (!input.topics.includes(parsed.topic)) {
    throw new Error(`Model returned a topic outside the allowed list: ${parsed.topic}`);
  }
  const usage = data.usage ?? {};
  return {
    topic: parsed.topic,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    costUsd: typeof usage.cost === 'number' ? usage.cost : 0,
  };
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!supabaseUrl || !serviceKey || !apiKey) {
    throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENROUTER_API_KEY before running this script.');
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: lifecycleItems, error: lifecycleError } = await supabase
    .from('memory_v3_lifecycle_shadow_items')
    .select('user_id, memory_key, claim, kind')
    .is('topic', null);
  if (lifecycleError) throw lifecycleError;

  const { data: dialogueItems, error: dialogueError } = await supabase
    .from('memory_v3_dialogue_items')
    .select('user_id, conversation_id, memory_key, claim, kind')
    .is('topic', null);
  if (dialogueError) throw dialogueError;

  console.log(`Найдено без темы: ${lifecycleItems.length} сквозных, ${dialogueItems.length} по диалогам.`);

  let totalCostUsd = 0;
  let processedCount = 0;

  for (const item of lifecycleItems) {
    const result = await classifyTopic(
      { claim: item.claim, kind: item.kind, scopeLabel: 'сквозной памяти обо всём аккаунте', topics: MEMORY_V3_LIFECYCLE_TOPICS },
      apiKey,
    );
    const { error: updateError } = await supabase
      .from('memory_v3_lifecycle_shadow_items')
      .update({ topic: result.topic })
      .eq('user_id', item.user_id)
      .eq('memory_key', item.memory_key);
    if (updateError) throw updateError;
    const { error: logError } = await supabase.from('ai_usage_logs').insert({
      user_id: item.user_id,
      model: MODEL,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
      memory_tokens: 0,
      summary_tokens: 0,
      cost: result.costUsd,
      call_kind: 'memory_v3_topic_backfill',
      cost_category: 'technical',
    });
    if (logError) throw logError;
    totalCostUsd += result.costUsd;
    processedCount += 1;
    console.log(`  сквозная ${item.memory_key.slice(0, 8)}… -> ${result.topic}`);
  }

  for (const item of dialogueItems) {
    const result = await classifyTopic(
      { claim: item.claim, kind: item.kind, scopeLabel: 'памяти конкретной беседы', topics: MEMORY_V3_DIALOGUE_TOPICS },
      apiKey,
    );
    const { error: updateError } = await supabase
      .from('memory_v3_dialogue_items')
      .update({ topic: result.topic })
      .eq('user_id', item.user_id)
      .eq('conversation_id', item.conversation_id)
      .eq('memory_key', item.memory_key);
    if (updateError) throw updateError;
    const { error: logError } = await supabase.from('ai_usage_logs').insert({
      user_id: item.user_id,
      conversation_id: item.conversation_id,
      model: MODEL,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
      memory_tokens: 0,
      summary_tokens: 0,
      cost: result.costUsd,
      call_kind: 'memory_v3_topic_backfill',
      cost_category: 'technical',
    });
    if (logError) throw logError;
    totalCostUsd += result.costUsd;
    processedCount += 1;
    console.log(`  беседа ${item.memory_key.slice(0, 8)}… -> ${result.topic}`);
  }

  console.log(`Готово. Разобрано записей: ${processedCount}. Потрачено: $${totalCostUsd.toFixed(4)}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export { classifyTopic };
```

- [ ] **Step 2: Write the README**

```markdown
# Разбор старых записей умной памяти по темам (разово)

Этот скрипт запускается один раз вручную, чтобы у уже существующих записей
умной памяти (сохранённых до того, как темы вообще появились) тоже
появилась тема — как у всех новых записей.

## Перед запуском

Нужны три значения из панели Supabase и OpenRouter:

```bash
export SUPABASE_URL="https://jnxrildlwvtxhtiwucbt.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export OPENROUTER_API_KEY="..."
```

## Запуск

```bash
npx tsx scripts/memory-v3-topic-backfill/backfill-topics.ts
```

Скрипт выведет список каждой разобранной записи и итоговую потраченную
сумму. Траты пишутся в ту же таблицу `ai_usage_logs`, что и обычные траты,
но отдельной пометкой ("техническое", `memory_v3_topic_backfill") -- чтобы
не путать с обычной работой памяти.

## Безопасно ли перезапускать

Да. Скрипт выбирает только записи без темы (`topic IS NULL`), поэтому уже
разобранные записи не будут обработаны и оплачены повторно.
```

- [ ] **Step 3: Write a test for the pure `classifyTopic` schema-building logic**

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function buildSchema(topics: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['topic'],
    properties: {
      topic: { type: 'string', enum: [...topics] },
    },
  };
}

describe('Memory V3 topic backfill schema', () => {
  it('builds a strict schema restricted to exactly the given topics', () => {
    const schema = buildSchema(['life_context', 'communication', 'preference']);
    assert.deepEqual(schema.properties.topic.enum, ['life_context', 'communication', 'preference']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['topic']);
  });

  it('builds an independent schema for the dialogue topic set', () => {
    const schema = buildSchema(['person', 'fact', 'preference']);
    assert.deepEqual(schema.properties.topic.enum, ['person', 'fact', 'preference']);
  });
});
```

(This test only exercises the schema-shaping logic, not the live network/DB calls in `main()` — this script is a manual one-off tool, not a tested production code path, so a full integration test with mocked Supabase/OpenRouter clients would be disproportionate effort for something run once. Extract `buildSchema` out of `backfill-topics.ts` as its own exported function so this test imports the real implementation instead of duplicating it inline as shown above — update the import once you've done that.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test scripts/memory-v3-topic-backfill/backfill-topics.test.ts`
Expected: 2/2 pass.

- [ ] **Step 5: Type-check the script**

Run: `npx tsc --noEmit scripts/memory-v3-topic-backfill/backfill-topics.ts` (or whatever this repo's existing convention is for standalone `scripts/` TypeScript files — check how `scripts/memory-v3-pilot/*.ts` files are type-checked, if at all, via their own `tsconfig` or the root one, and follow that same command).

- [ ] **Step 6: Commit**

```bash
git add scripts/memory-v3-topic-backfill/
git commit -m "feat: add one-time Memory V3 topic backfill script for pre-existing items

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Do not run this script.** It touches the production database and spends real money — running it is Настя's decision to make from her own terminal with her own credentials, per this session's standing restriction on me touching production directly.

---

### Task 12: Full verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full `_shared/memoryV3` suite**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/*.cases.test.ts`
Expected: every test passes, count is at or above the 680 baseline from before this branch (this feature adds tests, it should never remove or break existing ones).

- [ ] **Step 2: Run the full `_shared` suite for the one pre-existing unrelated failure**

Run: `npx tsx --test supabase/functions/_shared/*.cases.test.ts supabase/functions/_shared/**/*.cases.test.ts`
Expected: the same single pre-existing, unrelated failure this session has consistently reported (`narrativeEngine.cases.test.ts` or whatever it currently is) — confirm it is the same failure as on unmodified `main`, not a new one, via `git stash` comparison.

- [ ] **Step 3: Type-check `staysee-chat/index.ts` and `memory-v3-viewer/index.ts` against baseline**

Run `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/staysee-chat/index.ts supabase/functions/memory-v3-viewer/index.ts` before (via `git stash`) and after — expect identical error counts (both files import the touched shared modules transitively but this plan makes no direct edits to either file).

- [ ] **Step 4: Frontend verification**

Run: `npm run typecheck`
Run: `npx eslint src/components/MemoryV3ItemList.tsx src/components/screens/MemoryScreen.tsx src/lib/memoryV3Viewer.ts`
Run: `npm run build`
Expected: all clean, matching the baseline comparison already done in Task 10.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/memory-v3-topic-classification
gh pr create --base main --title "Группировка умной памяти по темам, как в старых экранах" --body "$(cat <<'EOF'
## В чём была просьба

Настя посмотрела PR #56 (группировка по «событие/повторяющееся») и попросила вместо этого группировать так же, как уже группируют старые экраны — по теме (Люди/Факты/Предпочтения и т.д.), и чтобы новые записи сами правильно понимали, в какую тему попадать, а не просто перекрашивались на экране.

## Что сделано

- Тема теперь решается тем же шагом, что уже решает «это новый факт или поправка старого» (согласователь) — отдельно для памяти беседы (Люди/Факты/Предпочтения общения) и для сквозной памяти (Факты профиля/Стиль общения/Что помогает в контакте). Экстрактор и его замороженная инструкция не тронуты.
- При уточнении/исправлении факта тема пересматривается заново вместе с ним, как и просила Настя.
- Экран «Умная память» теперь группирует записи по теме вместо типа, с той же логикой «5 свежих + показать ещё», что и в закрытом PR #56.
- Старые записи без темы попадают в отдельную группу «Разное», пока не пройдёт разовый разбор — отдельный скрипт (`scripts/memory-v3-topic-backfill/`), запускается вручную Настей, не мной.
- Заодно добавила метку «автоматическое/техническое» в таблицу трат — по просьбе Насти всё уже потраченное (это разработка, реальных пользователей ещё нет) помечается «техническим» по умолчанию, а разовые скрипты вроде этого разбора помечаются техническими явно.

## Проверено

- Полный набор `_shared/memoryV3` без регрессий.
- Проверка типов на затронутых файлах — чисто.
- Фронтенд: `typecheck`/`eslint`/`build` чисто; экран проверен вручную в браузере (группировка, «показать ещё», группа «Разное»).
- Скрипт разбора НЕ запускался против боевой базы — это следующий ручной шаг для Насти.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Stop here.** Do not merge without Настя's explicit real-time confirmation in the conversation, do not deploy, and do not run the backfill script.
