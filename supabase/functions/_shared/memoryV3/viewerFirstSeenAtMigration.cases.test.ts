import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261001210000_061_memory_v3_viewer_first_seen_at.sql"),
  "utf8",
);

describe("Memory V3 viewer firstSeenAt migration", () => {
  it("adds firstSeenAt to load_memory_v3_lifecycle_viewer_items's returned JSON", () => {
    assert.match(sql.slice(0, sql.indexOf("load_memory_v3_dialogue_viewer_items")), /'firstSeenAt', i\.first_seen_at/);
  });

  it("adds firstSeenAt to load_memory_v3_dialogue_viewer_items's returned JSON", () => {
    const dialogueBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items"));
    assert.match(dialogueBody, /'firstSeenAt', i\.first_seen_at/);
  });

  it("keeps updatedAt from the previous migration alongside the new field", () => {
    assert.equal((sql.match(/'updatedAt', i\.updated_at/g) ?? []).length, 2);
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
