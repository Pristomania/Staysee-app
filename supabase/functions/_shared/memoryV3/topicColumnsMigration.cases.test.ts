import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20260924090000_044_memory_v3_topic_columns.sql"),
  "utf8",
);

describe("Memory V3 topic columns migration", () => {
  it("adds a nullable topic column to the lifecycle items table with the life_context/communication/preference enum", () => {
    assert.match(
      sql,
      /ALTER TABLE public\.memory_v3_lifecycle_shadow_items\s+ADD COLUMN IF NOT EXISTS topic text NULL\s+CHECK \(topic IS NULL OR topic IN \('life_context', 'communication', 'preference'\)\)/,
    );
  });

  it("adds a nullable topic column to the dialogue items table with the person/fact/preference enum", () => {
    assert.match(
      sql,
      /ALTER TABLE public\.memory_v3_dialogue_items\s+ADD COLUMN IF NOT EXISTS topic text NULL\s+CHECK \(topic IS NULL OR topic IN \('person', 'fact', 'preference'\)\)/,
    );
  });

  it("never introduces a NOT NULL constraint on either topic column", () => {
    assert.equal(/topic text NOT NULL/.test(sql), false);
  });
});
