/**
 * Passive detector: crisis/emergency contacts already present in final assistant text.
 * Does not inspect user text. Does not mutate replies.
 */

export type CrisisContactKind =
  | "mch_crisis_line"
  | "findahelpline"
  | "child_helpline"
  | "emergency_112"
  | "ambulance_103";

export type CrisisContactCategoryEvent =
  | "psychological_crisis_support_offered"
  | "physical_emergency_support_offered";

export type DetectedCrisisContact = {
  kind: CrisisContactKind;
  categoryEvent: CrisisContactCategoryEvent;
};

/** MChS psychological line — allow spaces / optional parens / dashes. */
const MCH_LINE_RE =
  /\+?\s*7[\s\-]*(?:\(\s*495\s*\)|495)[\s\-]*989[\s\-]*50[\s\-]*50\b/;

const FINDAHELPLINE_RE = /\bfindahelpline\.com\b/i;

/** Child/teen helpline 8-800-2000-122 with flexible separators. */
const CHILD_HELPLINE_RE = /\b8[\s\-]*800[\s\-]*2000[\s\-]*122\b/;

/**
 * Emergency 112 / ambulance 103 as standalone numbers (not embedded in longer digits).
 * Lookbehind/lookahead: not a digit on either side.
 */
const EMERGENCY_112_RE = /(?<![\d])112(?![\d])/;
const AMBULANCE_103_RE = /(?<![\d])103(?![\d])/;

/**
 * Scan final assistant response only. Dedupes by contact kind.
 */
export function detectCrisisContactsInAssistantReply(
  assistantText: string,
): DetectedCrisisContact[] {
  const text = typeof assistantText === "string" ? assistantText : "";
  if (!text) return [];

  const found = new Map<CrisisContactKind, DetectedCrisisContact>();

  const add = (
    kind: CrisisContactKind,
    categoryEvent: CrisisContactCategoryEvent,
  ) => {
    if (!found.has(kind)) {
      found.set(kind, { kind, categoryEvent });
    }
  };

  if (MCH_LINE_RE.test(text)) {
    add("mch_crisis_line", "psychological_crisis_support_offered");
  }
  if (FINDAHELPLINE_RE.test(text)) {
    add("findahelpline", "psychological_crisis_support_offered");
  }
  if (CHILD_HELPLINE_RE.test(text)) {
    add("child_helpline", "psychological_crisis_support_offered");
  }
  if (EMERGENCY_112_RE.test(text)) {
    add("emergency_112", "physical_emergency_support_offered");
  }
  if (AMBULANCE_103_RE.test(text)) {
    add("ambulance_103", "physical_emergency_support_offered");
  }

  return [...found.values()];
}

export function crisisContactCategoryEvents(
  contacts: DetectedCrisisContact[],
): CrisisContactCategoryEvent[] {
  const set = new Set<CrisisContactCategoryEvent>();
  for (const c of contacts) set.add(c.categoryEvent);
  return [...set];
}
