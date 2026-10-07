import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "migrations", "20261007090000_070_layer4_memory_and_context_catchup.sql"),
  "utf8",
);

describe("Memory layer-4 catch-up migration", () => {
  it("adds conversations.emotional_tone guarded by IF NOT EXISTS, matching migration 005's own text", () => {
    assert.match(
      sql,
      /WHERE table_name = 'conversations' AND column_name = 'emotional_tone'[\s\S]{0,40}ALTER TABLE conversations ADD COLUMN emotional_tone text;/,
    );
  });

  it("adds all three missing user_memory columns with migration 005's exact constraints", () => {
    assert.match(
      sql,
      /ALTER TABLE user_memory ADD COLUMN importance smallint NOT NULL DEFAULT 3\s*CONSTRAINT importance_range CHECK \(importance BETWEEN 1 AND 5\);/,
    );
    assert.match(sql, /ALTER TABLE user_memory ADD COLUMN last_used_at timestamptz;/);
    assert.match(sql, /ALTER TABLE user_memory ADD COLUMN updated_at timestamptz DEFAULT now\(\);/);
  });

  it("recreates the importance index idempotently", () => {
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS idx_user_memory_user_importance\s*ON user_memory \(user_id, importance DESC\);/,
    );
  });

  it("never re-adds conversations.summary or summary_updated_at, which are already live", () => {
    assert.equal(/ADD COLUMN summary text/.test(sql), false);
    assert.equal(/ADD COLUMN summary_updated_at timestamptz/.test(sql), false);
  });

  it("guards every ALTER TABLE with its own IF NOT EXISTS column check, never touching an existing column", () => {
    const alters = sql.match(/ALTER TABLE \w+ ADD COLUMN \w+/g) ?? [];
    assert.equal(alters.length, 4);
    for (const alter of alters) {
      const index = sql.indexOf(alter);
      const before = sql.slice(Math.max(0, index - 400), index);
      assert.match(before, /IF NOT EXISTS \(\s*SELECT 1 FROM information_schema\.columns/);
    }
  });
});
