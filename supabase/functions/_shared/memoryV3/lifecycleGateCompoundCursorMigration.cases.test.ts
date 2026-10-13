import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261013100000_078_memory_v3_lifecycle_gate_compound_cursor.sql"),
  "utf8",
);

describe("Memory V3 lifecycle gate compound-cursor migration", () => {
  it("only replaces the lifecycle function", () => {
    assert.equal(sql.includes("reserve_memory_v3_dialogue_run"), false);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run/);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  });

  it("selects the cursor's paired message id, not just its timestamp", () => {
    assert.match(
      sql,
      /SELECT r\.source_last_created_at, r\.source_last_message_id\s*\n\s*INTO v_last_cursor_at, v_last_cursor_id/,
    );
    assert.match(
      sql,
      /ORDER BY r\.source_last_created_at DESC, r\.source_last_message_id DESC\s*\n\s*LIMIT 1;/,
    );
    assert.equal(sql.includes("v_last_cursor timestamptz"), false);
  });

  it("counts new messages by the compound (created_at, id) comparison, not created_at alone", () => {
    assert.match(
      sql,
      /AND \(m\.created_at > v_last_cursor_at\s*\n\s*OR \(m\.created_at = v_last_cursor_at AND m\.id > v_last_cursor_id\)\)/,
    );
    assert.equal(sql.includes("m.created_at > v_last_cursor;"), false);
  });

  it("still gates on 10 new messages and keeps the daily_cap wire result", () => {
    assert.match(sql, /IF v_new_message_count < 10 THEN/);
    assert.match(sql, /result := 'daily_cap';/);
  });

  it("keeps everything migration 077 added: no separate daily-success cap, the topic field, the link-pointer fields, the exception handler", () => {
    assert.equal(sql.includes("v_daily_count"), false);
    assert.equal(sql.includes("v_daily_success_count"), false);
    assert.match(sql, /'alternative', i\.alternative, 'topic', i\.topic,/);
    assert.match(sql, /'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key,/);
    assert.equal((sql.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length, 2);
  });

  it("keeps the function signature identical to migration 077's", () => {
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\(\s*p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,\s*p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,\s*p_source_last_message_id uuid, p_source_last_created_at timestamptz,\s*p_message_count integer, p_user_message_count integer\s*\)/,
    );
  });
});
