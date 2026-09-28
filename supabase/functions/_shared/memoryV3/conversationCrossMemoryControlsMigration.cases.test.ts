import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migration = await readFile(
  new URL(
    "../../../migrations/20260928120000_057_conversation_cross_memory_controls.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("conversation cross-memory controls migration", () => {
  it("adds and backfills the conversation setting from the profile", () => {
    assert.match(
      migration,
      /ADD COLUMN IF NOT EXISTS cross_memory_enabled boolean/iu,
    );
    assert.match(
      migration,
      /UPDATE public\.conversations AS c[\s\S]*FROM public\.profiles AS p/iu,
    );
    assert.match(migration, /COALESCE\(p\.cross_memory_enabled, true\)/iu);
    assert.match(migration, /ALTER COLUMN cross_memory_enabled SET NOT NULL/iu);
  });

  it("inherits the profile default for new conversations", () => {
    assert.match(migration, /BEFORE INSERT ON public\.conversations/iu);
    assert.match(migration, /NEW\.cross_memory_enabled/iu);
    assert.match(
      migration,
      /SELECT COALESCE\(p\.cross_memory_enabled, true\)[\s\S]*FROM public\.profiles AS p/iu,
    );
  });

  it("provides authenticated bulk and one-conversation mutations", () => {
    assert.match(
      migration,
      /set_cross_memory_enabled_for_all\(\s*p_enabled boolean\s*\)/iu,
    );
    assert.match(
      migration,
      /UPDATE public\.profiles[\s\S]*UPDATE public\.conversations/iu,
    );
    assert.match(
      migration,
      /set_conversation_cross_memory_enabled\(\s*p_conversation_id uuid,\s*p_enabled boolean\s*\)/iu,
    );
    assert.match(migration, /user_id = v_user_id/iu);
    assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/iu);
    assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC, anon/iu);
  });

  it("keeps ownership and null validation inside both RPCs", () => {
    assert.match(migration, /v_user_id uuid := auth\.uid\(\)/iu);
    assert.match(migration, /IF v_user_id IS NULL/iu);
    assert.match(migration, /IF p_enabled IS NULL/iu);
    assert.match(migration, /GET DIAGNOSTICS v_rows = ROW_COUNT/iu);
    assert.match(migration, /IF v_rows <> 1/iu);
  });
});
