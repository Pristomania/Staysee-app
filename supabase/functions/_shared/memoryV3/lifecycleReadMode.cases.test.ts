import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMemoryV3LifecycleReadMode,
  resolveMemoryV3LifecycleReadEligibility,
} from "./lifecycleReadMode.ts";

const NASTYA = "11111111-1111-4111-8111-111111111111";
const SON = "22222222-2222-4222-8222-222222222222";
const ALPHA_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function assertSafeBoundaryError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "MemoryV3LifecycleReadModeError");
    assert.equal(
      error.message,
      "[memory-v3:lifecycle-read-mode] invalid eligibility input",
    );
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes("SENTINEL"), false);
    return true;
  });
}

test("parseMemoryV3LifecycleReadMode accepts only the exact canary and all values", () => {
  assert.equal(parseMemoryV3LifecycleReadMode("canary"), "canary");
  assert.equal(parseMemoryV3LifecycleReadMode("all"), "all");
  for (const raw of [
    undefined,
    null,
    "",
    "off",
    "on",
    "CANARY",
    " canary",
    "canary ",
    "canary,off",
    "shadow",
    "lifecycle_shadow",
    "ALL",
    " all",
    "all ",
    "*",
    new String("canary"),
  ]) {
    assert.equal(
      parseMemoryV3LifecycleReadMode(raw as string | null | undefined),
      "off",
    );
  }
});

test("resolveMemoryV3LifecycleReadEligibility allows every canonical account only in all mode", () => {
  for (const userId of [NASTYA, SON]) {
    assert.deepEqual(resolveMemoryV3LifecycleReadEligibility({
      rawMode: "all",
      rawAllowedUserId: undefined,
      userId,
    }), {
      eligible: true,
      mode: "all",
      userId,
    });
  }
});

test("resolveMemoryV3LifecycleReadEligibility rejects malformed accounts in all mode", () => {
  for (const userId of ["", "*", ` ${NASTYA}`, ALPHA_USER.toUpperCase(), new String(NASTYA)]) {
    assert.deepEqual(resolveMemoryV3LifecycleReadEligibility({
      rawMode: "all",
      rawAllowedUserId: undefined,
      userId: userId as string,
    }), {
      eligible: false,
      mode: "all",
      reason: "user_not_allowlisted",
    });
  }
});

test("resolveMemoryV3LifecycleReadEligibility allows one exact canonical account", () => {
  const input = {
    rawMode: "canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
  };
  const before = structuredClone(input);

  assert.deepEqual(resolveMemoryV3LifecycleReadEligibility(input), {
    eligible: true,
    mode: "canary",
    userId: NASTYA,
  });
  assert.deepEqual(input, before);
});

test("resolveMemoryV3LifecycleReadEligibility fails closed when disabled", () => {
  for (const rawMode of [undefined, null, "", "off", "CANARY", "canary "]) {
    assert.deepEqual(resolveMemoryV3LifecycleReadEligibility({
      rawMode,
      rawAllowedUserId: NASTYA,
      userId: NASTYA,
    }), {
      eligible: false,
      mode: "off",
      reason: "disabled",
    });
  }
});

test("resolveMemoryV3LifecycleReadEligibility rejects invalid allowlist forms", () => {
  for (const rawAllowedUserId of [
    undefined,
    null,
    "",
    "*",
    "nastya@example.test",
    `${NASTYA},${SON}`,
    ALPHA_USER.toUpperCase(),
    ` ${NASTYA}`,
    `${NASTYA} `,
    new String(NASTYA),
  ]) {
    assert.deepEqual(resolveMemoryV3LifecycleReadEligibility({
      rawMode: "canary",
      rawAllowedUserId: rawAllowedUserId as string | null | undefined,
      userId: NASTYA,
    }), {
      eligible: false,
      mode: "canary",
      reason: "invalid_allowlist",
    });
  }
});

