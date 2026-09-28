import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migration = await readFile(
  new URL(
    "../../../migrations/20260928190000_058_legacy_memory_compatibility.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("legacy memory compatibility migration", () => {
  it("defaults every existing and future profile to Memory V3 only", () => {
    assert.match(
      migration,
      /legacy_memory_compat_enabled boolean NOT NULL DEFAULT false/iu,
    );
    assert.match(
      migration,
      /UPDATE public\.profiles\s+SET legacy_memory_compat_enabled = false/iu,
    );
  });

  it("enables compatibility for one stable Pristomania profile id only", () => {
    assert.match(
      migration,
      /ad52b415-875a-45e9-9f6b-be4d25a2c0e0/iu,
    );
    assert.doesNotMatch(migration, /@/u);
    assert.match(
      migration,
      /WHERE id = 'ad52b415-875a-45e9-9f6b-be4d25a2c0e0'::uuid/iu,
    );
  });
});
