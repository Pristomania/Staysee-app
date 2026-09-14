import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMemoryV3ShadowMode,
  resolveMemoryV3ShadowEligibility,
} from "./mode.ts";

const NASTYA = "11111111-1111-4111-8111-111111111111";
const SON = "22222222-2222-4222-8222-222222222222";
const ALPHA_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("parseMemoryV3ShadowMode accepts only the exact shadow value", () => {
  assert.equal(parseMemoryV3ShadowMode(undefined), "off");
  assert.equal(parseMemoryV3ShadowMode(null), "off");
  assert.equal(parseMemoryV3ShadowMode("shadow"), "shadow");
  for (const raw of ["", "off", "off ", " shadow", "SHADOW", "on", "response", "shadow,off"]) {
    assert.equal(parseMemoryV3ShadowMode(raw), "off");
  }
  assert.equal(parseMemoryV3ShadowMode(new String("shadow") as unknown as string), "off");
});

test("resolveMemoryV3ShadowEligibility allows one exact canonical UUID", () => {
  assert.deepEqual(resolveMemoryV3ShadowEligibility({ rawMode: "shadow", rawAllowedUserId: NASTYA, userId: NASTYA }), {
    eligible: true,
    mode: "shadow",
    userId: NASTYA,
  });
});

test("resolveMemoryV3ShadowEligibility fails closed for disabled mode", () => {
  assert.deepEqual(resolveMemoryV3ShadowEligibility({ rawMode: "off", rawAllowedUserId: NASTYA, userId: NASTYA }), {
    eligible: false,
    mode: "off",
    reason: "disabled",
  });
});

test("resolveMemoryV3ShadowEligibility rejects invalid allowlist forms", () => {
  for (const [rawAllowedUserId, userId] of [[undefined, NASTYA], [null, NASTYA], ["*", NASTYA], ["nastya@example.test", NASTYA], [`${NASTYA},${SON}`, NASTYA], [ALPHA_USER.toUpperCase(), ALPHA_USER], [` ${NASTYA}`, NASTYA], [new String(NASTYA), NASTYA]]) {
    assert.deepEqual(resolveMemoryV3ShadowEligibility({ rawMode: "shadow", rawAllowedUserId: rawAllowedUserId as string | null | undefined, userId: userId as string }), {
      eligible: false,
      mode: "shadow",
      reason: "invalid_allowlist",
    });
  }
});

test("resolveMemoryV3ShadowEligibility rejects a different or malformed account", () => {
  assert.deepEqual(resolveMemoryV3ShadowEligibility({ rawMode: "shadow", rawAllowedUserId: NASTYA, userId: SON }), {
    eligible: false,
    mode: "shadow",
    reason: "user_not_allowlisted",
  });
  for (const [rawAllowedUserId, userId] of [[ALPHA_USER, ALPHA_USER.toUpperCase()], [NASTYA, ` ${NASTYA}`], [NASTYA, ""], [NASTYA, new String(NASTYA)]]) {
    assert.deepEqual(resolveMemoryV3ShadowEligibility({ rawMode: "shadow", rawAllowedUserId: rawAllowedUserId as string, userId: userId as string }), {
      eligible: false,
      mode: "shadow",
      reason: "user_not_allowlisted",
    });
  }
});

test("resolveMemoryV3ShadowEligibility never executes input accessors", () => {
  let getterCalls = 0;
  const input = { rawAllowedUserId: NASTYA, userId: NASTYA, get rawMode() { getterCalls += 1; return "shadow"; } };
  assert.throws(() => resolveMemoryV3ShadowEligibility(input), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /^\[memory-v3:shadow-mode\]/);
    assert.equal("cause" in error, false);
    return true;
  });
  assert.equal(getterCalls, 0);
});

test("resolveMemoryV3ShadowEligibility does not trust spoofed Proxy errors", () => {
  const stolen = new Error("RAW_MODE_SECRET_SENTINEL");
  stolen.name = "MemoryV3ShadowModeError";
  const input = new Proxy({}, { ownKeys() { throw stolen; } });
  assert.throws(() => resolveMemoryV3ShadowEligibility(input as never), (error: unknown) => {
    assert(error instanceof Error);
    assert.notEqual(error, stolen);
    assert.equal(error.message.includes("RAW_MODE_SECRET_SENTINEL"), false);
    assert.equal("cause" in error, false);
    return true;
  });
});

test("resolveMemoryV3ShadowEligibility safe-wraps a revoked input Proxy", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.throws(() => resolveMemoryV3ShadowEligibility(proxy as never), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "MemoryV3ShadowModeError");
    assert.match(error.message, /^\[memory-v3:shadow-mode\]/);
    assert.equal("cause" in error, false);
    return true;
  });
});
