import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923120000_042_memory_v3_viewer_delete.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 042 must exist");
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

describe("Memory V3 viewer delete migration", () => {
  it("deletes a lifecycle item scoped strictly to its owning user", () => {
    const body = functionBlock(migrationSql(), "delete_memory_v3_lifecycle_item");
    assert.match(body, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_lifecycle_shadow_items/iu);
    assert.match(body, /WHERE user_id = p_user_id AND memory_key = p_memory_key/iu);
    assert.doesNotMatch(body, /memory_v3_lifecycle_shadow_evidence/iu);
  });

  it("deletes a dialogue item scoped strictly to its owning user and conversation", () => {
    const body = functionBlock(migrationSql(), "delete_memory_v3_dialogue_item");
    assert.match(body, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_dialogue_items/iu);
    assert.match(
      body,
      /WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND memory_key = p_memory_key/iu,
    );
    assert.doesNotMatch(body, /memory_v3_dialogue_evidence/iu);
  });

  it("grants execute only to service_role for both functions", () => {
    const sql = migrationSql();
    for (const [name, args] of [
      ["delete_memory_v3_lifecycle_item", "uuid, text"],
      ["delete_memory_v3_dialogue_item", "uuid, uuid, text"],
    ] as const) {
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(${args}\\) FROM PUBLIC, anon, authenticated;`, "iu"),
      );
      assert.match(
        sql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${args}\\) TO service_role;`, "iu"),
      );
    }
  });

  it("adds no new table, no policy, and changes no other function", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 2);
  });
});
