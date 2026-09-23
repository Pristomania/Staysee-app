import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260924130000_048_memory_v3_reserve_run_topic.sql"),
  "utf8",
);

describe("Memory V3 reserve-run topic migration", () => {
  it("recreates both reserve-run RPCs", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_dialogue_run/);
  });

  it("adds topic right after alternative in both functions' item-JSON build, matching the apply-state convention", () => {
    const matches = sql.match(/'alternative', i\.alternative, 'topic', i\.topic,/g) ?? [];
    assert.equal(matches.length, 2);
  });

  it("leaves the message-count gate (10-message threshold, watermark cursor) unchanged in both functions", () => {
    const watermarkSelects = sql.match(/SELECT pg_catalog\.max\(source_last_created_at\) INTO v_last_cursor/g) ?? [];
    assert.equal(watermarkSelects.length, 2);

    const newMessageCounts = sql.match(/SELECT pg_catalog\.count\(\*\)::integer INTO v_new_message_count/g) ?? [];
    assert.equal(newMessageCounts.length, 2);

    const thresholdChecks = sql.match(/IF v_new_message_count < 10 THEN/g) ?? [];
    assert.equal(thresholdChecks.length, 2);

    const dailyCapResults = sql.match(/result := 'daily_cap';/g) ?? [];
    assert.equal(dailyCapResults.length, 2);
  });

  it("grants EXECUTE on both functions to service_role only", () => {
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\([^)]*\)\s*FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\([^)]*\)\s*TO service_role;/,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.reserve_memory_v3_dialogue_run\([^)]*\) FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_dialogue_run\([^)]*\) TO service_role;/,
    );
  });

  it("does not touch the evidence tables or any other function", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.apply_memory_v3/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3/.test(sql), false);
  });
});
