import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260925010000_052_memory_v3_delete_all.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 052 must exist");
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

describe("Memory V3 delete-all migration", () => {
  it("deletes every lifecycle item and head for the owning user only", () => {
    const body = functionBlock(migrationSql(), "delete_all_memory_v3_lifecycle_data");
    assert.match(body, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /p_user_id uuid/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id;/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_lifecycle_shadow_heads WHERE user_id = p_user_id;/iu);
    assert.doesNotMatch(body, /conversation_id/iu);
    assert.doesNotMatch(body, /memory_key/iu);
    assert.doesNotMatch(body, /memory_v3_lifecycle_shadow_evidence/iu);
    assert.doesNotMatch(body, /memory_v3_lifecycle_shadow_identities/iu);
    assert.doesNotMatch(body, /memory_v3_lifecycle_shadow_runs/iu);
  });

  it("deletes every dialogue item and head for the owning user only", () => {
    const body = functionBlock(migrationSql(), "delete_all_memory_v3_dialogue_data");
    assert.match(body, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /p_user_id uuid/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_dialogue_items WHERE user_id = p_user_id;/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_dialogue_heads WHERE user_id = p_user_id;/iu);
    assert.doesNotMatch(body, /conversation_id/iu);
    assert.doesNotMatch(body, /memory_key/iu);
    assert.doesNotMatch(body, /memory_v3_dialogue_evidence/iu);
    assert.doesNotMatch(body, /memory_v3_dialogue_identities/iu);
    assert.doesNotMatch(body, /memory_v3_dialogue_runs/iu);
  });

  it("grants execute only to service_role for both functions", () => {
    const sql = migrationSql();
    for (const name of [
      "delete_all_memory_v3_lifecycle_data",
      "delete_all_memory_v3_dialogue_data",
    ] as const) {
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(uuid\\) FROM PUBLIC, anon, authenticated;`, "iu"),
      );
      assert.match(
        sql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(uuid\\) TO service_role;`, "iu"),
      );
    }
  });

  it("adds no new table, no policy, and changes no other function", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 2);
  });
});
