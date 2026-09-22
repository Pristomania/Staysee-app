export type MemoryV3DialogueMode = "off" | "dialogue_canary" | "dialogue_all";

export type MemoryV3DialogueEligibility =
  | { eligible: true; mode: "dialogue_canary" | "dialogue_all"; userId: string }
  | {
      eligible: false;
      mode: MemoryV3DialogueMode;
      reason: "disabled" | "invalid_allowlist" | "user_not_allowlisted";
    };

export interface MemoryV3DialogueEligibilityInput {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_FIELDS = new Set(["rawMode", "rawAllowedUserId", "userId"]);
const OWN_ERRORS = new WeakSet<object>();

function fail(): Error {
  const error = new Error(
    "[memory-v3:dialogue-mode] invalid eligibility input",
  );
  error.name = "MemoryV3DialogueModeError";
  OWN_ERRORS.add(error);
  return error;
}

function inspectInput(input: unknown): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw fail();
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw fail();

    const keys = Reflect.ownKeys(input);
    if (keys.length !== INPUT_FIELDS.size) throw fail();

    const projected: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !INPUT_FIELDS.has(key)) throw fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw fail();
      }
      projected[key] = descriptor.value;
    }

    for (const field of INPUT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(projected, field)) throw fail();
    }
    return projected;
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) {
      throw error;
    }
    throw fail();
  }
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function parseMemoryV3DialogueMode(
  raw: string | null | undefined,
): MemoryV3DialogueMode {
  return raw === "dialogue_canary" || raw === "dialogue_all" ? raw : "off";
}

export function resolveMemoryV3DialogueEligibility(
  input: MemoryV3DialogueEligibilityInput,
): MemoryV3DialogueEligibility {
  const projected = inspectInput(input);
  const mode = parseMemoryV3DialogueMode(
    projected.rawMode as string | null | undefined,
  );
  if (mode === "off") return { eligible: false, mode, reason: "disabled" };

  if (mode === "dialogue_all") {
    if (!isCanonicalUuid(projected.userId)) {
      return { eligible: false, mode, reason: "user_not_allowlisted" };
    }
    return { eligible: true, mode, userId: projected.userId };
  }

  if (!isCanonicalUuid(projected.rawAllowedUserId)) {
    return { eligible: false, mode, reason: "invalid_allowlist" };
  }
  if (
    !isCanonicalUuid(projected.userId) ||
    projected.userId !== projected.rawAllowedUserId
  ) {
    return { eligible: false, mode, reason: "user_not_allowlisted" };
  }

  return { eligible: true, mode, userId: projected.userId };
}
