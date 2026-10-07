import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261007050000_066_memory_v3_dialogue_cap_paused.sql"),
  "utf8",
);

describe("Memory V3 dialogue daily-cap-paused migration", () => {
  it("replaces reserve_memory_v3_dialogue_run with the same 11-argument signature", () => {
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_dialogue_run\(\s*p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,\s*p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,\s*p_source_last_message_id uuid, p_source_last_created_at timestamptz,\s*p_message_count integer, p_user_message_count integer\s*\)/,
    );
  });

  it("removes the daily cap check entirely rather than raising it", () => {
    assert.equal(sql.includes("v_daily_count"), false);
    assert.equal(sql.includes("daily_cap"), false);
  });

  it("keeps the per-conversation advisory lock and drops the now-unused per-person cap lock", () => {
    assert.equal((sql.match(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/g) ?? []).length, 1);
    assert.match(
      sql,
      /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(\s*p_user_id::text \|\| ':' \|\| p_conversation_id::text \|\| ':' \|\|\s*\(\(pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)::date\)::text, 0\)\)/,
    );
  });

  it("keeps the duplicate-identity short-circuit and the state-too-large guard intact", () => {
    assert.match(sql, /ON CONFLICT \(user_id, conversation_id, pipeline_version, input_hash\) DO NOTHING/);
    assert.match(sql, /RAISE EXCEPTION 'dialogue state too large'/);
    assert.match(sql, /result := 'duplicate'/);
  });

  it("never touches the lifecycle reservation RPC, the fail RPCs, or the hot-path read context RPCs", () => {
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_dialogue_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
