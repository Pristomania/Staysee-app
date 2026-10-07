import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261007060000_067_memory_v3_reservation_failure_log.sql"),
  "utf8",
);

describe("Memory V3 reservation-failure-log migration", () => {
  it("creates the log table scoped to a kind, user, and conversation, with RLS and no policies", () => {
    assert.match(sql, /CREATE TABLE public\.memory_v3_reservation_failures/);
    assert.match(sql, /kind text NOT NULL CHECK \(kind IN \('dialogue', 'lifecycle'\)\)/);
    assert.match(sql, /user_id uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
    assert.match(sql, /conversation_id uuid NOT NULL REFERENCES public\.conversations\(id\) ON DELETE CASCADE/);
    assert.match(sql, /detail text NOT NULL CHECK \(length\(detail\) > 0\)/);
    assert.match(sql, /ALTER TABLE public\.memory_v3_reservation_failures ENABLE ROW LEVEL SECURITY;/);
    assert.equal(/CREATE POLICY/i.test(sql), false);
  });

  it("locks the log table to service_role only, read and insert, no update or delete", () => {
    assert.match(sql, /REVOKE ALL ON TABLE public\.memory_v3_reservation_failures FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.memory_v3_reservation_failures TO service_role;/);
  });

  it("wraps both reserve functions' bodies in their own exception handler", () => {
    assert.equal((sql.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length, 2);
  });

  it("logs kind, user, conversation, and a capped error message before returning the sentinel row", () => {
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_reservation_failures\(kind, user_id, conversation_id, detail\)\s*VALUES \('dialogue', p_user_id, p_conversation_id, pg_catalog\.left\(SQLERRM, 500\)\);/,
    );
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_reservation_failures\(kind, user_id, conversation_id, detail\)\s*VALUES \('lifecycle', p_user_id, p_conversation_id, pg_catalog\.left\(SQLERRM, 500\)\);/,
    );
    assert.equal(
      (sql.match(/result := 'reservation_failed'; run_id := NULL; expected_state_revision := NULL; state := NULL;/g) ?? []).length,
      2,
    );
  });

  it("never raises out of either reserve function on its own failure path -- both end in RETURN, not RAISE", () => {
    for (const marker of [
      "EXCEPTION WHEN OTHERS THEN\n    INSERT INTO public.memory_v3_reservation_failures(kind, user_id, conversation_id, detail)\n    VALUES ('dialogue'",
      "EXCEPTION WHEN OTHERS THEN\n    INSERT INTO public.memory_v3_reservation_failures(kind, user_id, conversation_id, detail)\n    VALUES ('lifecycle'",
    ]) {
      const start = sql.indexOf(marker);
      assert.ok(start >= 0, marker);
      const handlerEnd = sql.indexOf("END;\nEND;\n$$;", start);
      const handler = sql.slice(start, handlerEnd);
      assert.equal(handler.includes("RAISE;"), false);
    }
  });

  it("keeps the lifecycle daily cap and the dialogue per-conversation lock intact", () => {
    assert.match(sql, /IF v_daily_count >= 1 THEN/);
    assert.match(
      sql,
      /p_user_id::text \|\| ':' \|\| p_conversation_id::text \|\| ':' \|\|\s*\(\(pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)::date\)::text, 0\)\)/,
    );
  });

  it("never touches the fail RPCs, the CAS/apply RPCs, or the hot-path read context RPCs", () => {
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_dialogue_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_lifecycle_shadow_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.apply_memory_v3_dialogue_state/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.apply_memory_v3_lifecycle_shadow_state/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_lifecycle_read_context/.test(sql), false);
  });
});
