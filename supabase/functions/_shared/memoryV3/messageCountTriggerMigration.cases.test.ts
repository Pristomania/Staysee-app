import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923090000_039_memory_v3_lifecycle_message_count_trigger.sql",
  import.meta.url,
);
const PRIOR_MIGRATION_URL = new URL(
  "../../../migrations/20260922120000_038_memory_v3_full_rollout_alerts.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 039 must exist");
  return readFileSync(MIGRATION_URL, "utf8");
}

function functionBlock(sql: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?\\$function\\$;`,
    "iu",
  ));
  assert.ok(match, `${name} function block must be extractable`);
  return match[0];
}

describe("Memory V3 lifecycle message-count trigger migration", () => {
  it("keeps the exact reserve RPC signature from migration 038", () => {
    assert.equal(existsSync(PRIOR_MIGRATION_URL), true, "migration 038 must exist");
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    assert.match(
      body,
      /reserve_memory_v3_lifecycle_shadow_run\(\s*p_user_id uuid,\s*p_conversation_id uuid,\s*p_pipeline_version text,\s*p_extractor_version text,\s*p_reconciler_version text,\s*p_model text,\s*p_input_hash text,\s*p_source_last_message_id uuid,\s*p_source_last_created_at timestamptz,\s*p_message_count integer,\s*p_user_message_count integer\s*\)/iu,
    );
  });

  it("drops the calendar-day cap and gates on 10 new messages across all of the user's dialogues", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    assert.doesNotMatch(body, /v_daily_count/iu);
    assert.doesNotMatch(body, /date_trunc\('day'/iu);
    assert.match(body, /v_new_message_count integer;/iu);
    assert.match(body, /IF v_new_message_count < 10 THEN/iu);
    assert.match(
      body,
      /FROM public\.messages m\s*\n\s*JOIN public\.conversations c ON c\.id = m\.conversation_id\s*\n\s*WHERE c\.user_id = p_user_id AND m\.created_at > v_last_cursor/iu,
    );
    // Not filtered to the current conversation -- the count is shared
    // across every one of the person's dialogues, matching the shared
    // daily budget decision made for the dialogue-isolation work.
    const countQuery = body.slice(
      body.indexOf("SELECT pg_catalog.count(*)::integer INTO v_new_message_count"),
      body.indexOf("v_new_message_count < 10"),
    );
    assert.doesNotMatch(countQuery, /p_conversation_id/iu);
  });

  it("still allows the very first-ever reservation for a user through immediately", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor");
    const gateIndex = body.indexOf("IF v_last_cursor IS NOT NULL THEN");
    assert.ok(watermarkIndex >= 0 && watermarkIndex < gateIndex);
  });

  it("preserves the duplicate/daily_cap/reserved result vocabulary and identity/cap ordering", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    assert.match(body, /result := 'duplicate'/iu);
    assert.match(body, /result := 'daily_cap'/iu);
    assert.match(body, /result := 'reserved'/iu);
    assert.ok(
      body.indexOf("memory_v3_lifecycle_shadow_identities") <
        body.indexOf("INSERT INTO public.memory_v3_lifecycle_shadow_identities"),
    );
  });

  it("still serializes concurrent reservation attempts per user with an advisory lock", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    assert.match(body, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(p_user_id::text, 0\)\)/iu);
    const lockIndex = body.indexOf("pg_advisory_xact_lock");
    const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at)");
    assert.ok(lockIndex >= 0 && lockIndex < watermarkIndex);
  });

  it("grants execute only to service_role, matching the prior migration's privileges", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\(\s*uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer\s*\)\s*FROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\(\s*uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer\s*\)\s*TO service_role;/iu,
    );
  });

  it("adds no new table, no network call, and no change to any other RPC", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.doesNotMatch(sql, /https?:\/\//iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 1);
  });
});
