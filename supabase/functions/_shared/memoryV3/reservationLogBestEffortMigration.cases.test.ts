import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261007070000_068_memory_v3_reservation_log_best_effort.sql"),
  "utf8",
);

describe("Memory V3 reservation-log-best-effort migration", () => {
  it("wraps the logging INSERT itself in its own exception handler, in both functions", () => {
    assert.equal((sql.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length, 4);
    assert.equal((sql.match(/NULL; -- logging is best-effort/g) ?? []).length, 2);
  });

  it("still reaches the clean reservation_failed return even if the log insert itself fails", () => {
    for (const marker of ["'dialogue', p_user_id, p_conversation_id", "'lifecycle', p_user_id, p_conversation_id"]) {
      const insertIndex = sql.indexOf(marker);
      assert.ok(insertIndex >= 0, marker);
      const afterInsert = sql.slice(insertIndex, insertIndex + 400);
      assert.match(afterInsert, /EXCEPTION WHEN OTHERS THEN\s*NULL;/);
      assert.match(afterInsert, /result := 'reservation_failed'; run_id := NULL; expected_state_revision := NULL; state := NULL;/);
    }
  });

  it("never touches the log table's own definition, the fail RPCs, or the hot-path read context RPCs", () => {
    assert.equal(/CREATE TABLE/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_dialogue_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_lifecycle_shadow_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
