import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923130000_043_memory_v3_viewer_read.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 043 must exist");
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

describe("Memory V3 viewer read migration", () => {
  it("reads lifecycle items scoped to the user, including memoryKey", () => {
    const body = functionBlock(migrationSql(), "load_memory_v3_lifecycle_viewer_items");
    assert.match(body, /LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /FROM public\.memory_v3_lifecycle_shadow_items/iu);
    assert.match(body, /WHERE i\.user_id = p_user_id/iu);
    assert.match(body, /'memoryKey', i\.memory_key/iu);
    assert.doesNotMatch(body, /p_conversation_id/iu);
  });

  it("reads dialogue items scoped to the user and conversation, including memoryKey", () => {
    const body = functionBlock(migrationSql(), "load_memory_v3_dialogue_viewer_items");
    assert.match(body, /LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /FROM public\.memory_v3_dialogue_items/iu);
    assert.match(body, /WHERE i\.user_id = p_user_id AND i\.conversation_id = p_conversation_id/iu);
    assert.match(body, /'memoryKey', i\.memory_key/iu);
  });

  it("does not touch the existing hot-path read RPCs used by the live chat", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_read_context/iu);
    assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_read_context/iu);
  });

  it("grants execute only to service_role for both functions", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.load_memory_v3_lifecycle_viewer_items\(uuid\) FROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_lifecycle_viewer_items\(uuid\) TO service_role;/iu,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.load_memory_v3_dialogue_viewer_items\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_dialogue_viewer_items\(uuid, uuid\) TO service_role;/iu,
    );
  });

  it("adds no new table, no policy, and changes no other function", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 2);
  });
});
