export type MemoryV3ShadowMode = "off" | "shadow";

export type MemoryV3ShadowEligibility =
  | { eligible: true; mode: "shadow"; userId: string }
  | {
      eligible: false;
      mode: "off" | "shadow";
      reason: "disabled" | "invalid_allowlist" | "user_not_allowlisted";
    };

export interface MemoryV3ShadowEligibilityInput {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_FIELDS = new Set(["rawMode", "rawAllowedUserId", "userId"]);
const OWN_ERRORS = new WeakSet<object>();

function fail(): Error {
  const error = new Error("[memory-v3:shadow-mode] invalid eligibility input");
  error.name = "MemoryV3ShadowModeError";
  OWN_ERRORS.add(error);
  return error;
}

function inspectInput(input: unknown): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw fail();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw fail();
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !INPUT_FIELDS.has(key)) throw fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail();
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) throw error;
    throw fail();
  }
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function parseMemoryV3ShadowMode(
  raw: string | null | undefined,
): MemoryV3ShadowMode {
  return raw === "shadow" ? "shadow" : "off";
}

export function resolveMemoryV3ShadowEligibility(
  input: MemoryV3ShadowEligibilityInput,
): MemoryV3ShadowEligibility {
  const projected = inspectInput(input);
  const mode = parseMemoryV3ShadowMode(projected.rawMode as string | null | undefined);
  if (mode === "off") return { eligible: false, mode, reason: "disabled" };
  if (!isCanonicalUuid(projected.rawAllowedUserId)) {
    return { eligible: false, mode, reason: "invalid_allowlist" };
  }
  if (!isCanonicalUuid(projected.userId) || projected.userId !== projected.rawAllowedUserId) {
    return { eligible: false, mode, reason: "user_not_allowlisted" };
  }
  return { eligible: true, mode, userId: projected.userId };
}
