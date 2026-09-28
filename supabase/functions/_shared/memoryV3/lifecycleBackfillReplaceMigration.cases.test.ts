import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260928040000_054_memory_v3_lifecycle_backfill_replace_sql_fix.sql"),
  "utf8",
);

describe("Memory V3 lifecycle backfill replacement migration", () => {
  it("accepts the lifecycle-owned extractor and nonnegative observed revisions", () => {
    assert.match(sql, /p_expected_state_revision < 0/);
    assert.doesNotMatch(sql, /p_expected_state_revision IS DISTINCT FROM 0/);
    assert.match(sql, /memory-v3-openrouter-gemini-3\.7-flash-lifecycle-extractor-v1/);
  });

  it("locks the head and rejects a revision race before deleting existing items", () => {
    const lockAt = sql.search(/FOR UPDATE/);
    const compareAt = sql.search(/v_head\.state_revision <> p_expected_state_revision/);
    const deleteAt = sql.search(/DELETE FROM public\.memory_v3_lifecycle_shadow_items/);
    assert.ok(lockAt >= 0 && compareAt > lockAt && deleteAt > compareAt);
  });

  it("advances the stored revision beyond both the artifact and replaced head", () => {
    assert.match(
      sql,
      /v_resulting_state_revision := GREATEST\(\s*\(p_state->>'stateRevision'\)::bigint,\s*p_expected_state_revision \+ 1\s*\)/,
    );
    assert.match(sql, /SET state_revision = v_resulting_state_revision/);
    assert.match(sql, /p_expected_state_revision,\s*v_resulting_state_revision, v_item_count, v_evidence_count/);
    assert.match(sql, /resulting_state_revision := v_resulting_state_revision/);
  });

  it("never reuses memory ordinals consumed by the replaced live state", () => {
    assert.match(
      sql,
      /next_memory_ordinal = GREATEST\(\s*\(p_state->>'nextMemoryOrdinal'\)::bigint,\s*v_head\.next_memory_ordinal\s*\)/,
    );
  });

  it("does not schema-qualify PostgreSQL's GREATEST conditional expression", () => {
    assert.doesNotMatch(sql, /pg_catalog\.greatest/);
  });

  it("keeps one reviewed import per user and service-role-only execution", () => {
    assert.match(sql, /memory_v3_lifecycle_backfill_imports[\s\S]*WHERE user_id = p_user_id/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.import_memory_v3_lifecycle_backfill_state\([\s\S]*TO service_role;/);
    assert.doesNotMatch(sql, /GRANT EXECUTE[\s\S]*TO (?:anon|authenticated)/);
  });

  it("updates audit constraints without creating a second import table", () => {
    assert.match(sql, /ALTER TABLE public\.memory_v3_lifecycle_backfill_imports/);
    assert.match(sql, /expected_state_revision >= 0/);
    assert.match(sql, /extractor_version IN \(/);
    assert.doesNotMatch(sql, /CREATE TABLE/);
  });
});
