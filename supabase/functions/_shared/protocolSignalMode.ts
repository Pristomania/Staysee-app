/**
 * Semantic crisis mode — default off (PR7a). Legacy hard_stop opt-in only via env.
 */

export type SemanticCrisisMode = "off" | "hard_stop";

export function getSemanticCrisisMode(
  readEnv: () => string | undefined = () =>
    typeof Deno !== "undefined" ? Deno.env.get("STAYSEE_SEMANTIC_CRISIS_MODE") : undefined
): SemanticCrisisMode {
  const raw = readEnv()?.trim().toLowerCase();
  return raw === "hard_stop" ? "hard_stop" : "off";
}

export function isProtocolSignalsEnabled(
  readEnv: () => string | undefined = () =>
    typeof Deno !== "undefined" ? Deno.env.get("STAYSEE_PROTOCOL_SIGNALS") : undefined
): boolean {
  return readEnv()?.trim() === "1";
}
