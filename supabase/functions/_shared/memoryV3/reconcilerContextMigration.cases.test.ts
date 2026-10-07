import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261007100000_071_memory_v3_reconciler_context.sql"),
  "utf8",
);

describe("Memory V3 reconciler_context migration", () => {
  it("adds reconciler_context to both runs tables", () => {
    assert.match(sql, /ALTER TABLE public\.memory_v3_dialogue_runs\s+ADD COLUMN IF NOT EXISTS reconciler_context text NULL;/);
    assert.match(sql, /ALTER TABLE public\.memory_v3_lifecycle_shadow_runs\s+ADD COLUMN IF NOT EXISTS reconciler_context text NULL;/);
  });

  it("drops the old 5-argument fail RPCs before recreating them with 6 arguments", () => {
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.fail_memory_v3_dialogue_run\(uuid, uuid, text, text, text\);/);
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.fail_memory_v3_lifecycle_shadow_run\(uuid, uuid, text, text, text\);/);
  });

  it("gives both fail RPCs a p_reconciler_context parameter that defaults to NULL", () => {
    assert.match(
      sql,
      /CREATE FUNCTION public\.fail_memory_v3_dialogue_run\(\s*p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,\s*p_reconciler_raw_response text DEFAULT NULL, p_reconciler_context text DEFAULT NULL\s*\)/,
    );
    assert.match(
      sql,
      /CREATE FUNCTION public\.fail_memory_v3_lifecycle_shadow_run\(\s*p_run_id uuid, p_user_id uuid, p_diagnostic_code text, p_transport_detail text DEFAULT NULL,\s*p_reconciler_raw_response text DEFAULT NULL, p_reconciler_context text DEFAULT NULL\s*\)/,
    );
  });

  it("writes reconciler_context alongside diagnostic_code in both UPDATE statements, capped to 20000 characters", () => {
    assert.equal(
      (sql.match(/reconciler_context = pg_catalog\.left\(p_reconciler_context, 20000\)/g) ?? []).length,
      2,
    );
  });

  it("keeps the fail RPCs restricted to service_role only", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.fail_memory_v3_dialogue_run\(uuid, uuid, text, text, text, text\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fail_memory_v3_dialogue_run\(uuid, uuid, text, text, text, text\) TO service_role;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.fail_memory_v3_lifecycle_shadow_run\(uuid, uuid, text, text, text, text\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fail_memory_v3_lifecycle_shadow_run\(uuid, uuid, text, text, text, text\) TO service_role;/);
  });

  it("never touches the hot-path read context RPCs or the reservation/compare-and-swap RPCs", () => {
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_lifecycle_read_context/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.reserve_memory_v3_dialogue_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.apply_memory_v3_dialogue_state/.test(sql), false);
  });
});
