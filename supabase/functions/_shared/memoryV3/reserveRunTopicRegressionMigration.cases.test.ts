import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261007080000_069_memory_v3_reserve_run_topic_regression.sql"),
  "utf8",
);

describe("Memory V3 reserve-run topic-regression migration", () => {
  it("re-adds 'topic', i.topic to both reserve functions' per-item JSON build", () => {
    assert.equal(
      (sql.match(/'eventTimeEnd', i\.event_time_end, 'alternative', i\.alternative, 'topic', i\.topic,/g) ?? []).length,
      2,
    );
  });

  it("replaces both reserve functions with their unchanged (migration 068) signature", () => {
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_dialogue_run\(\s*p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,\s*p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,\s*p_source_last_message_id uuid, p_source_last_created_at timestamptz,\s*p_message_count integer, p_user_message_count integer\s*\)/,
    );
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\(\s*p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,\s*p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,\s*p_source_last_message_id uuid, p_source_last_created_at timestamptz,\s*p_message_count integer, p_user_message_count integer\s*\)/,
    );
  });

  it("keeps everything migrations 066-068 added: no daily cap for dialogue, the exception handler, and the best-effort log guard", () => {
    assert.equal(sql.includes("v_daily_count"), true); // lifecycle still has its own cap
    const dialogueStart = sql.indexOf("reserve_memory_v3_dialogue_run");
    const lifecycleStart = sql.indexOf("reserve_memory_v3_lifecycle_shadow_run");
    const dialogueBody = sql.slice(dialogueStart, lifecycleStart);
    assert.equal(dialogueBody.includes("v_daily_count"), false, "dialogue cap must stay removed");
    assert.equal((sql.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length, 4);
    assert.equal((sql.match(/NULL; -- logging is best-effort/g) ?? []).length, 2);
  });

  it("never touches the fail RPCs, the CAS/apply RPCs, the hot-path read context RPCs, or the log table's own definition", () => {
    assert.equal(/CREATE TABLE/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_dialogue_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.fail_memory_v3_lifecycle_shadow_run/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.apply_memory_v3_dialogue_state/.test(sql), false);
    assert.equal(/CREATE (OR REPLACE )?FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
