/**
 * Verified chat user contract (variant A).
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/authUser.cases.test.ts
 *
 * Expected RED until supabase/functions/_shared/authUser.ts exists.
 */

import { resolveVerifiedChatUser } from "./authUser.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type FakeUser = { id: string } | null;
type FakeGetUserResult = { user: FakeUser; error: { message: string } | null };

function makeGetUser(result: FakeGetUserResult) {
  const calls: string[] = [];
  const getUser = async (token: string): Promise<FakeGetUserResult> => {
    calls.push(token);
    return result;
  };
  return { getUser, calls };
}

const VERIFIED_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "test-access-token";

// ── 1. Missing Authorization header ──────────────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: { id: VERIFIED_ID },
    error: null,
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: null,
    requestedUserId: undefined,
    getUser,
  });
  assert(result.ok === false, "1.missing: ok must be false");
  if (!result.ok) {
    assert(result.status === 401, "1.missing: status must be 401");
    assert(
      result.reason === "missing_bearer_token",
      `1.missing: reason expected missing_bearer_token, got ${result.reason}`,
    );
  }
  assert(calls.length === 0, "1.missing: getUser must not be called");
  console.log("✓ missing Authorization → missing_bearer_token, getUser unused");
}

// ── 2. Header without Bearer prefix ───────────────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: { id: VERIFIED_ID },
    error: null,
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: TOKEN,
    requestedUserId: undefined,
    getUser,
  });
  assert(result.ok === false, "2.no_bearer: ok must be false");
  if (!result.ok) {
    assert(result.status === 401, "2.no_bearer: status must be 401");
    assert(
      result.reason === "missing_bearer_token",
      `2.no_bearer: reason expected missing_bearer_token, got ${result.reason}`,
    );
  }
  assert(calls.length === 0, "2.no_bearer: getUser must not be called");
  console.log("✓ non-Bearer header → missing_bearer_token, getUser unused");
}

// ── 3. getUser returns error ──────────────────────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: null,
    error: { message: "forced getUser failure" },
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: `Bearer ${TOKEN}`,
    requestedUserId: undefined,
    getUser,
  });
  assert(result.ok === false, "3.invalid_error: ok must be false");
  if (!result.ok) {
    assert(result.status === 401, "3.invalid_error: status must be 401");
    assert(
      result.reason === "invalid_token",
      `3.invalid_error: reason expected invalid_token, got ${result.reason}`,
    );
  }
  assert(calls.length === 1, "3.invalid_error: getUser called once");
  assert(calls[0] === TOKEN, "3.invalid_error: getUser receives extracted token");
  console.log("✓ getUser error → invalid_token, getUser once with token");
}

// ── 4. getUser returns null user without error ────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: null,
    error: null,
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: `Bearer ${TOKEN}`,
    requestedUserId: undefined,
    getUser,
  });
  assert(result.ok === false, "4.null_user: ok must be false");
  if (!result.ok) {
    assert(result.status === 401, "4.null_user: status must be 401");
    assert(
      result.reason === "invalid_token",
      `4.null_user: reason expected invalid_token, got ${result.reason}`,
    );
  }
  assert(calls.length === 1, "4.null_user: getUser called once");
  console.log("✓ null user → invalid_token");
}

// ── 5. Valid token, no requestedUserId ────────────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: { id: VERIFIED_ID },
    error: null,
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: `Bearer ${TOKEN}`,
    requestedUserId: undefined,
    getUser,
  });
  assert(result.ok === true, "5.ok_no_body: ok must be true");
  if (result.ok) {
    assert(result.userId === VERIFIED_ID, "5.ok_no_body: userId from verified user");
    assert(result.authToken === TOKEN, "5.ok_no_body: authToken returned");
  }
  assert(calls.length === 1, "5.ok_no_body: getUser called once");
  console.log("✓ valid token, no body userId → ok with verified id");
}

// ── 6. Valid token, matching requestedUserId ──────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: { id: VERIFIED_ID },
    error: null,
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: `Bearer ${TOKEN}`,
    requestedUserId: VERIFIED_ID,
    getUser,
  });
  assert(result.ok === true, "6.match: ok must be true");
  if (result.ok) {
    assert(result.userId === VERIFIED_ID, "6.match: userId matches");
    assert(result.authToken === TOKEN, "6.match: authToken returned");
  }
  assert(calls.length === 1, "6.match: getUser called once");
  console.log("✓ matching requestedUserId → ok");
}

// ── 7. Valid token, mismatched requestedUserId ────────────────────────────────

{
  const { getUser, calls } = makeGetUser({
    user: { id: VERIFIED_ID },
    error: null,
  });
  const result = await resolveVerifiedChatUser({
    authorizationHeader: `Bearer ${TOKEN}`,
    requestedUserId: OTHER_ID,
    getUser,
  });
  assert(result.ok === false, "7.mismatch: ok must be false");
  if (!result.ok) {
    assert(result.status === 401, "7.mismatch: status must be 401");
    assert(
      result.reason === "user_id_mismatch",
      `7.mismatch: reason expected user_id_mismatch, got ${result.reason}`,
    );
    assert(
      !("userId" in result),
      "7.mismatch: verified userId must not be exposed on failure",
    );
  }
  assert(calls.length === 1, "7.mismatch: getUser called once");
  console.log("✓ mismatched requestedUserId → user_id_mismatch, no userId leak");
}

console.log("=== authUser.cases.test.ts OK ===");
