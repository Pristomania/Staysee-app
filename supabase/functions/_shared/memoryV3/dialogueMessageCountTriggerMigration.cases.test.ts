import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923110000_041_memory_v3_dialogue_message_count_trigger.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 041 must exist");
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

describe("Memory V3 dialogue message-count trigger migration", () => {
  it("drops the calendar-day cap and gates on 10 new messages across all of the user's dialogues", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.doesNotMatch(body, /v_daily_count/iu);
    assert.doesNotMatch(body, /date_trunc\('day'/iu);
    assert.match(body, /v_new_message_count integer;/iu);
    assert.match(body, /IF v_new_message_count < 10 THEN/iu);
  });

  it("keeps the existing shared-budget lock pair and does not filter the count by conversation_id", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.equal(
      (body.match(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/g) ?? []).length,
      2,
      "must still have the two-lock pair from the shared-budget fix",
    );
    assert.match(body, /p_user_id::text \|\| ':' \|\| p_conversation_id::text \|\| ':' \|\|/iu);
    assert.match(body, /p_user_id::text \|\| ':' \|\|\s*\(\(pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)::date\)::text, 1\)\)/iu);
    const countIndex = body.indexOf("SELECT pg_catalog.count(*)::integer INTO v_new_message_count");
    assert.ok(countIndex >= 0);
    const countEnd = body.indexOf("IF v_new_message_count < 10", countIndex);
    const countQuery = body.slice(countIndex, countEnd);
    assert.equal(countQuery.includes("p_conversation_id"), false, "count must stay shared across dialogues, not filtered to one conversation");
    assert.match(countQuery, /WHERE c\.user_id = p_user_id/iu);
  });

  it("still allows the very first-ever dialogue reservation for a user through immediately", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor");
    const gateIndex = body.indexOf("IF v_last_cursor IS NOT NULL THEN");
    assert.ok(watermarkIndex >= 0 && watermarkIndex < gateIndex);
  });

  it("preserves the duplicate/daily_cap/reserved result vocabulary", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.match(body, /result := 'duplicate'/iu);
    assert.match(body, /result := 'daily_cap'/iu);
    assert.match(body, /result := 'reserved'/iu);
  });

  it("grants execute only to service_role, matching the prior migration's privileges", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.reserve_memory_v3_dialogue_run\(uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer\) FROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_dialogue_run\(uuid, uuid, text, text, text, text, text, uuid, timestamptz, integer, integer\) TO service_role;/iu,
    );
  });

  it("adds no new table, no network call, and changes no other RPC", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.doesNotMatch(sql, /https?:\/\//iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 1);
  });
});
