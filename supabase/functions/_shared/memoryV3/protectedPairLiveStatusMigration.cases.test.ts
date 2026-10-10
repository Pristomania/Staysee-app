import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261010130000_075_memory_v3_protected_pair_live_status.sql"),
  "utf8",
);

// Migration 073's protected-pair join selected new_item purely by
// "replaces_memory_key IS NOT NULL", with no status filter. A freshly
// created recurrence/hypothesis sits in "candidate" status until confirmed --
// unlike the plain top-12 branch, the pair branch could surface a
// not-yet-confirmed new end, which the TypeScript read-store's isLinked
// exception does not accept (it only allows corrected/stale/rejected for the
// closed old end, never "candidate" for the new end), throwing and dropping
// ALL memory context for the account. This migration restricts new_item to
// the same "live" statuses the plain branch already requires.
const LIVE_STATUS_CLAUSE =
  /\(new_item\.kind = 'event' AND new_item\.status = 'active'\)\s*\n\s*OR \(new_item\.kind = 'recurrence' AND new_item\.status = 'active'\)\s*\n\s*OR \(new_item\.kind = 'hypothesis' AND new_item\.status = 'supported'\)/;

describe("Memory V3 protected-pair live-status migration", () => {
  it("restricts load_memory_v3_dialogue_read_context's protected pair to a live-status new end", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context"),
    );
    assert.match(body, LIVE_STATUS_CLAUSE);
    assert.match(body, /new_item\.replaces_memory_key IS NOT NULL/);
  });

  it("restricts load_memory_v3_lifecycle_read_context's protected pair to a live-status new end", () => {
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_read_context"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_read_context"),
    );
    assert.match(body, LIVE_STATUS_CLAUSE);
    assert.match(body, /new_item\.replaces_memory_key IS NOT NULL/);
  });

  it("does not touch the plain top-12 branch or the sensitivity condition", () => {
    assert.match(sql, /ORDER BY i\.updated_at DESC, i\.memory_key COLLATE "C"\s*\n\s*LIMIT 12/);
    assert.match(sql, /new_item\.sensitivity = 'sensitive' OR old_item\.sensitivity = 'sensitive'/);
    assert.match(sql, /LIMIT 5/);
  });
});
