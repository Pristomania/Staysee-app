/**
 * Structured turn feature flag — fail-closed to "off".
 * Pure mode parsing is Node-testable; runtime reads Deno env.
 */

export type StructuredTurnMode = "off" | "shadow" | "response";

const STRUCTURED_TURN_ENV_KEY = "STAYSEE_STRUCTURED_TURN";

/** Parse raw env value; unknown / empty / missing → "off". */
export function parseStructuredTurnMode(
  raw: string | undefined | null
): StructuredTurnMode {
  const normalized = raw?.trim();
  switch (normalized) {
    case "shadow":
      return "shadow";
    case "response":
      return "response";
    default:
      return "off";
  }
}

export function getStructuredTurnMode(
  readEnv: () => string | undefined = () => {
    if (typeof Deno !== "undefined") {
      return Deno.env.get(STRUCTURED_TURN_ENV_KEY);
    }
    return undefined;
  }
): StructuredTurnMode {
  return parseStructuredTurnMode(readEnv());
}

export function isStructuredTurnEnabled(mode: StructuredTurnMode): boolean {
  return mode === "shadow" || mode === "response";
}
