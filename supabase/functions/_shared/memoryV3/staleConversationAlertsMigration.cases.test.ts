import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260929090000_059_memory_v3_stale_conversation_alerts.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 059 must exist");
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

describe("Memory V3 stale-conversation alert migration", () => {
  it("creates the dedup table with a composite key and no public grants", () => {
    const sql = migrationSql();
    assert.match(sql, /CREATE TABLE public\.memory_v3_stale_alerts/iu);
    assert.match(sql, /PRIMARY KEY \(user_id, conversation_id, scope\)/iu);
    assert.match(sql, /CHECK \(scope IN \('dialogue', 'lifecycle'\)\)/iu);
    assert.match(sql, /ALTER TABLE public\.memory_v3_stale_alerts ENABLE ROW LEVEL SECURITY;/iu);
    assert.match(
      sql,
      /REVOKE ALL ON TABLE public\.memory_v3_stale_alerts\s*\nFROM PUBLIC, anon, authenticated, service_role;/iu,
    );
  });

  it("gates on both scopes with the same threshold and requires recent activity", () => {
    const body = functionBlock(migrationSql(), "flag_memory_v3_stale_conversations");
    assert.match(body, /v_threshold CONSTANT integer := 25;/iu);
    assert.match(body, /v_activity_window CONSTANT interval := interval '3 days';/iu);
    assert.match(body, /v_quiet_period CONSTANT interval := interval '24 hours';/iu);
    assert.equal((body.match(/'dialogue'::text/g) ?? []).length, 1);
    assert.equal((body.match(/'lifecycle'::text/g) ?? []).length, 1);
    assert.equal((body.match(/counts\.new_message_count >= v_threshold/g) ?? []).length, 2);
    assert.equal(
      (body.match(/m2\.created_at > pg_catalog\.now\(\) - v_activity_window/g) ?? []).length,
      2,
    );
  });

  it("only considers conversations where cross_memory_enabled is true", () => {
    const body = functionBlock(migrationSql(), "flag_memory_v3_stale_conversations");
    assert.equal((body.match(/c\.cross_memory_enabled = true/g) ?? []).length, 2);
  });

  it("watermarks per conversation from the matching scope's own runs table", () => {
    const body = functionBlock(migrationSql(), "flag_memory_v3_stale_conversations");
    assert.match(
      body,
      /FROM public\.memory_v3_dialogue_runs r\s*\n\s*WHERE r\.user_id = c\.user_id AND r\.conversation_id = c\.id/iu,
    );
    assert.match(
      body,
      /FROM public\.memory_v3_lifecycle_shadow_runs r\s*\n\s*WHERE r\.user_id = c\.user_id AND r\.conversation_id = c\.id/iu,
    );
  });

  it("re-flags an already-recorded conversation only after the quiet period, via ON CONFLICT DO UPDATE ... WHERE", () => {
    const body = functionBlock(migrationSql(), "flag_memory_v3_stale_conversations");
    assert.match(body, /ON CONFLICT \(user_id, conversation_id, scope\) DO UPDATE/iu);
    assert.match(
      body,
      /WHERE public\.memory_v3_stale_alerts\.last_alerted_at <= pg_catalog\.now\(\) - v_quiet_period/iu,
    );
    assert.match(body, /RETURNING public\.memory_v3_stale_alerts\.user_id/iu);
  });

  it("grants execute only to service_role", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.flag_memory_v3_stale_conversations\(\)\s*\nFROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.flag_memory_v3_stale_conversations\(\)\s*\nTO service_role;/iu,
    );
  });

  it("defines exactly one function and one new table", () => {
    const sql = migrationSql();
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 1);
    assert.equal((sql.match(/CREATE TABLE/gi) ?? []).length, 1);
  });
});
