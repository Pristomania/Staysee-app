import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261014090000_079_memory_v3_forced_skip_alert.sql"),
  "utf8",
);

describe("Memory V3 forced-skip alert migration", () => {
  it("only replaces the alert reservation function", () => {
    assert.equal(sql.includes("reserve_memory_v3_dialogue_run"), false);
    assert.equal(sql.includes("reserve_memory_v3_lifecycle_shadow_run"), false);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_alert_window/);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  });

  it("drops and re-adds the CHECK constraint, adding exactly one new key", () => {
    assert.match(sql, /ALTER TABLE public\.memory_v3_alert_windows\s*\n\s*DROP CONSTRAINT memory_v3_alert_windows_key_check;/);
    assert.match(sql, /ALTER TABLE public\.memory_v3_alert_windows\s*\n\s*ADD CONSTRAINT memory_v3_alert_windows_key_check CHECK \(alert_key IN \(/);
    const oldKeys = [
      "read:load_failed", "read:invalid_shape", "read:too_large",
      "write:invalid_source", "write:state_too_large", "write:extractor_transport_failed",
      "write:extractor_parse_invalid", "write:extractor_shape_invalid", "write:extractor_contract_invalid",
      "write:reconciler_request_too_large", "write:reconciler_transport_failed", "write:reconciler_parse_invalid",
      "write:reconciler_shape_invalid", "write:reconciler_contract_invalid", "write:state_conflict",
      "write:state_write_failed", "write:reservation_failed", "write:unknown_failure",
    ];
    for (const key of oldKeys) assert.match(sql, new RegExp(`'${key}'`));
    assert.match(sql, /'write:forced_skip'/);
  });

  it("lists the new key in both the CHECK constraint and the function's own validation (plus the header comment)", () => {
    assert.equal((sql.match(/'write:forced_skip'/g) ?? []).length, 3);
  });

  it("keeps the dedup window, retention, and grants unchanged from migration 038", () => {
    assert.match(sql, /date_trunc\('hour', pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)/);
    assert.match(sql, /DELETE FROM public\.memory_v3_alert_windows\s*\n\s*WHERE window_start < pg_catalog\.now\(\) - INTERVAL '14 days';/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.reserve_memory_v3_alert_window\(text\)\s*\n\s*TO service_role;/);
  });

  it("does not touch the memory_v3_alert_windows table's shape or RLS, only its CHECK constraint", () => {
    assert.equal(sql.includes("CREATE TABLE"), false);
    assert.equal(sql.includes("ENABLE ROW LEVEL SECURITY"), false);
  });
});
