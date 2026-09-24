import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "migrations",
    "20260924160000_051_memory_v3_dialogue_backfill_import_conversation_scope.sql",
  ),
  "utf8",
);

describe("Memory V3 dialogue backfill import conversation-scope migration", () => {
  it("widens the primary key to (import_id, conversation_id) and drops the old single-column one", () => {
    assert.match(
      sql,
      /DROP CONSTRAINT IF EXISTS memory_v3_dialogue_backfill_imports_pkey/,
    );
    assert.match(
      sql,
      /ADD CONSTRAINT memory_v3_dialogue_backfill_imports_pkey PRIMARY KEY \(import_id, conversation_id\)/,
    );
    assert.equal(/PRIMARY KEY \(import_id\)/.test(sql), false);
  });

  it("widens the artifact_digest uniqueness to (artifact_digest, conversation_id) and drops the old single-column one", () => {
    assert.match(
      sql,
      /DROP CONSTRAINT IF EXISTS memory_v3_dialogue_backfill_imports_artifact_digest_key/,
    );
    assert.match(
      sql,
      /ADD CONSTRAINT memory_v3_dialogue_backfill_imports_artifact_digest_key UNIQUE \(artifact_digest, conversation_id\)/,
    );
    assert.equal(/UNIQUE \(artifact_digest\)/.test(sql), false);
  });

  it("scopes the artifact_digest conflict guard to the target conversation, while keeping the user_id/conversation_id guard intact", () => {
    assert.match(
      sql,
      /WHERE artifact_digest = p_artifact_digest AND conversation_id = p_conversation_id/,
    );
    assert.equal(
      /WHERE artifact_digest = p_artifact_digest\s*\n\s*\)/.test(sql),
      false,
    );
    assert.match(
      sql,
      /WHERE user_id = p_user_id AND conversation_id = p_conversation_id\s*\n\s*\)\s*\n\s*OR EXISTS/,
    );
  });

  it("re-defines the function with the same signature via CREATE OR REPLACE and re-grants EXECUTE to service_role only", () => {
    assert.match(
      sql,
      /CREATE OR REPLACE FUNCTION public\.import_memory_v3_dialogue_backfill_state\(/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.import_memory_v3_dialogue_backfill_state\(/,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.import_memory_v3_dialogue_backfill_state\(\s*\n\s*uuid, uuid, uuid, bigint, text, text, timestamptz, text, text, text, text, jsonb\s*\n\s*\) FROM PUBLIC, anon, authenticated;/,
    );
  });
});
