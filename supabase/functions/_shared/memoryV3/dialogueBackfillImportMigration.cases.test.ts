import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260924150000_050_memory_v3_dialogue_backfill_import.sql"),
  "utf8",
);

describe("Memory V3 dialogue backfill import migration", () => {
  it("creates the audit table with a per-conversation uniqueness constraint, not per-user", () => {
    assert.match(sql, /CREATE TABLE public\.memory_v3_dialogue_backfill_imports/);
    assert.match(sql, /UNIQUE \(user_id, conversation_id\)/);
    assert.equal(/artifact_digest text NOT NULL UNIQUE.*\n.*user_id uuid NOT NULL UNIQUE/s.test(sql), false);
  });

  it("requires exactly 13 item keys, including topic with the dialogue enum", () => {
    assert.match(sql, /jsonb_object_keys\(item\)\) <> 13/);
    assert.match(sql, /'memoryKey', 'kind', 'claim', 'status', 'sensitivity', 'eventTimeStart',\s*\n\s*'eventTimeEnd', 'alternative', 'topic', 'firstSeenAt', 'updatedAt', 'revision', 'evidence'/);
    assert.match(sql, /item->>'topic' IN \('person', 'fact', 'preference'\)/);
  });

  it("checks dialogue-scope version constants, not lifecycle ones", () => {
    assert.match(sql, /p_profile_id IS DISTINCT FROM 'memory-v3-dialogue-history-backfill-v1'/);
    assert.match(sql, /p_pipeline_version IS DISTINCT FROM 'memory-v3-dialogue-v1'/);
    assert.match(sql, /p_reconciler_version IS DISTINCT FROM 'memory-v3-dialogue-reconciler-v1'/);
    assert.equal(/lifecycle/i.test(sql.replace(/-- .*/g, "")), false);
  });

  it("scopes the head lookup, item count, and delete by both user_id and conversation_id", () => {
    assert.match(sql, /FROM public\.memory_v3_dialogue_heads\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id\s*\n\s*FOR UPDATE/);
    assert.match(sql, /DELETE FROM public\.memory_v3_dialogue_items\s*\n\s*WHERE user_id = p_user_id AND conversation_id = p_conversation_id/);
  });

  it("scopes evidence rows' conversationId to the target conversation, not any conversation the user owns", () => {
    assert.match(sql, /evidence->>'conversationId' IS DISTINCT FROM p_conversation_id::text/);
  });

  it("gates re-import on a revision-match race check, not on emptiness", () => {
    assert.match(sql, /v_head\.state_revision <> p_expected_state_revision/);
    assert.equal(/state_revision <> 0/.test(sql), false);
    assert.equal(/v_existing_item_count/.test(sql), false);
  });

  it("grants EXECUTE to service_role only", () => {
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.import_memory_v3_dialogue_backfill_state\(/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.import_memory_v3_dialogue_backfill_state\(\s*\n\s*uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb\s*\n\s*\) FROM PUBLIC, anon, authenticated;/);
  });
});
