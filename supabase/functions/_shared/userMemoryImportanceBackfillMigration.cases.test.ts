import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "migrations", "20261007110000_072_user_memory_importance_backfill.sql"),
  "utf8",
);

describe("user_memory importance backfill migration", () => {
  it("maps every recognized memory_type to the exact same score userLifeMemory.ts's TYPE_IMPORTANCE uses", () => {
    const expected: Record<string, number> = {
      communication: 5,
      preference: 5,
      life_context: 4,
      insight: 4,
      theme: 3,
      emotion: 3,
    };
    for (const [type, score] of Object.entries(expected)) {
      assert.match(
        sql,
        new RegExp(`WHEN '${type}' THEN ${score}\\b`),
        `expected ${type} to map to ${score}`,
      );
    }
  });

  it("only updates user_memory, and only the recognized memory_type values", () => {
    assert.match(sql, /UPDATE public\.user_memory/);
    assert.match(
      sql,
      /WHERE memory_type IN \('communication', 'preference', 'life_context', 'insight', 'theme', 'emotion'\);/,
    );
  });

  it("leaves importance untouched (ELSE importance) for any type outside the known set", () => {
    assert.match(sql, /ELSE importance\s*\n\s*END/);
  });

  it("never touches any other table or creates/drops anything", () => {
    assert.equal(/CREATE |DROP |ALTER TABLE/i.test(sql), false);
    assert.equal(/UPDATE public\.(?!user_memory)/i.test(sql), false);
  });
});
