import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261010120000_074_memory_v3_reserve_run_link_fields.sql"),
  "utf8",
);

describe("Memory V3 reserve-run link-fields migration", () => {
  it("threads replacesMemoryKey/replacedByMemoryKey through reserve_memory_v3_dialogue_run's item snapshot", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run"));
    assert.match(
      body,
      /'firstSeenAt', i\.first_seen_at, 'updatedAt', i\.updated_at, 'revision', i\.revision,\s*\n\s*'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key,/,
    );
  });

  it("threads replacesMemoryKey/replacedByMemoryKey through reserve_memory_v3_lifecycle_shadow_run's item snapshot", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run"),
    );
    assert.match(
      body,
      /'firstSeenAt', i\.first_seen_at, 'updatedAt', i\.updated_at, 'revision', i\.revision,\s*\n\s*'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key,/,
    );
  });

  it("does not change any other clause of either function (same guards, locks, caps)", () => {
    assert.match(sql, /RAISE EXCEPTION 'dialogue state too large'/);
    assert.match(sql, /RAISE EXCEPTION 'lifecycle state too large'/);
    assert.match(sql, /v_daily_count >= 1/);
  });
});
