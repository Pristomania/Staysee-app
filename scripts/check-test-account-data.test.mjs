import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DATA_TABLES, KEPT_TABLES, isFreshAccount, maskEmail, rangeTotal, summarize } from "./check-test-account-data.mjs";

const source = readFileSync(new URL("./check-test-account-data.mjs", import.meta.url), "utf8");

describe("the check of a test account's data", () => {
  it("shows the mailbox masked and only counts", () => {
    assert.equal(maskEmail("Nastya.Test@Example.com"), "N***@Example.com");
    assert.doesNotMatch(source, /console\.log\([^)]*\.content/i, "no content is printed");
    assert.doesNotMatch(source, /select=\*&[^`]*`[^;]*\.json\(\)/, "no body of a data table is read, only counts (HEAD)");
    assert.match(source, /method: "HEAD"/, "tables are counted with HEAD requests");
  });

  it("writes nothing: no POST, PUT, PATCH or DELETE", () => {
    assert.doesNotMatch(source, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
    assert.doesNotMatch(source, /\.rpc\(|rpc\//, "no function is called");
  });

  it("looks only at an account made in the last 24 hours, so a real person is never shown", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    assert.equal(isFreshAccount("2026-11-02T19:00:00Z", now), true);
    assert.equal(isFreshAccount("2026-11-01T21:00:00Z", now), true);
    assert.equal(isFreshAccount("2026-11-01T19:59:00Z", now), false, "a day and a minute old");
    assert.equal(isFreshAccount("2026-10-18T15:24:21Z", now), false, "an old account");
    assert.equal(isFreshAccount("2026-11-03T00:00:00Z", now), false, "a date in the future");
    assert.equal(isFreshAccount("not a date", now), false);
    assert.ok(source.indexOf("isFreshAccount(account.created_at)") < source.indexOf("await report("), "the freshness check comes before anything is read");
    assert.match(source, /STAYSEE_ALLOW_PROD_TESTS/, "production checks must be allowed explicitly");
  });

  it("reads the counts from a content-range header", () => {
    assert.equal(rangeTotal("0-0/6"), 6);
    assert.equal(rangeTotal("*/0"), 0);
    assert.equal(rangeTotal(null), null);
    assert.equal(rangeTotal("garbage"), null);
  });

  it("sums only the tables that have something", () => {
    assert.deepEqual(summarize({ a: 0, b: 2, c: 3 }), { rows: 5, tables: ["b 2", "c 3"] });
    assert.deepEqual(summarize({ a: 0 }), { rows: 0, tables: [] });
  });

  it("keeps the plan, the money and the consents apart from the person's content", () => {
    for (const table of ["user_usage_tiers", "message_packs", "user_consents", "ai_usage_logs"]) {
      assert.ok(KEPT_TABLES.includes(table), `${table} is kept`);
      assert.ok(!DATA_TABLES.includes(table), `${table} is not counted as content that must disappear`);
    }
    for (const table of ["conversations", "memory_corrections", "progress_entries", "user_memory", "message_embeddings"]) {
      assert.ok(DATA_TABLES.includes(table), `${table} is content`);
    }
  });

  it("knows every memory table the migrations create, so a new one cannot be forgotten", () => {
    const dir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
    const created = new Set();
    for (const file of readdirSync(dir)) {
      const sql = readFileSync(dir + file, "utf8");
      // Only the tables that hold a person's rows (they carry a user_id); a table of the system's own is not content.
      for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.(memory_v3_[a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
        if (/user_id/.test(match[2])) created.add(match[1]);
      }
    }
    assert.ok(created.size >= 15, `found the memory tables (${created.size})`);
    for (const table of created) assert.ok(DATA_TABLES.includes(table), `${table} is in the list of content tables`);
  });
});
