import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261001200000_060_memory_v3_viewer_updated_at.sql"),
  "utf8",
);

describe("Memory V3 viewer updatedAt migration", () => {
  it("adds updatedAt to load_memory_v3_lifecycle_viewer_items's returned JSON", () => {
    assert.match(sql.slice(0, sql.indexOf("load_memory_v3_dialogue_viewer_items")), /'updatedAt', i\.updated_at/);
  });

  it("adds updatedAt to load_memory_v3_dialogue_viewer_items's returned JSON", () => {
    const dialogueBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items"));
    assert.match(dialogueBody, /'updatedAt', i\.updated_at/);
  });

  it("still restricts EXECUTE to service_role only, matching the original", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.load_memory_v3_lifecycle_viewer_items\(uuid\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_lifecycle_viewer_items\(uuid\) TO service_role;/);
  });

  it("never touches the hot-path read context RPCs", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_read_context/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
