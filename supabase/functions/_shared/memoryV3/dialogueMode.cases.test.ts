import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMemoryV3DialogueMode,
  resolveMemoryV3DialogueEligibility,
} from "./dialogueMode.ts";

const NASTYA = "11111111-1111-4111-8111-111111111111";
const SON = "22222222-2222-4222-8222-222222222222";
const ALPHA_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function assertSafeBoundaryError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "MemoryV3DialogueModeError");
    assert.equal(
      error.message,
      "[memory-v3:dialogue-mode] invalid eligibility input",
    );
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes("SENTINEL"), false);
    return true;
  });
}

test("parseMemoryV3DialogueMode accepts only the exact dialogue_canary and dialogue_all values", () => {
  assert.equal(parseMemoryV3DialogueMode("dialogue_canary"), "dialogue_canary");
  assert.equal(parseMemoryV3DialogueMode("dialogue_all"), "dialogue_all");
  for (const raw of [
    undefined,
    null,
    "",
    "off",
    "on",
    "DIALOGUE_CANARY",
    " dialogue_canary",
    "dialogue_canary ",
    "dialogue_canary,off",
    "canary",
    "all",
    "shadow",
    "lifecycle_shadow",
    "DIALOGUE_ALL",
    " dialogue_all",
    "dialogue_all ",
    "*",
    new String("dialogue_canary"),
  ]) {
    assert.equal(
      parseMemoryV3DialogueMode(raw as string | null | undefined),
      "off",
    );
  }
});

test("resolveMemoryV3DialogueEligibility allows every canonical account only in dialogue_all mode", () => {
  for (const userId of [NASTYA, SON]) {
    assert.deepEqual(resolveMemoryV3DialogueEligibility({
      rawMode: "dialogue_all",
      rawAllowedUserId: undefined,
      userId,
    }), {
      eligible: true,
      mode: "dialogue_all",
      userId,
    });
  }
});

test("resolveMemoryV3DialogueEligibility rejects malformed accounts in dialogue_all mode", () => {
  for (const userId of ["", "*", ` ${NASTYA}`, ALPHA_USER.toUpperCase(), new String(NASTYA)]) {
    assert.deepEqual(resolveMemoryV3DialogueEligibility({
      rawMode: "dialogue_all",
      rawAllowedUserId: undefined,
      userId: userId as string,
    }), {
      eligible: false,
      mode: "dialogue_all",
      reason: "user_not_allowlisted",
    });
  }
});

test("resolveMemoryV3DialogueEligibility allows one exact canonical account", () => {
  const input = {
    rawMode: "dialogue_canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
  };
  const before = structuredClone(input);

  assert.deepEqual(resolveMemoryV3DialogueEligibility(input), {
    eligible: true,
    mode: "dialogue_canary",
    userId: NASTYA,
  });
  assert.deepEqual(input, before);
});

test("resolveMemoryV3DialogueEligibility fails closed when disabled", () => {
  for (const rawMode of [undefined, null, "", "off", "DIALOGUE_CANARY", "dialogue_canary "]) {
    assert.deepEqual(resolveMemoryV3DialogueEligibility({
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

test("resolveMemoryV3DialogueEligibility rejects invalid allowlist forms", () => {
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
    assert.deepEqual(resolveMemoryV3DialogueEligibility({
      rawMode: "dialogue_canary",
      rawAllowedUserId: rawAllowedUserId as string | null | undefined,
      userId: NASTYA,
    }), {
      eligible: false,
      mode: "dialogue_canary",
      reason: "invalid_allowlist",
    });
  }
});

test("resolveMemoryV3DialogueEligibility rejects a different or malformed account", () => {
  for (const [rawAllowedUserId, userId] of [
    [NASTYA, SON],
    [ALPHA_USER, ALPHA_USER.toUpperCase()],
    [NASTYA, ` ${NASTYA}`],
    [NASTYA, `${NASTYA} `],
    [NASTYA, ""],
    [NASTYA, new String(NASTYA)],
  ]) {
    assert.deepEqual(resolveMemoryV3DialogueEligibility({
      rawMode: "dialogue_canary",
      rawAllowedUserId: rawAllowedUserId as string,
      userId: userId as string,
    }), {
      eligible: false,
      mode: "dialogue_canary",
      reason: "user_not_allowlisted",
    });
  }
});

test("resolveMemoryV3DialogueEligibility rejects invalid top-level shapes", () => {
  for (const input of [undefined, null, true, 1, "dialogue_canary", [], new Date()]) {
    assertSafeBoundaryError(() =>
      resolveMemoryV3DialogueEligibility(input as never)
    );
  }
});

test("resolveMemoryV3DialogueEligibility requires exactly three own enumerable data fields", () => {
  const inherited = Object.create({ rawMode: "dialogue_canary" });
  inherited.rawAllowedUserId = NASTYA;
  inherited.userId = NASTYA;

  const missing = { rawMode: "dialogue_canary", rawAllowedUserId: NASTYA };
  const extra = {
    rawMode: "dialogue_canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
    profile: "SENTINEL",
  };
  const symbol = {
    rawMode: "dialogue_canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
    [Symbol("SENTINEL")]: true,
  };
  const nonEnumerable = {
    rawMode: "dialogue_canary",
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
  };
  Object.defineProperty(nonEnumerable, "userId", {
    value: NASTYA,
    enumerable: false,
  });

  for (const input of [inherited, missing, extra, symbol, nonEnumerable]) {
    assertSafeBoundaryError(() =>
      resolveMemoryV3DialogueEligibility(input as never)
    );
  }
});

test("resolveMemoryV3DialogueEligibility never executes accessors", () => {
  let getterCalls = 0;
  let setterCalls = 0;
  const getterInput = {
    rawAllowedUserId: NASTYA,
    userId: NASTYA,
    get rawMode() {
      getterCalls += 1;
      return "dialogue_canary";
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
    resolveMemoryV3DialogueEligibility(getterInput)
  );
  assertSafeBoundaryError(() =>
    resolveMemoryV3DialogueEligibility(setterInput as never)
  );
  assert.equal(getterCalls, 0);
  assert.equal(setterCalls, 0);
});

test("resolveMemoryV3DialogueEligibility safe-wraps proxy traps and revoked proxies", () => {
  const trapError = new Error("RAW_SENTINEL");
  trapError.name = "MemoryV3DialogueModeError";
  const trapped = new Proxy({}, {
    ownKeys() {
      throw trapError;
    },
  });
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();

  assertSafeBoundaryError(() =>
    resolveMemoryV3DialogueEligibility(trapped as never)
  );
  assertSafeBoundaryError(() =>
    resolveMemoryV3DialogueEligibility(revoked as never)
  );
});

test("resolveMemoryV3DialogueEligibility rejects stateful descriptors without leaking trap text", () => {
  let descriptorCalls = 0;
  const target = {
    rawMode: "dialogue_canary",
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
    resolveMemoryV3DialogueEligibility(stateful)
  );
});
