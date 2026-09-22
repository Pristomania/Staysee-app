import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260920120000_037_memory_v3_lifecycle_backfill_import.sql",
  import.meta.url,
);
const PGTAP_URL = new URL(
  "../../../tests/database/037_memory_v3_lifecycle_backfill_import.test.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 037 must exist");
  return readFileSync(MIGRATION_URL, "utf8");
}

function pgTapSql(): string {
  assert.equal(existsSync(PGTAP_URL), true, "migration 037 pgTAP test must exist");
  return readFileSync(PGTAP_URL, "utf8");
}

function functionSql(sql: string): string {
  const match = sql.match(
    /CREATE OR REPLACE FUNCTION public\.import_memory_v3_lifecycle_backfill_state\([\s\S]*?\$function\$;/iu,
  );
  assert.ok(match, "import function block must be extractable");
  return match[0];
}

describe("Memory V3 lifecycle backfill import migration", () => {
  it("creates the exact audit table and import RPC", () => {
    const sql = migrationSql();
    assert.match(sql, /CREATE TABLE public\.memory_v3_lifecycle_backfill_imports\s*\(/iu);
    assert.match(sql, /import_id uuid PRIMARY KEY/iu);
    assert.match(sql, /user_id uuid NOT NULL UNIQUE REFERENCES public\.profiles\(id\) ON DELETE CASCADE/iu);
    assert.match(sql, /artifact_digest text NOT NULL UNIQUE CHECK \(artifact_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/iu);
    assert.match(sql, /source_snapshot_digest text NOT NULL CHECK \(source_snapshot_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/iu);
    assert.match(sql, /item_count integer NOT NULL CHECK \(item_count BETWEEN 1 AND 100\)/iu);
    assert.match(sql, /evidence_count integer NOT NULL CHECK \(evidence_count BETWEEN 1 AND 500\)/iu);
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.import_memory_v3_lifecycle_backfill_state\(\s*p_import_id uuid,\s*p_user_id uuid,\s*p_expected_state_revision bigint,\s*p_artifact_digest text,\s*p_source_snapshot_digest text,\s*p_source_cutoff timestamptz,\s*p_profile_id text,\s*p_pipeline_version text,\s*p_extractor_version text,\s*p_reconciler_version text,\s*p_state jsonb\s*\)\s*RETURNS TABLE\(result text, resulting_state_revision bigint\)/iu,
    );
  });

  it("locks the RPC and audit table to service_role with empty search_path", () => {
    const sql = migrationSql();
    const body = functionSql(sql);
    assert.match(body, /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/iu);
    assert.match(sql, /ALTER TABLE public\.memory_v3_lifecycle_backfill_imports ENABLE ROW LEVEL SECURITY/iu);
    assert.match(sql, /REVOKE ALL ON TABLE public\.memory_v3_lifecycle_backfill_imports FROM PUBLIC, anon, authenticated/iu);
    assert.match(sql, /REVOKE ALL ON TABLE public\.memory_v3_lifecycle_backfill_imports FROM service_role/iu);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.memory_v3_lifecycle_backfill_imports TO service_role/iu);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.import_memory_v3_lifecycle_backfill_state\(\s*uuid,\s*uuid,\s*bigint,\s*text,\s*text,\s*timestamptz,\s*text,\s*text,\s*text,\s*text,\s*jsonb\s*\) FROM PUBLIC, anon, authenticated/iu,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.import_memory_v3_lifecycle_backfill_state\(\s*uuid,\s*uuid,\s*bigint,\s*text,\s*text,\s*timestamptz,\s*text,\s*text,\s*text,\s*text,\s*jsonb\s*\) FROM service_role/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.import_memory_v3_lifecycle_backfill_state\(\s*uuid,\s*uuid,\s*bigint,\s*text,\s*text,\s*timestamptz,\s*text,\s*text,\s*text,\s*text,\s*jsonb\s*\) TO service_role/iu,
    );
    const pgTap = pgTapSql();
    assert.match(pgTap, /(?:pg_catalog\.)?has_table_privilege\(\s*'service_role',[\s\S]*'SELECT'/iu);
    assert.match(pgTap, /(?:pg_catalog\.)?has_table_privilege\(\s*'service_role',[\s\S]*'INSERT'/iu);
    for (const forbidden of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.ok(pgTap.includes(`'${forbidden}'`), `pgTAP must reject ${forbidden}`);
    }
    assert.match(pgTap, /(?:pg_catalog\.)?has_function_privilege\(\s*'service_role',[\s\S]*'EXECUTE'/iu);
    assert.doesNotMatch(sql, /CREATE\s+POLICY/iu);
  });

  it("validates fixed identity, exact JSON shapes, caps, and item semantics before locking", () => {
    const body = functionSql(migrationSql());
    const lockAt = body.search(/FOR UPDATE/iu);
    assert.ok(lockAt > 0, "head must be selected FOR UPDATE");
    const beforeLock = body.slice(0, lockAt);
    for (const fixed of [
      "memory-v3-lifecycle-history-backfill-v1",
      "memory-v3-lifecycle-state-v1",
      "memory-v3-lifecycle-shadow-v1",
      "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
      "memory-v3-lifecycle-reconciler-v1",
    ]) assert.ok(beforeLock.includes(`'${fixed}'`), fixed);
    assert.match(beforeLock, /p_expected_state_revision\s+IS DISTINCT FROM\s+0/iu);
    assert.match(beforeLock, /p_artifact_digest\s*!~\s*'\^\[0-9a-f\]\{64\}\$'/iu);
    assert.match(beforeLock, /p_source_snapshot_digest\s*!~\s*'\^\[0-9a-f\]\{64\}\$'/iu);
    assert.match(beforeLock, /pg_catalog\.jsonb_typeof\(p_state\)\s+IS DISTINCT FROM\s+'object'/iu);
    assert.match(beforeLock, /p_state->>'userId'\s+IS DISTINCT FROM\s+p_user_id::text/iu);
    assert.match(beforeLock, /p_state->>'stateRevision'/iu);
    assert.match(beforeLock, /p_state->>'nextMemoryOrdinal'/iu);
    assert.match(beforeLock, /jsonb_object_keys\(p_state\)/iu);
    assert.match(beforeLock, /jsonb_array_length\(p_state->'items'\)[\s\S]*v_item_count NOT BETWEEN 1 AND 100/iu);
    assert.match(beforeLock, /COALESCE\(\s*pg_catalog\.sum\([\s\S]*?\),\s*0::bigint\)::integer[\s\S]*v_evidence_count NOT BETWEEN 1 AND 500/iu);
    assert.doesNotMatch(beforeLock, /pg_catalog\.coalesce\s*\(/iu);
    assert.match(beforeLock, /memoryKey/iu);
    assert.match(beforeLock, /jsonb_typeof\(item->'kind'\) IS DISTINCT FROM 'string'/iu);
    assert.match(beforeLock, /kind[\s\S]*event[\s\S]*recurrence[\s\S]*hypothesis/iu);
    assert.match(beforeLock, /jsonb_typeof\(item->'status'\) IS DISTINCT FROM 'string'/iu);
    assert.match(beforeLock, /status/iu);
    assert.match(beforeLock, /jsonb_typeof\(item->'sensitivity'\) IS DISTINCT FROM 'string'/iu);
    assert.match(beforeLock, /v_date_pattern CONSTANT text := '\^\(0\[1-9\]\[0-9\]\{2\}\|\[1-9\]\[0-9\]\{3\}\)-/iu);
    assert.match(beforeLock, /v_datetime_pattern CONSTANT text := '\^\(0\[1-9\]\[0-9\]\{2\}\|\[1-9\]\[0-9\]\{3\}\)-/iu);
    assert.match(beforeLock, /eventTimeStart'[\s\S]*eventTimeEnd'[\s\S]*AT TIME ZONE 'UTC'/iu);
    assert.match(beforeLock, /firstSeenAt/iu);
    assert.match(beforeLock, /updatedAt/iu);
    assert.match(beforeLock, /alternative/iu);
    assert.match(beforeLock, /revision/iu);
    assert.match(beforeLock, /GROUP BY item->>'memoryKey'[\s\S]*HAVING pg_catalog\.count\(\*\) > 1/iu);
  });

  it("validates evidence shape, relation matrix, provenance, ownership, time, and cutoff", () => {
    const body = functionSql(migrationSql());
    assert.match(body, /jsonb_object_keys\(evidence\)/iu);
    assert.match(body, /jsonb_typeof\(evidence->'conversationId'\) IS DISTINCT FROM 'string'/iu);
    assert.match(body, /jsonb_typeof\(evidence->'sourceMessageId'\) IS DISTINCT FROM 'string'/iu);
    assert.match(body, /jsonb_typeof\(evidence->'relation'\) IS DISTINCT FROM 'string'/iu);
    assert.match(body, /relation[\s\S]*supports[\s\S]*contradicts[\s\S]*corrects[\s\S]*rejects/iu);
    assert.match(body, /supportType[\s\S]*episode_observation[\s\S]*pattern_confirmation[\s\S]*scope_boundary/iu);
    assert.match(body, /jsonb_typeof\(evidence->'provenanceRole'\) IS DISTINCT FROM 'string'/iu);
    assert.match(body, /provenanceRole'[\s\S]*IS DISTINCT FROM\s*'user'/iu);
    assert.match(body, /episodeKey/iu);
    assert.match(body, /JOIN public\.conversations c ON c\.id = m\.conversation_id/iu);
    assert.match(body, /m\.id = \(evidence->>'sourceMessageId'\)::uuid/iu);
    assert.match(body, /m\.conversation_id = \(evidence->>'conversationId'\)::uuid/iu);
    assert.match(body, /c\.user_id = p_user_id/iu);
    assert.match(body, /m\.sender = 'user'/iu);
    assert.match(body, /m\.created_at = \(evidence->>'mentionTime'\)::timestamptz/iu);
    assert.match(body, /m\.created_at <= p_source_cutoff/iu);
    assert.match(body, /GROUP BY item->>'memoryKey', evidence->>'conversationId',[\s\S]*evidence->>'sourceMessageId', evidence->>'relation'[\s\S]*HAVING pg_catalog\.count\(\*\) > 1/iu);
  });

  it("locks an empty revision-zero head and rejects prior or nonempty state", () => {
    const body = functionSql(migrationSql());
    assert.match(body, /INSERT INTO public\.memory_v3_lifecycle_shadow_heads\(user_id\)[\s\S]*ON CONFLICT \(user_id\) DO NOTHING/iu);
    assert.match(body, /FROM public\.memory_v3_lifecycle_shadow_heads[\s\S]*WHERE user_id = p_user_id[\s\S]*FOR UPDATE/iu);
    assert.match(body, /v_head\.state_revision\s*<>\s*0/iu);
    assert.match(body, /FROM public\.memory_v3_lifecycle_shadow_items[\s\S]*WHERE user_id = p_user_id/iu);
    assert.match(body, /memory_v3_lifecycle_backfill_imports[\s\S]*user_id = p_user_id/iu);
    assert.match(body, /memory_v3_lifecycle_backfill_imports[\s\S]*artifact_digest = p_artifact_digest/iu);
  });

  it("publishes items, evidence, head, and final audit atomically without swallowed failures", () => {
    const body = functionSql(migrationSql());
    const deleteAt = body.search(/DELETE FROM public\.memory_v3_lifecycle_shadow_items/iu);
    const itemAt = body.search(/INSERT INTO public\.memory_v3_lifecycle_shadow_items/iu);
    const evidenceAt = body.search(/INSERT INTO public\.memory_v3_lifecycle_shadow_evidence/iu);
    const headAt = body.search(/UPDATE public\.memory_v3_lifecycle_shadow_heads/iu);
    const auditAt = body.search(/INSERT INTO public\.memory_v3_lifecycle_backfill_imports/iu);
    assert.ok(deleteAt > 0 && deleteAt < itemAt && itemAt < evidenceAt && evidenceAt < headAt && headAt < auditAt);
    assert.match(body, /state_revision = \(p_state->>'stateRevision'\)::bigint/iu);
    assert.match(body, /next_memory_ordinal = \(p_state->>'nextMemoryOrdinal'\)::bigint/iu);
    assert.match(body, /result\s*:=\s*'succeeded'/iu);
    assert.doesNotMatch(body, /\bEXCEPTION\s+WHEN\b/iu);
    assert.doesNotMatch(body, /\bCOMMIT\b|\bROLLBACK\b/iu);
  });

  it("contains no dynamic SQL, provider, network, cron, or canary mutation", () => {
    const sql = migrationSql();
    const body = functionSql(sql);
    assert.doesNotMatch(body, /\bEXECUTE\b|format\s*\(/iu);
    assert.doesNotMatch(sql, /https?:\/\/|authorization|api[_-]?key|fetch\s*\(/iu);
    assert.doesNotMatch(sql, /\bcron\.|canary|memory_v3_lifecycle_read/iu);
    assert.doesNotMatch(sql, /current_schema|information_schema|pg_catalog\.pg_proc/iu);
    assert.match(
      pgTapSql(),
      /INSERT INTO public\.profiles\(id\) VALUES \(v_user\)\s+ON CONFLICT \(id\) DO NOTHING/iu,
    );
  });
});