test("resolveMemoryV3LifecycleReadEligibility rejects a different or malformed account", () => {
  for (const [rawAllowedUserId, userId] of [
    [NASTYA, SON],
    [ALPHA_USER, ALPHA_USER.toUpperCase()],
    [NASTYA, ` ${NASTYA}`],
    [NASTYA, `${NASTYA} `],
    [NASTYA, ""],
    [NASTYA, new String(NASTYA)],
  ]) {
    assert.deepEqual(resolveMemoryV3LifecycleReadEligibility({
      rawMode: "canary",
      rawAllowedUserId: rawAllowedUserId as string,
      userId: userId as string,
    }), {
      eligible: false,
      mode: "canary",
      reason: "user_not_allowlisted",
    });
  }
});

test("resolveMemoryV3LifecycleReadEligibility rejects invalid top-level shapes", () => {
  for (const input of [undefined, null, true, 1, "canary", [], new Date()]) {
    assertSafeBoundaryError(() =>
      resolveMemoryV3LifecycleReadEligibility(input as never)
    );
  }
});

test("resolveMemoryV3LifecycleReadEligibility requires exactly three own enumerable data fields", () => {
  const inherited = Object.create({ rawMode: "canary" });
  inherited.rawAllowedUserId = NASTYA;
  inherited.userId = NASTYA;

  const missing = { rawMode: "canary", rawAllowedUserId: NASTYA };
  const extra = {
    rawMode: "canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
    profile: "SENTINEL",
  };
  const symbol = {
    rawMode: "canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
    [Symbol("SENTINEL")]: true,
  };
  const nonEnumerable = {
    rawMode: "canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
  };
  Object.defineProperty(nonEnumerable, "userId", {
    value: NASTYA,
    enumerable: false,
  });

  for (const input of [inherited, missing, extra, symbol, nonEnumerable]) {
    assertSafeBoundaryError(() =>
      resolveMemoryV3LifecycleReadEligibility(input as never)
    );
  }
});

test("resolveMemoryV3LifecycleReadEligibility never executes accessors", () => {
  let getterCalls = 0;
  let setterCalls = 0;
  const getterInput = {
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
    get rawMode() {
      getterCalls += 1;
      return "canary";
    },
  };
  const setterInput = {
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
  } as Record<string, unknown>;
  Object.defineProperty(setterInput, "rawMode", {
    enumerable: true,
    set(value: unknown) {
      void value;
      setterCalls += 1;
    },
  });

  assertSafeBoundaryError(() =>
    resolveMemoryV3LifecycleReadEligibility(getterInput)
  );
  assertSafeBoundaryError(() =>
    resolveMemoryV3LifecycleReadEligibility(setterInput as never)
  );
  assert.equal(getterCalls, 0);
  assert.equal(setterCalls, 0);
});

test("resolveMemoryV3LifecycleReadEligibility safe-wraps proxy traps and revoked proxies", () => {
  const trapError = new Error("RAW_SENTINEL");
  trapError.name = "MemoryV3LifecycleReadModeError";
  const trapped = new Proxy({}, {
    ownKeys() {
      throw trapError;
    },
  });
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();

  assertSafeBoundaryError(() =>
    resolveMemoryV3LifecycleReadEligibility(trapped as never)
  );
  assertSafeBoundaryError(() =>
    resolveMemoryV3LifecycleReadEligibility(revoked as never)
  );
});

test("resolveMemoryV3LifecycleReadEligibility rejects stateful descriptors without leaking trap text", () => {
  let descriptorCalls = 0;
  const target = {
    rawMode: "canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
  };
  const stateful = new Proxy(target, {
    getOwnPropertyDescriptor(subject, key) {
      descriptorCalls += 1;
      if (descriptorCalls > 1) throw new Error("DESCRIPTOR_SENTINEL");
      return Reflect.getOwnPropertyDescriptor(subject, key);
    },
  });

  assertSafeBoundaryError(() =>
    resolveMemoryV3LifecycleReadEligibility(stateful)
  );
});
