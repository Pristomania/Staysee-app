import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260924100000_045_memory_v3_topic_apply_state.sql"),
  "utf8",
);

describe("Memory V3 topic apply-state migration", () => {
  it("recreates apply_memory_v3_lifecycle_shadow_state with topic in the current-items reconstruction", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_memory_v3_lifecycle_shadow_state/);
    assert.match(sql, /'alternative', i\.alternative, 'topic', i\.topic,/);
  });

  it("recreates apply_memory_v3_lifecycle_shadow_state's INSERT with a topic column and source", () => {
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_lifecycle_shadow_items\(\s*user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*alternative, topic, first_seen_at, updated_at, revision\)/,
    );
    assert.match(sql, /item->>'sensitivity', item->>'eventTimeStart', item->>'eventTimeEnd', item->>'alternative',\s*item->>'topic',/);
  });

  it("recreates apply_memory_v3_dialogue_state with topic in the current-items reconstruction and INSERT", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_memory_v3_dialogue_state/);
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_dialogue_items\(\s*user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*alternative, topic, first_seen_at, updated_at, revision\)/,
    );
  });

  it("does not touch the evidence tables or any other function in these two migrations", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.reserve_memory_v3/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3/.test(sql), false);
  });
});
