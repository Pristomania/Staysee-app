import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260928090000_053_memory_v3_message_count_per_conversation.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 053 must exist");
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

describe("Memory V3 message-count-per-conversation migration", () => {
  it("scopes the lifecycle watermark and count to this conversation, not the whole account", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor");
    const watermarkEnd = body.indexOf("IF v_last_cursor IS NOT NULL THEN", watermarkIndex);
    const watermarkQuery = body.slice(watermarkIndex, watermarkEnd);
    assert.match(watermarkQuery, /WHERE user_id = p_user_id AND conversation_id = p_conversation_id/iu);

    const countIndex = body.indexOf("SELECT pg_catalog.count(*)::integer INTO v_new_message_count");
    const countEnd = body.indexOf("IF v_new_message_count < 10", countIndex);
    const countQuery = body.slice(countIndex, countEnd);
    assert.match(countQuery, /WHERE c\.user_id = p_user_id AND c\.id = p_conversation_id/iu);
  });

  it("scopes the dialogue watermark and count to this conversation, not the whole account", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor");
    const watermarkEnd = body.indexOf("IF v_last_cursor IS NOT NULL THEN", watermarkIndex);
    const watermarkQuery = body.slice(watermarkIndex, watermarkEnd);
    assert.match(watermarkQuery, /WHERE user_id = p_user_id AND conversation_id = p_conversation_id/iu);

    const countIndex = body.indexOf("SELECT pg_catalog.count(*)::integer INTO v_new_message_count");
    const countEnd = body.indexOf("IF v_new_message_count < 10", countIndex);
    const countQuery = body.slice(countIndex, countEnd);
    assert.match(countQuery, /WHERE c\.user_id = p_user_id AND c\.id = p_conversation_id/iu);
  });

  it("removes the now-unnecessary shared per-user budget lock from the dialogue function", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.equal(
      (body.match(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/g) ?? []).length,
      1,
      "only the per-conversation lock should remain -- the shared-budget lock is removed",
    );
    assert.doesNotMatch(body, /,\s*1\)\);/u, "the salt-1 shared-budget lock call must be gone");
  });

  it("keeps the per-conversation state-write lock in the dialogue function, folding in conversation_id", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_dialogue_run");
    assert.match(
      body,
      /p_user_id::text \|\| ':' \|\| p_conversation_id::text \|\| ':' \|\|/iu,
    );
  });

  it("keeps the lifecycle function's single user-wide lock (it protects the shared account-wide head, not the count)", () => {
    const body = functionBlock(migrationSql(), "reserve_memory_v3_lifecycle_shadow_run");
    assert.equal(
      (body.match(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/g) ?? []).length,
      1,
    );
    assert.match(body, /pg_catalog\.hashtextextended\(p_user_id::text, 0\)\);/u);
  });

  it("preserves topic in both functions' item projection, unchanged from migration 048", () => {
    const sql = migrationSql();
    assert.equal((sql.match(/'alternative', i\.alternative, 'topic', i\.topic,/g) ?? []).length, 2);
  });

  it("still allows the very first-ever reservation per conversation through immediately, for both functions", () => {
    for (const name of ["reserve_memory_v3_lifecycle_shadow_run", "reserve_memory_v3_dialogue_run"]) {
      const body = functionBlock(migrationSql(), name);
      const watermarkIndex = body.indexOf("SELECT pg_catalog.max(source_last_created_at) INTO v_last_cursor");
      const gateIndex = body.indexOf("IF v_last_cursor IS NOT NULL THEN");
      assert.ok(watermarkIndex >= 0 && watermarkIndex < gateIndex, `${name} must check v_last_cursor IS NOT NULL before gating`);
    }
  });

  it("preserves the duplicate/daily_cap/reserved result vocabulary in both functions", () => {
    const sql = migrationSql();
    assert.equal((sql.match(/result := 'duplicate'/g) ?? []).length, 4);
    assert.equal((sql.match(/result := 'daily_cap'/g) ?? []).length, 2);
    assert.equal((sql.match(/result := 'reserved'/g) ?? []).length, 2);
  });

  it("grants execute only to service_role for both functions, matching the prior migration's privileges", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\([^)]*\)\s*FROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\([^)]*\)\s*TO service_role;/iu,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.reserve_memory_v3_dialogue_run\([^)]*\) FROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_dialogue_run\([^)]*\) TO service_role;/iu,
    );
  });

  it("adds no new table and changes no other RPC", () => {
    const sql = migrationSql();
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 2);
    assert.doesNotMatch(sql, /CREATE TABLE/iu);
  });
});
