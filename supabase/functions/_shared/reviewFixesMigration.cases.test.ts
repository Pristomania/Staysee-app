import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "migrations", "20261021100000_083_health_reservation_failures_and_report_lock.sql"),
  "utf8",
);

describe("migration 083 (independent review fixes)", () => {
  it("makes the health snapshot count failed reservations of each pipeline", () => {
    assert.match(sql, /FROM public\.memory_v3_reservation_failures/);
    assert.match(sql, /f\.kind = 'dialogue'/);
    assert.match(sql, /f\.kind = 'lifecycle'/);
    assert.match(sql, /'\{failedByCode,reservation_failed\}'/);
  });

  it("keeps the snapshot callable by the service role alone", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.memory_v3_health_snapshot\(integer\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.memory_v3_health_snapshot\(integer\)\s+TO service_role;/);
  });

  it("takes a per-person lock before checking and writing an over-limit report", () => {
    const lock = sql.indexOf("pg_advisory_xact_lock");
    assert.ok(lock > 0);
    assert.ok(lock < sql.indexOf("IF EXISTS ("), "the lock must come before the check");
    assert.ok(lock < sql.indexOf("INSERT INTO public.message_length_events"), "and before the write");
  });

  it("keeps the report function open to signed-in people only", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_over_limit_hit\(integer\) FROM PUBLIC, anon;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_over_limit_hit\(integer\) TO authenticated;/);
    assert.match(sql, /v_user uuid := auth\.uid\(\)/);
  });
});
