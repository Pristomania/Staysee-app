import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261001220000_062_memory_v3_export.sql"),
  "utf8",
);

function bodyOf(fnName: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
  assert.notEqual(start, -1, `migration must define ${fnName}`);
  const rest = sql.slice(start + 1);
  const nextStart = rest.indexOf("CREATE OR REPLACE FUNCTION public.");
  return nextStart === -1 ? sql.slice(start) : sql.slice(start, start + 1 + nextStart);
}

describe("Memory V3 export migration", () => {
  it("adds alternative to load_memory_v3_lifecycle_viewer_items's returned JSON", () => {
    assert.match(bodyOf("load_memory_v3_lifecycle_viewer_items"), /'alternative', i\.alternative/);
  });

  it("adds alternative to load_memory_v3_dialogue_viewer_items's returned JSON", () => {
    assert.match(bodyOf("load_memory_v3_dialogue_viewer_items"), /'alternative', i\.alternative/);
  });

  it("keeps firstSeenAt and updatedAt from prior migrations on all three functions", () => {
    assert.equal((sql.match(/'firstSeenAt', i\.first_seen_at/g) ?? []).length, 3);
    assert.equal((sql.match(/'updatedAt', i\.updated_at/g) ?? []).length, 3);
  });

  it("adds status to all three functions' returned JSON, so the export can tell a rejected hypothesis from a supported one", () => {
    assert.equal((sql.match(/'status', i\.status/g) ?? []).length, 3);
  });

  it("adds topic to all three functions' returned JSON", () => {
    assert.equal((sql.match(/'topic', i\.topic/g) ?? []).length, 3);
  });

  it("defines load_memory_v3_dialogue_viewer_items_all with alternative, status, conversationId, and no conversation filter", () => {
    const body = bodyOf("load_memory_v3_dialogue_viewer_items_all");
    assert.match(body, /'alternative', i\.alternative/);
    assert.match(body, /'status', i\.status/);
    assert.match(body, /'conversationId', i\.conversation_id/);
    assert.doesNotMatch(body, /p_conversation_id/);
    assert.doesNotMatch(body, /conversation_id = /);
    assert.match(body, /WHERE i\.user_id = p_user_id;/);
  });

  it("only the all-conversations RPC returns conversationId -- the other two don't need it", () => {
    assert.equal((sql.match(/'conversationId', i\.conversation_id/g) ?? []).length, 1);
  });

  it("restricts the new function's EXECUTE to service_role only", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.load_memory_v3_dialogue_viewer_items_all\(uuid\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_dialogue_viewer_items_all\(uuid\) TO service_role;/);
  });

  it("never touches the hot-path read context RPCs", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_read_context/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
