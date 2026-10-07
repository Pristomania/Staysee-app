import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261007040000_065_memory_v3_reconciler_raw_response.sql"),
  "utf8",
);

describe("Memory V3 reconciler_raw_response migration", () => {
  it("adds reconciler_raw_response to both runs tables", () => {
    assert.match(sql, /ALTER TABLE public\.memory_v3_dialogue_runs\s+ADD COLUMN IF NOT EXISTS reconciler_raw_response text NULL;/);
    assert.match(sql, /ALTER TABLE public\.memory_v3_lifecycle_shadow_runs\s+ADD COLUMN IF NOT EXISTS reconciler_raw_response text NULL;/);
  });

  it("drops the old 4-argument fail RPCs before recreating them with 5 arguments", () => {
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.fail_memory_v3_dialogue_run\(uuid, uuid, text, text\);/);
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.fail_memory_v3_lifecycle_shadow_run\(uuid, uuid, text, text\);/);
  });

  it("gives both fail RPCs a p_reconciler_raw_response parameter that defaults to NULL", () => {
    assert.match(
      sql,
      /CREATE FUNCTION public\.fail_memory_v3_dialogue_run\(\s*p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,\s*p_reconciler_raw_response text DEFAULT NULL\s*\)/,
    );
    assert.match(
      sql,
      /CREATE FUNCTION public\.fail_memory_v3_lifecycle_shadow_run\(\s*p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,\s*p_reconciler_raw_response text DEFAULT NULL\s*\)/,
    );
  });

  it("writes reconciler_raw_response alongside diagnostic_code in both UPDATE statements, capped to 8000 characters", () => {
    assert.equal(
      (sql.match(/reconciler_raw_response = pg_catalog\.left\(p_reconciler_raw_response, 8000\)/g) ?? []).length,
      2,
    );
  });

  it("keeps the fail RPCs restricted to service_role only, matching the original", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.fail_memory_v3_dialogue_run\(uuid, uuid, text, text, text\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fail_memory_v3_dialogue_run\(uuid, uuid, text, text, text\) TO service_role;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.fail_memory_v3_lifecycle_shadow_run\(uuid, uuid, text, text, text\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fail_memory_v3_lifecycle_shadow_run\(uuid, uuid, text, text, text\) TO service_role;/);
  });

  it("never touches the hot-path read context RPCs or the reservation/compare-and-swap RPCs", () => {
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_lifecycle_read_context/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.reserve_memory_v3_dialogue_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.apply_memory_v3_dialogue_state/.test(sql), false);
  });
});
