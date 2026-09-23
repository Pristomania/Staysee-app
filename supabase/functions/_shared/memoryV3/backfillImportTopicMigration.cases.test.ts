import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260924140000_049_memory_v3_backfill_import_topic.sql"),
  "utf8",
);

describe("Memory V3 backfill-import topic migration", () => {
  it("recreates the backfill-import RPC", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.import_memory_v3_lifecycle_backfill_state/);
  });

  it("widens the item-shape key count from twelve to thirteen and admits topic", () => {
    assert.match(sql, /jsonb_object_keys\(item\)\) <> 13/);
    assert.equal(/jsonb_object_keys\(item\)\) <> 12/.test(sql), false);
  });

  it("adds topic right after alternative in the allowed item-key array, matching the production field order", () => {
    assert.match(
      sql,
      /'eventTimeEnd', 'alternative', 'topic', 'firstSeenAt', 'updatedAt', 'revision', 'evidence'/,
    );
  });

  it("validates topic as null or one of the three lifecycle enum members", () => {
    assert.match(
      sql,
      /item->'topic' = 'null'::jsonb\s*\n\s*OR \(pg_catalog\.jsonb_typeof\(item->'topic'\) = 'string'\s*\n\s*AND item->>'topic' IN \('life_context', 'communication', 'preference'\)\)/,
    );
  });

  it("adds topic to the item INSERT's column list and value list", () => {
    assert.match(
      sql,
      /INSERT INTO public\.memory_v3_lifecycle_shadow_items\(\s*\n\s*user_id, memory_key, kind, claim, status, sensitivity, event_time_start,\s*\n\s*event_time_end, alternative, topic, first_seen_at, updated_at, revision\s*\n\s*\)/,
    );
    assert.match(
      sql,
      /item->>'eventTimeEnd', item->>'alternative', item->>'topic',/,
    );
  });

  it("leaves the state-root shape (five keys, no topic) and the once-only import guard unchanged", () => {
    assert.match(sql, /jsonb_object_keys\(p_state\)\) <> 5/);
    assert.match(sql, /'schemaVersion', 'userId', 'stateRevision', 'nextMemoryOrdinal', 'items'/);
    assert.match(sql, /RAISE EXCEPTION 'lifecycle backfill import already initialized';/);
  });

  it("leaves evidence validation and the user-message provenance check unchanged", () => {
    assert.match(sql, /jsonb_object_keys\(evidence\)\) <> 7/);
    assert.match(sql, /RAISE EXCEPTION 'invalid lifecycle backfill evidence' USING ERRCODE = '42501';/);
  });

  it("grants EXECUTE on the function to service_role only", () => {
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.import_memory_v3_lifecycle_backfill_state\(\s*\n\s*uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb\s*\n\s*\) FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.import_memory_v3_lifecycle_backfill_state\(\s*\n\s*uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb\s*\n\s*\) TO service_role;/,
    );
  });

  it("does not touch any other function or the backfill-imports table definition", () => {
    assert.equal(/CREATE TABLE/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.apply_memory_v3/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.reserve_memory_v3/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3/.test(sql), false);
  });
});
