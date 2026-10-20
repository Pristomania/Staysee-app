import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "..", "migrations", "20261020220000_082_message_length_events.sql"), "utf8");

describe("message_length_events migration", () => {
  it("keeps only the kind, the length and the time, never the text", () => {
    const table = sql.slice(sql.indexOf("CREATE TABLE public.message_length_events"), sql.indexOf(");", sql.indexOf("CREATE TABLE")));
    for (const column of ["user_id", "kind", "char_count", "created_at"]) assert.match(table, new RegExp(column));
    assert.doesNotMatch(table, /content|text_body|message_id|conversation_id/);
    assert.match(sql, /CHECK \(kind IN \('long_message', 'over_limit'\)\)/);
  });

  it("is for the service role only: RLS on, no policy, no privileges for public roles", () => {
    assert.match(sql, /ALTER TABLE public\.message_length_events ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.message_length_events FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT SELECT, INSERT, DELETE ON TABLE public\.message_length_events TO service_role;/);
    assert.doesNotMatch(sql, /CREATE POLICY/i);
  });

  it("lets only a signed-in person report going over the limit, with a count that really is over it", () => {
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_over_limit_hit\(integer\) TO authenticated;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_over_limit_hit\(integer\) FROM PUBLIC, anon;/);
    assert.match(sql, /p_char_count <= 10000/);
    assert.match(sql, /v_user uuid := auth\.uid\(\)/);
  });

  it("limits a person to one report per ten seconds", () => {
    assert.match(sql, /make_interval\(secs => 10\)/);
  });

  it("gives the report to the service role only", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.long_message_stats\(integer\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.long_message_stats\(integer\) TO service_role;/);
  });
});
