/**
 * Switch for the hidden protocol signals (STAYSEE_PROTOCOL_SIGNALS=1).
 */

export function isProtocolSignalsEnabled(
  readEnv: () => string | undefined = () =>
    typeof Deno !== "undefined" ? Deno.env.get("STAYSEE_PROTOCOL_SIGNALS") : undefined
): boolean {
  return readEnv()?.trim() === "1";
}
