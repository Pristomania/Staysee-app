import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "migrations", "20261020200000_081_message_model_summaries.sql"),
  "utf8",
);

describe("message_model_summaries migration", () => {
  it("keeps one short version per message and removes it with the message and with the account", () => {
    assert.match(sql, /message_id uuid PRIMARY KEY REFERENCES public\.messages\(id\) ON DELETE CASCADE/);
    assert.match(sql, /user_id uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
  });

  it("limits the short version to 1 to 1,500 characters", () => {
    assert.match(sql, /CHECK \(pg_catalog\.char_length\(summary\) BETWEEN 1 AND 1500\)/);
  });

  it("is for the service role only: RLS on, no policy, no privileges for public roles", () => {
    assert.match(sql, /ALTER TABLE public\.message_model_summaries ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.message_model_summaries FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.message_model_summaries TO service_role;/);
    assert.doesNotMatch(sql, /CREATE POLICY/i);
  });
});
