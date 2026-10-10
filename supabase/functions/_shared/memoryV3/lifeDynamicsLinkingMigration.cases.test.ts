import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261010100000_073_memory_v3_life_dynamics_linking.sql"),
  "utf8",
);

describe("Memory V3 life-dynamics linking migration", () => {
  it("adds replaces_memory_key and replaced_by_memory_key to both item tables, nullable, no FK", () => {
    assert.match(sql, /ALTER TABLE public\.memory_v3_dialogue_items\s+ADD COLUMN replaces_memory_key text,\s*\n\s*ADD COLUMN replaced_by_memory_key text;/);
    assert.match(sql, /ALTER TABLE public\.memory_v3_lifecycle_shadow_items\s+ADD COLUMN replaces_memory_key text,\s*\n\s*ADD COLUMN replaced_by_memory_key text;/);
  });

  it("round-trips both new fields through apply_memory_v3_dialogue_state's reconstruction and insert", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state"));
    assert.match(body, /'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key/);
    assert.match(body, /INSERT INTO public\.memory_v3_dialogue_items\(\s*\n\s*user_id, conversation_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*\n\s*alternative, topic, first_seen_at, updated_at, revision, replaces_memory_key, replaced_by_memory_key\)/);
    assert.match(body, /item->>'replacesMemoryKey', item->>'replacedByMemoryKey'/);
  });

  it("round-trips both new fields through apply_memory_v3_lifecycle_shadow_state's reconstruction and insert", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_memory_v3_lifecycle_shadow_state"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.apply_memory_v3_dialogue_state"),
    );
    assert.match(body, /'replacesMemoryKey', i\.replaces_memory_key, 'replacedByMemoryKey', i\.replaced_by_memory_key/);
    assert.match(body, /INSERT INTO public\.memory_v3_lifecycle_shadow_items\(\s*\n\s*user_id, memory_key, kind, claim, status, sensitivity, event_time_start, event_time_end,\s*\n\s*alternative, topic, first_seen_at, updated_at, revision, replaces_memory_key, replaced_by_memory_key\)/);
    assert.match(body, /item->>'replacesMemoryKey', item->>'replacedByMemoryKey'/);
  });

  it("load_memory_v3_dialogue_read_context still LIMITs the plain recency window to 12 and adds a 5-pair protected selection", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context"));
    assert.match(body, /LIMIT 12/);
    assert.match(body, /LIMIT 5/);
    assert.match(body, /'replacesMemoryKey', selected\.replaces_memory_key,[\s\S]*?'replacedByMemoryKey', selected\.replaced_by_memory_key/);
  });

  it("load_memory_v3_lifecycle_read_context still LIMITs the plain recency window to 12 and adds a 5-pair protected selection", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_read_context"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context"),
    );
    assert.match(body, /LIMIT 12/);
    assert.match(body, /LIMIT 5/);
  });

  it("never touches the viewer or export RPCs", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_viewer_items/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_viewer_items_all/.test(sql), false);
  });
});
