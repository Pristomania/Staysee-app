/**
 * How admin-api is put together: the order of its checks and what it may touch. Reads the source (the function has runtime npm: imports
 * that plain Node cannot load); the behaviour of the checks themselves is covered by adminGuard.cases.test.ts and, against a real
 * database, by tests/db/adminPanel.dbtest.ts.
 * Run: npx tsx --test supabase/functions/_shared/adminApiWiring.cases.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../admin-api/index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const config = readFileSync(new URL("../../config.toml", import.meta.url), "utf8");

const at = (needle: string | RegExp): number => {
  const index = typeof needle === "string" ? source.indexOf(needle) : source.search(needle);
  assert.ok(index >= 0, `expected to find ${String(needle)}`);
  return index;
};

describe("admin-api wiring", () => {
  it("the token is verified by Auth before anything is asked of the database", () => {
    assert.ok(at("auth.getUser(") < at(".rpc("), "getUser must come before the first rpc");
  });

  it("the admin flag is read, and the decision made, before an action is dispatched", () => {
    assert.ok(at('"admin_is_admin"') < at("decideAdminAccess("), "the admin flag is read before the decision");
    assert.ok(at("decideAdminAccess(") < at("adminRpcCall("), "the decision comes before the dispatch");
    assert.match(source, /if \(!decision\.ok\)/);
  });

  it("the request is parsed and checked before the token is even looked at (a malformed body costs nothing)", () => {
    assert.ok(at("parseAdminRequest(") < at("auth.getUser("));
  });

  it("the subject of the verified token and the subject in the claims must be the same person", () => {
    assert.match(source, /claims\??\.sub\s*!==\s*\w+\.user\.id/);
  });

  it("nothing reads a table: every action goes through an admin_* SQL function", () => {
    assert.doesNotMatch(source, /\.from\(/);
    assert.match(source, /service\.rpc\(\s*call\.name/);
  });

  it("the admin id given to the database comes from the verified decision, never from the request", () => {
    assert.match(source, /adminRpcCall\(\s*parsed\.action\s*,\s*parsed\.params\s*,\s*decision\.adminId\s*\)/);
    assert.doesNotMatch(source, /adminId\s*[:=]\s*(body|params|raw|parsed)/);
  });

  it("the service key is used for the calls, the public key only to ask Auth who the token belongs to", () => {
    assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(source, /SUPABASE_ANON_KEY/);
    assert.match(source, /createClient\(\s*supabaseUrl\s*,\s*anonKey/);
    assert.match(source, /createClient\(\s*supabaseUrl\s*,\s*serviceKey/);
  });

  it("nothing is logged that could hold a token or an e-mail", () => {
    for (const line of source.split("\n").filter((l) => /console\./.test(l))) {
      assert.doesNotMatch(line, /token|email|authorization|password/i, `a log line must not name secrets: ${line.trim()}`);
    }
  });

  it("only POST and the CORS preflight are answered, the refusals are plain reason codes", () => {
    assert.match(source, /req\.method\s*===\s*"OPTIONS"/);
    assert.match(source, /req\.method\s*!==\s*"POST"/);
    assert.match(source, /"method_not_allowed"/);
    assert.match(source, /"bad_request"/);
  });

  it("the gateway checks the login token as well: verify_jwt is on for admin-api", () => {
    const block = /\[functions\.admin-api\]\s*([^[]*)/.exec(config)?.[1] ?? "";
    assert.match(block, /verify_jwt\s*=\s*true/);
  });
});
