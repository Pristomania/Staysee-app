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

const SIGNAL_NAME_ALT = "crisis_detected|role_attack_detected|boundary_pressure_detected";

/** Whole line is only a bare machine signal token (format violation leak). */
const STANDALONE_SIGNAL_LINE_RE = new RegExp(
  `^[^\\S\\n]*(${SIGNAL_NAME_ALT})[^\\S\\n]*$(?:\\r?\\n|$)?`,
  "gim"
);

/** Bare signal name wrapped in brackets without STAYSEE_SIGNAL prefix. */
const BRACKETED_BARE_SIGNAL_RE = new RegExp(
  `\\[\\s*(${SIGNAL_NAME_ALT})\\s*\\]`,
  "gi"
);

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

function stripStandaloneSignalLines(text: string): { text: string; removed: boolean } {
  let removed = false;
  const out = text.replace(STANDALONE_SIGNAL_LINE_RE, () => {
    removed = true;
    return "";
  });
  STANDALONE_SIGNAL_LINE_RE.lastIndex = 0;
  return { text: out, removed };
}

function stripAllProtocolLeaks(text: string): {
  text: string;
  bareSignalsRemoved: boolean;
  partialStayseeSanitized: boolean;
} {
  let bareSignalsRemoved = false;

  let out = text.replace(WHITELISTED_TAG_RE, "");
  WHITELISTED_TAG_RE.lastIndex = 0;
  out = out.replace(ANY_SIGNAL_FRAGMENT_RE, "");
  out = out.replace(PARTIAL_STAYSEE_RE, "");

  const bracketed = stripWithFlag(out, BRACKETED_BARE_SIGNAL_RE);
  out = bracketed.text;
  bareSignalsRemoved ||= bracketed.removed;

  const standalone = stripStandaloneSignalLines(out);
  out = standalone.text;
  bareSignalsRemoved ||= standalone.removed;

  const collapsed = collapseBlankLines(out);
  const partialStayseeSanitized =
    /STAYSEE_SIGNAL|\[STAYSEE/i.test(text) &&
    !/\[STAYSEE_SIGNAL:\s*(crisis_detected|role_attack_detected|boundary_pressure_detected)\s*\]/i.test(
      collapsed
    );

  return { text: collapsed, bareSignalsRemoved, partialStayseeSanitized };
}

function stripWithFlag(text: string, pattern: RegExp): { text: string; removed: boolean } {
  let removed = false;
  const out = text.replace(pattern, () => {
    removed = true;
    return "";
  });
  pattern.lastIndex = 0;
  return { text: out, removed };
}

export function stripProtocolSignals(text: string): string {
  return stripAllProtocolLeaks(text).text;
}

export function parseAndStripProtocolSignals(text: string): ParseAndStripResult {
  const parsed = parseProtocolSignals(text);
  const { text: stripped, bareSignalsRemoved, partialStayseeSanitized } =
    stripAllProtocolLeaks(text);
  return {
    ...parsed,
    text: stripped,
    leakageSanitized: bareSignalsRemoved || partialStayseeSanitized,
  };
}
