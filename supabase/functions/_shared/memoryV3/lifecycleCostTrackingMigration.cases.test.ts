import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923100000_040_memory_v3_lifecycle_cost_tracking.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 040 must exist");
  return readFileSync(MIGRATION_URL, "utf8");
}

describe("Memory V3 lifecycle cost tracking migration", () => {
  it("adds call_kind as a nullable additive column, not a breaking one", () => {
    const sql = migrationSql();
    assert.match(sql, /ALTER TABLE public\.ai_usage_logs ADD COLUMN IF NOT EXISTS call_kind text NULL/iu);
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DROP FUNCTION|ALTER TABLE public\.ai_usage_logs (?!ADD)/iu);
  });

  it("indexes call_kind as a partial index (most rows are chat replies with NULL call_kind)", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_call_kind\s+ON public\.ai_usage_logs \(call_kind\)\s+WHERE call_kind IS NOT NULL/iu,
    );
  });

  it("aggregates both stages of a lifecycle check by user with counters and a cost sum", () => {
    const sql = migrationSql();
    const viewStart = sql.indexOf("CREATE OR REPLACE VIEW public.v_analytics_memory_lifecycle_cost_by_user");
    assert.ok(viewStart >= 0, "view must exist");
    const viewEnd = sql.indexOf("CREATE OR REPLACE FUNCTION", viewStart);
    const view = sql.slice(viewStart, viewEnd);
    assert.match(view, /count\(\*\) FILTER \(WHERE call_kind = 'memory_lifecycle_extractor'\)/iu);
    assert.match(view, /count\(\*\) FILTER \(WHERE call_kind = 'memory_lifecycle_reconciler'\)/iu);
    // A "check" is one run = two logged calls (extractor + reconciler)
    // sharing request_id, not two separate checks.
    assert.match(view, /count\(DISTINCT request_id\) FILTER/iu);
    assert.match(view, /coalesce\(sum\(cost\) FILTER/iu);
    assert.match(view, /GROUP BY user_id/iu);
  });

  it("exposes the same aggregation through a service_role-only RPC with a time window", () => {
    const sql = migrationSql();
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.get_memory_lifecycle_cost_by_users");
    assert.ok(fnStart >= 0, "RPC must exist");
    const fnBody = sql.slice(fnStart);
    assert.match(fnBody, /p_since timestamptz DEFAULT now\(\) - interval '30 days'/iu);
    assert.match(fnBody, /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public/iu);
    assert.match(fnBody, /WHERE created_at >= p_since/iu);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.get_memory_lifecycle_cost_by_users\(timestamptz\) FROM PUBLIC;/iu,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.get_memory_lifecycle_cost_by_users\(timestamptz\) TO service_role;/iu,
    );
  });

  it("touches no other table, RLS policy, or RPC", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|CREATE POLICY|ALTER TABLE(?! public\.ai_usage_logs)/iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 1);
    assert.equal((sql.match(/CREATE OR REPLACE VIEW/gi) ?? []).length, 1);
  });
});
