import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261013090000_077_memory_v3_lifecycle_watermark_restore.sql"),
  "utf8",
);

describe("Memory V3 lifecycle watermark restore migration", () => {
  it("only replaces the lifecycle function, never the dialogue one", () => {
    assert.equal(sql.includes("reserve_memory_v3_dialogue_run"), false);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run/);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  });

  it("gates on 10 new per-conversation messages since the last SUCCEEDED run, not any run", () => {
    assert.match(
      sql,
      /FROM public\.memory_v3_lifecycle_shadow_runs\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND status = 'succeeded';/,
    );
    assert.match(sql, /IF v_new_message_count < 10 THEN/);
  });

  it("caps successful runs at one per user per calendar day, but never counts a failed run toward that cap", () => {
    assert.match(
      sql,
      /FROM public\.memory_v3_lifecycle_shadow_runs\s*\n\s*WHERE user_id = p_user_id AND status = 'succeeded'\s*\n\s*AND created_at >= pg_catalog\.date_trunc\('day', pg_catalog\.now\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC';/,
    );
    assert.match(sql, /IF v_daily_success_count >= 1 THEN/);
  });

  it("does not resurrect the old unscoped v_daily_count cap migration 069 accidentally restored", () => {
    assert.equal(sql.includes("v_daily_count"), false);
  });

  it("keeps everything else migrations 073-076 added: topic, the link-pointer fields, the exception handler, and the best-effort log guard", () => {
    assert.match(sql, /'alternative', i\.alternative, 'topic', i\.topic,/);
    assert.match(sql, /'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key,/);
    assert.equal((sql.match(/EXCEPTION WHEN OTHERS THEN/g) ?? []).length, 2);
    assert.match(sql, /NULL; -- logging is best-effort/);
  });

  it("keeps the function signature identical to migration 074's", () => {
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\(\s*p_user_id uuid, p_conversation_id uuid, p_pipeline_version text,\s*p_extractor_version text, p_reconciler_version text, p_model text, p_input_hash text,\s*p_source_last_message_id uuid, p_source_last_created_at timestamptz,\s*p_message_count integer, p_user_message_count integer\s*\)/,
    );
  });
});
