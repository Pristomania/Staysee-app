/**
 * Parse and strip hidden [STAYSEE_SIGNAL: …] tags from assistant output.
 * Tags must never reach the client.
 */

export const ALLOWED_PROTOCOL_SIGNALS = [
  "crisis_detected",
  "role_attack_detected",
  "boundary_pressure_detected",
] as const;

export type ProtocolSignalName = (typeof ALLOWED_PROTOCOL_SIGNALS)[number];

const WHITELIST_SET = new Set<string>(ALLOWED_PROTOCOL_SIGNALS);

/** Whitelisted full tag forms only. */
const WHITELISTED_TAG_RE =
  /\[STAYSEE_SIGNAL:\s*(crisis_detected|role_attack_detected|boundary_pressure_detected)\s*\]/gi;

/** Any STAYSEE_SIGNAL fragment (whitelist + unknown + partial). */
const ANY_SIGNAL_FRAGMENT_RE = /\[?\s*STAYSEE_SIGNAL[^\]]*\]?/gi;
const PARTIAL_STAYSEE_RE = /\[?\s*STAYSEE[^\]]*\]?/gi;

export interface ParsedProtocolSignals {
  signals: ProtocolSignalName[];
  signalCount: number;
}

export interface ParseAndStripResult extends ParsedProtocolSignals {
  text: string;
  leakageSanitized: boolean;
}

function dedupePreserveOrder(names: string[]): ProtocolSignalName[] {
  const out: ProtocolSignalName[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!WHITELIST_SET.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower as ProtocolSignalName);
  }
  return out;
}

export function parseProtocolSignals(text: string): ParsedProtocolSignals {
  const signals: string[] = [];
  for (const match of text.matchAll(WHITELISTED_TAG_RE)) {
    if (match[1]) signals.push(match[1].toLowerCase());
  }
  WHITELISTED_TAG_RE.lastIndex = 0;
  const deduped = dedupePreserveOrder(signals);
  return { signals: deduped, signalCount: deduped.length };
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripProtocolSignals(text: string): string {
  let out = text.replace(WHITELISTED_TAG_RE, "");
  WHITELISTED_TAG_RE.lastIndex = 0;
  out = out.replace(ANY_SIGNAL_FRAGMENT_RE, "");
  out = out.replace(PARTIAL_STAYSEE_RE, "");
  return collapseBlankLines(out);
}

export function parseAndStripProtocolSignals(text: string): ParseAndStripResult {
  const parsed = parseProtocolSignals(text);
  const stripped = stripProtocolSignals(text);
  const leakageSanitized =
    /STAYSEE_SIGNAL|\[STAYSEE/i.test(text) &&
    !/\[STAYSEE_SIGNAL:\s*(crisis_detected|role_attack_detected|boundary_pressure_detected)\s*\]/i.test(
      stripped
    );
  return {
    ...parsed,
    text: stripped,
    leakageSanitized,
  };
}
