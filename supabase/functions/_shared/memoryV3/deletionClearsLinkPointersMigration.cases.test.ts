import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261010140000_076_memory_v3_deletion_clears_link_pointers.sql"),
  "utf8",
);

// The contract's cross-item consistency check (added earlier in this branch)
// fails the WHOLE state whenever a stored item's replacesMemoryKey/
// replacedByMemoryKey points at a memory_key that no longer exists. Every
// pre-existing deletion path (single-item viewer delete, the per-message
// delete trigger, and the lifecycle per-conversation delete trigger) can
// remove one half of a linked pair without clearing the surviving half's
// pointer -- permanently breaking every future write to that pipeline. This
// migration makes each path null out any dangling pointer it would create,
// in the same statement, before the row is actually removed.

function body(functionName: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  assert.notEqual(start, -1, `${functionName} not found`);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
  return next === -1 ? sql.slice(start) : sql.slice(start, next);
}

describe("Memory V3 deletion clears dangling link pointers migration", () => {
  it("delete_memory_v3_dialogue_item nulls both pointer directions before deleting the row", () => {
    const fn = body("delete_memory_v3_dialogue_item");
    assert.match(fn, /SET replaces_memory_key = NULL\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND replaces_memory_key = p_memory_key/);
    assert.match(fn, /SET replaced_by_memory_key = NULL\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND replaced_by_memory_key = p_memory_key/);
    assert.match(fn, /DELETE FROM public\.memory_v3_dialogue_items\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND memory_key = p_memory_key/);
  });

  it("delete_memory_v3_lifecycle_item nulls both pointer directions before deleting the row", () => {
    const fn = body("delete_memory_v3_lifecycle_item");
    assert.match(fn, /SET replaces_memory_key = NULL\s*\n\s*WHERE user_id = p_user_id AND replaces_memory_key = p_memory_key/);
    assert.match(fn, /SET replaced_by_memory_key = NULL\s*\n\s*WHERE user_id = p_user_id AND replaced_by_memory_key = p_memory_key/);
    assert.match(fn, /DELETE FROM public\.memory_v3_lifecycle_shadow_items\s*\n\s*WHERE user_id = p_user_id AND memory_key = p_memory_key/);
  });

  it("delete_memory_v3_dialogue_items_for_message clears dangling pointers scoped to OLD.conversation_id", () => {
    const fn = body("delete_memory_v3_dialogue_items_for_message");
    assert.match(fn, /SET replaces_memory_key = NULL/);
    assert.match(fn, /SET replaced_by_memory_key = NULL/);
    assert.match(fn, /u\.conversation_id = OLD\.conversation_id/);
    assert.match(fn, /e\.source_message_id = OLD\.id/);
  });

  it("delete_memory_v3_lifecycle_items_for_message clears dangling pointers scoped to the same user", () => {
    const fn = body("delete_memory_v3_lifecycle_items_for_message");
    assert.match(fn, /SET replaces_memory_key = NULL/);
    assert.match(fn, /SET replaced_by_memory_key = NULL/);
    assert.match(fn, /i\.user_id = u\.user_id/);
    assert.match(fn, /e\.source_message_id = OLD\.id/);
  });

  it("delete_memory_v3_lifecycle_items_for_conversation clears dangling pointers scoped to the same user", () => {
    const fn = body("delete_memory_v3_lifecycle_items_for_conversation");
    assert.match(fn, /SET replaces_memory_key = NULL/);
    assert.match(fn, /SET replaced_by_memory_key = NULL/);
    assert.match(fn, /i\.user_id = u\.user_id/);
    assert.match(fn, /e\.conversation_id = OLD\.id/);
  });

  it("does not touch the dialogue conversation-delete trigger (atomic head cascade, no dangling-pointer risk)", () => {
    assert.equal(
      /CREATE OR REPLACE FUNCTION public\.delete_memory_v3_dialogue_items_for_conversation\(/.test(sql),
      false,
    );
  });
});
