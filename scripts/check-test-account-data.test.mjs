import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DATA_TABLES, KEPT_TABLES, SQL_ONLY_TABLES, freshHours, isFreshAccount, maskEmail, rangeTotal, summarize } from "./check-test-account-data.mjs";

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
    assert.ok(source.indexOf("isFreshAccount(account.created_at,") < source.indexOf("await report("), "the freshness check comes before anything is read");
    assert.match(source, /STAYSEE_ALLOW_PROD_TESTS/, "production checks must be allowed explicitly");
  });

  it("can be told on purpose to look at a test account up to 72 hours old, never further", () => {
    assert.equal(freshHours(undefined), 24, "by default a day");
    assert.equal(freshHours(""), 24);
    assert.equal(freshHours("48"), 48);
    assert.equal(freshHours("72"), 72);
    assert.throws(() => freshHours("73"), /72/, "more than three days is refused");
    assert.throws(() => freshHours("0"));
    assert.throws(() => freshHours("-5"));
    assert.throws(() => freshHours("many"));
    assert.throws(() => freshHours("24.5"));
    const now = new Date("2026-11-03T20:30:00Z");
    assert.equal(isFreshAccount("2026-11-02T19:42:31Z", now), false, "a day and a bit: refused by default");
    assert.equal(isFreshAccount("2026-11-02T19:42:31Z", now, 48), true, "allowed with the explicit window");
    assert.equal(isFreshAccount("2026-10-30T19:00:00Z", now, 72), false, "four days old stays refused even with the largest window");
    assert.match(source, /STAYSEE_CHECK_MAX_AGE_HOURS/, "the window comes from an explicit variable");
    assert.ok(source.indexOf("freshHours(process.env") < source.indexOf("isFreshAccount(account.created_at"), "the window is read before the check");
  });

  it("asks only for columns the production profiles table has, and says so when a read fails", () => {
    // 03.11.2026: the profile read asked for onboarding_completed, which production does not have, so every run printed
    // "profile: no row" and the room-deletion dates were never seen.
    assert.doesNotMatch(source, /onboarding_completed/, "no column that production lacks");
    assert.match(source, /room_deletion_requested_at,room_purge_after/, "the deletion dates are read");
    assert.match(source, /query failed/, "a failed read is reported, not turned into an empty answer");
    assert.match(source, /UNREADABLE/, "a count that could not be read is called out, not shown as 0");
    assert.match(source, /process\.exitCode = 1/, "and the run fails");
    // memory_v3_stale_alerts has all access revoked, even for the service key: it can only be counted with SQL.
    assert.ok(SQL_ONLY_TABLES.includes("memory_v3_stale_alerts"), "the table nobody can read through the API is named");
    for (const table of SQL_ONLY_TABLES) assert.ok(DATA_TABLES.includes(table), `${table} is still content that must disappear`);
    assert.match(source, /count it with SQL/, "the script prints the SQL to run for it");
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
