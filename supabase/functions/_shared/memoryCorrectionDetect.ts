/**
 * Detect durable memory correction candidates from user messages (pure, v1).
 */

import {
  buildDisplayText,
  COHABIT_CORRECTION_PHRASE_RE,
  COHABIT_SEPARATE_RE,
  DELETE_FACT_COMMAND_RE,
  FABRICATION_ACCUSATION_RE,
  MAX_CORRECTION_TEXT,
  MEMORY_CORRECTION_SUBJECTS,
  normalizeCorrectionLine,
  PARTNER_CONTEXT_RE,
  RELATIONSHIP_STATUS_RE,
  wantsGlobalScope,
  type MemoryCorrectionScope,
  type MemoryCorrectionSubjectKey,
} from "./memoryCorrectionSubjects.ts";

export type MemoryCorrectionConfidence = "high" | "medium";
export type MemoryCorrectionSource = "explicit_command" | "correction_pattern";

export interface MemoryCorrectionCandidate {
  subjectKey: MemoryCorrectionSubjectKey;
  correctionText: string;
  displayText: string;
  oldText?: string;
  scope: MemoryCorrectionScope;
  confidence: MemoryCorrectionConfidence;
  source: MemoryCorrectionSource;
}

export interface DetectMemoryCorrectionInput {
  message: string;
  hasConversationId: boolean;
}

function extractDeleteTarget(message: string): string | null {
  const t = message.trim();
  const patterns = [
    /удали\s+из\s+памяти\s*:?\s*(.+)/i,
    /забудь\s+что\s+(.+)/i,
    /не\s+запоминай\s+(?:это\s+)?(?:[:—–-]\s*)?(.+)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    const target = m?.[1]?.trim();
    if (target && target.length >= 8) {
      return normalizeCorrectionLine(target, MAX_CORRECTION_TEXT);
    }
  }
  return null;
}

function resolveScope(message: string, hasConversationId: boolean): MemoryCorrectionScope | null {
  if (wantsGlobalScope(message)) return "global";
  if (hasConversationId) return "conversation";
  return null;
}

function makeCandidate(
  subjectKey: MemoryCorrectionSubjectKey,
  message: string,
  scope: MemoryCorrectionScope,
  source: MemoryCorrectionSource,
  oldText?: string
): MemoryCorrectionCandidate {
  const correctionText = normalizeCorrectionLine(message, MAX_CORRECTION_TEXT);
  return {
    subjectKey,
    correctionText,
    displayText: buildDisplayText(correctionText),
    oldText,
    scope,
    confidence: "high",
    source,
  };
}

/** Returns a durable candidate or null. Only high-confidence v1 subjects. */
export function detectMemoryCorrection(
  input: DetectMemoryCorrectionInput
): MemoryCorrectionCandidate | null {
  const message = input.message.trim();
  if (message.length < 8) return null;

  const scope = resolveScope(message, input.hasConversationId);
  if (!scope) return null;

  if (DELETE_FACT_COMMAND_RE.test(message)) {
    const target = extractDeleteTarget(message);
    if (!target) return null;
    return makeCandidate(
      MEMORY_CORRECTION_SUBJECTS.deleteFact,
      message,
      scope,
      "explicit_command",
      target
    );
  }

  if (FABRICATION_ACCUSATION_RE.test(message)) {
    return null;
  }

  const hasPartner = PARTNER_CONTEXT_RE.test(message);

  if (
    COHABIT_CORRECTION_PHRASE_RE.test(message) ||
    (COHABIT_SEPARATE_RE.test(message) && hasPartner)
  ) {
    return makeCandidate(
      MEMORY_CORRECTION_SUBJECTS.cohabitation,
      message,
      scope,
      "correction_pattern"
    );
  }

  if (RELATIONSHIP_STATUS_RE.test(message) && hasPartner) {
    return makeCandidate(
      MEMORY_CORRECTION_SUBJECTS.status,
      message,
      scope,
      "correction_pattern"
    );
  }

  return null;
}

/** Broad emotional denial — must NOT become durable. */
export function isEphemeralDenialOnly(message: string): boolean {
  const t = message.trim();
  if (/^нет,?\s*я\s+просто\s+/i.test(t)) return true;
  if (/^нет,?\s*не\s+так\s+/i.test(t)) return true;
  if (/^нет\b/i.test(t) && !COHABIT_SEPARATE_RE.test(t) && !RELATIONSHIP_STATUS_RE.test(t)) {
    return true;
  }
  return false;
}
