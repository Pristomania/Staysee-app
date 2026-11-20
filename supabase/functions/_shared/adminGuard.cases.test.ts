/**
 * Who may call admin-api, and what a request may ask for (pure logic, no Supabase, no Deno).
 * Run: npx tsx --test supabase/functions/_shared/adminGuard.cases.test.ts
 *
 * Order of refusals matters: a person who is not an admin always gets 403 not_admin, never a hint that a password would unlock
 * anything (so the panel does not reveal itself). Only an admin can be told "enter the password again".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADMIN_PASSWORD_MAX_AGE_SEC,
  adminRpcCall,
  decideAdminAccess,
  decodeJwtClaims,
  parseAdminRequest,
  passwordAgeSeconds,
  type AdminClaims,
} from "./adminGuard.ts";

const NOW = 1_800_000_000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";

function claims(ageSec: number | null, sub = ADMIN_ID): AdminClaims {
  return { sub, amr: ageSec === null ? [{ method: "otp", timestamp: NOW - 5 }] : [{ method: "password", timestamp: NOW - ageSec }] };
}

function token(payload: unknown): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

describe("decideAdminAccess", () => {
  it("no claims, or claims without a subject, is 401 invalid_token", () => {
    assert.deepEqual(decideAdminAccess({ claims: null, isAdmin: true, nowSec: NOW }), { ok: false, status: 401, reason: "invalid_token" });
    assert.deepEqual(decideAdminAccess({ claims: { amr: [] }, isAdmin: true, nowSec: NOW }), { ok: false, status: 401, reason: "invalid_token" });
  });

  it("a person who is not an admin is 403 not_admin, whatever the password age", () => {
    for (const age of [0, 60, 31 * 60, 9999]) {
      assert.deepEqual(decideAdminAccess({ claims: claims(age, PERSON_ID), isAdmin: false, nowSec: NOW }), { ok: false, status: 403, reason: "not_admin" }, `age ${age}`);
    }
    assert.deepEqual(decideAdminAccess({ claims: claims(null, PERSON_ID), isAdmin: false, nowSec: NOW }), { ok: false, status: 403, reason: "not_admin" });
  });

  it("an admin whose password entry is older than 30 minutes is 401 password_stale", () => {
    assert.equal(ADMIN_PASSWORD_MAX_AGE_SEC, 1800);
    assert.deepEqual(decideAdminAccess({ claims: claims(31 * 60), isAdmin: true, nowSec: NOW }), { ok: false, status: 401, reason: "password_stale" });
  });

  it("an admin with a password entry of 29 minutes (or exactly 30) is let in, as that admin", () => {
    assert.deepEqual(decideAdminAccess({ claims: claims(29 * 60), isAdmin: true, nowSec: NOW }), { ok: true, adminId: ADMIN_ID });
    assert.deepEqual(decideAdminAccess({ claims: claims(30 * 60), isAdmin: true, nowSec: NOW }), { ok: true, adminId: ADMIN_ID });
    assert.deepEqual(decideAdminAccess({ claims: claims(30 * 60 + 1), isAdmin: true, nowSec: NOW }), { ok: false, status: 401, reason: "password_stale" });
  });

  it("an admin whose token has no password method (a link, a code) is 401 password_stale", () => {
    assert.deepEqual(decideAdminAccess({ claims: claims(null), isAdmin: true, nowSec: NOW }), { ok: false, status: 401, reason: "password_stale" });
    assert.deepEqual(decideAdminAccess({ claims: { sub: ADMIN_ID }, isAdmin: true, nowSec: NOW }), { ok: false, status: 401, reason: "password_stale" });
  });

  it("the newest of several password entries counts", () => {
    const c: AdminClaims = { sub: ADMIN_ID, amr: [{ method: "password", timestamp: NOW - 3 * 3600 }, { method: "password", timestamp: NOW - 60 }] };
    assert.equal(passwordAgeSeconds(c, NOW), 60);
    assert.deepEqual(decideAdminAccess({ claims: c, isAdmin: true, nowSec: NOW }), { ok: true, adminId: ADMIN_ID });
  });

  it("a timestamp a little in the future (clock difference) counts as fresh, not as an error", () => {
    assert.equal(passwordAgeSeconds({ sub: ADMIN_ID, amr: [{ method: "password", timestamp: NOW + 20 }] }, NOW), 0);
  });

  it("the age limit can be changed by the caller", () => {
    assert.deepEqual(decideAdminAccess({ claims: claims(120), isAdmin: true, nowSec: NOW, maxAgeSec: 60 }), { ok: false, status: 401, reason: "password_stale" });
  });
});

describe("decodeJwtClaims", () => {
  it("returns null for garbage", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c", "..", "x.!!!.y", `x.${Buffer.from("not json").toString("base64url")}.y`, `x.${Buffer.from("[1,2]").toString("base64url")}.y`]) {
      assert.equal(decodeJwtClaims(bad), null, JSON.stringify(bad));
    }
  });

  it("reads the subject and the authentication methods of a well-formed token", () => {
    const decoded = decodeJwtClaims(token({ sub: ADMIN_ID, amr: [{ method: "password", timestamp: NOW }], role: "authenticated" }));
    assert.equal(decoded?.sub, ADMIN_ID);
    assert.deepEqual(decoded?.amr, [{ method: "password", timestamp: NOW }]);
  });

  it("ignores an amr that is not a list and entries that are not objects", () => {
    assert.deepEqual(decodeJwtClaims(token({ sub: ADMIN_ID, amr: "password" }))?.amr, []);
    assert.deepEqual(decodeJwtClaims(token({ sub: ADMIN_ID, amr: ["password", null, { method: "password", timestamp: NOW }] }))?.amr, [{ method: "password", timestamp: NOW }]);
  });
});

describe("parseAdminRequest", () => {
  const NOW_MS = Date.parse("2026-11-20T12:00:00Z");
  const parse = (body: unknown) => parseAdminRequest(body, NOW_MS);

  it("accepts every action with valid params and fills the defaults", () => {
    assert.deepEqual(parse({ action: "labels" }), { ok: true, action: "labels", params: {} });
    assert.deepEqual(parse({ action: "overview" }), { ok: true, action: "overview", params: {} });
    assert.deepEqual(parse({ action: "people" }), { ok: true, action: "people", params: { limit: 50, offset: 0 } });
    assert.deepEqual(
      parse({ action: "people", params: { search: "anna", label: "family", limit: 100, offset: 50 } }),
      { ok: true, action: "people", params: { search: "anna", label: "family", limit: 100, offset: 50 } },
    );
    assert.deepEqual(parse({ action: "person", params: { user_id: PERSON_ID } }), { ok: true, action: "person", params: { user_id: PERSON_ID } });
    assert.deepEqual(parse({ action: "feedback", params: { kind: "answers" } }), { ok: true, action: "feedback", params: { kind: "answers", limit: 50, offset: 0 } });
    assert.deepEqual(parse({ action: "feedback", params: { kind: "dynamics", rating: -1 } }), { ok: true, action: "feedback", params: { kind: "dynamics", rating: -1, limit: 50, offset: 0 } });
    assert.deepEqual(parse({ action: "errors" }), { ok: true, action: "errors", params: { since: "2026-11-13T12:00:00.000Z", limit: 100 } });
    assert.deepEqual(parse({ action: "costs" }), { ok: true, action: "costs", params: { since: "2026-10-21T12:00:00.000Z", until: "2026-11-21T12:00:00.000Z" } });
    assert.deepEqual(parse({ action: "costs", params: { since: "2026-11-01", until: "2026-11-20T00:00:00Z" } }), { ok: true, action: "costs", params: { since: "2026-11-01", until: "2026-11-20T00:00:00Z" } });
    assert.deepEqual(parse({ action: "set_label", params: { user_id: PERSON_ID, label_key: "technical" } }), { ok: true, action: "set_label", params: { user_id: PERSON_ID, label_key: "technical" } });
  });

  it("refuses what is not an object, an unknown action, and params that are not an object", () => {
    for (const body of [null, undefined, 5, "people", [], {}, { action: 5 }, { action: "drop_everything" }, { action: "people", params: "x" }, { action: "people", params: [] }]) {
      assert.deepEqual(parse(body), { ok: false, reason: "bad_request" }, JSON.stringify(body));
    }
  });

  it("refuses bad paging and search values", () => {
    for (const params of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "5" }, { offset: -1 }, { offset: 100001 }, { search: "x".repeat(101) }, { search: 5 }, { label: "Bad Label" }, { label: "x".repeat(33) }]) {
      assert.deepEqual(parse({ action: "people", params }), { ok: false, reason: "bad_request" }, JSON.stringify(params));
    }
  });

  it("refuses ids that are not UUIDs, a missing id, and a bad label key", () => {
    assert.deepEqual(parse({ action: "person", params: { user_id: "not-a-uuid" } }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "person", params: {} }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "set_label", params: { user_id: PERSON_ID } }), { ok: false, reason: "bad_request" });
    for (const label_key of ["", "Technical", "tech-nical", "x".repeat(33), 5]) {
      assert.deepEqual(parse({ action: "set_label", params: { user_id: PERSON_ID, label_key } }), { ok: false, reason: "bad_request" }, JSON.stringify(label_key));
    }
  });

  it("refuses a feedback kind, a rating and dates that are not allowed", () => {
    assert.deepEqual(parse({ action: "feedback", params: { kind: "messages" } }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "feedback", params: {} }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "feedback", params: { kind: "answers", rating: 0 } }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "feedback", params: { kind: "answers", rating: 2 } }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "costs", params: { since: "yesterday" } }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "costs", params: { since: "2026-13-45" } }), { ok: false, reason: "bad_request" });
    assert.deepEqual(parse({ action: "errors", params: { limit: 501 } }), { ok: false, reason: "bad_request" });
  });

  it("drops params nobody asked for, so a body cannot carry an admin id or a table name", () => {
    const result = parse({ action: "set_label", params: { user_id: PERSON_ID, label_key: "technical", admin_id: "x", table: "auth.users" } });
    assert.deepEqual(result, { ok: true, action: "set_label", params: { user_id: PERSON_ID, label_key: "technical" } });
  });
});

describe("adminRpcCall", () => {
  it("names the SQL function and its arguments for every action", () => {
    assert.deepEqual(adminRpcCall("labels", {}, ADMIN_ID), { name: "admin_list_labels", args: {} });
    assert.deepEqual(adminRpcCall("overview", {}, ADMIN_ID), { name: "admin_overview", args: {} });
    assert.deepEqual(
      adminRpcCall("people", { search: "anna", limit: 50, offset: 0 }, ADMIN_ID),
      { name: "admin_people", args: { p_search: "anna", p_label: null, p_limit: 50, p_offset: 0 } },
    );
    assert.deepEqual(adminRpcCall("person", { user_id: PERSON_ID }, ADMIN_ID), { name: "admin_person_card", args: { p_user_id: PERSON_ID } });
    assert.deepEqual(adminRpcCall("costs", { since: "a", until: "b" }, ADMIN_ID), { name: "admin_costs", args: { p_since: "a", p_until: "b" } });
    assert.deepEqual(
      adminRpcCall("feedback", { kind: "answers", limit: 50, offset: 0 }, ADMIN_ID),
      { name: "admin_feedback", args: { p_kind: "answers", p_rating: null, p_limit: 50, p_offset: 0 } },
    );
    assert.deepEqual(adminRpcCall("errors", { since: "a", limit: 100 }, ADMIN_ID), { name: "admin_errors", args: { p_since: "a", p_limit: 100 } });
  });

  it("set_label takes the admin from the verified token, never from the request", () => {
    assert.deepEqual(
      adminRpcCall("set_label", { user_id: PERSON_ID, label_key: "family" }, ADMIN_ID),
      { name: "admin_set_label", args: { p_admin_id: ADMIN_ID, p_user_id: PERSON_ID, p_label_key: "family" } },
    );
  });
});
