/**
 * High-precision explicit crisis hard-stop — phrase/construction only.
 * PR7a: separate from broad CRISIS_PATTERNS in safety.ts (not reused).
 */

import { CRISIS_LEVEL2_RESPONSE } from "./safety.ts";

export interface ExplicitSafetyHardStopResult {
  shouldStop: boolean;
  event_type?: "crisis_hard_stop";
  severity?: "tier_3";
  protocol?: "regex_crisis_explicit";
  action_taken?: "hard_stop";
  confidence?: "high";
  matched_pattern?: string;
  response?: string;
}

/** Direct self-harm/suicide intent constructions — require explicit subject + verb object. */
const EXPLICIT_CRISIS_CONSTRUCTIONS: Array<{ id: string; pattern: RegExp }> = [
  { id: "want_die", pattern: /(?:^|[\s,.!?«"(\[]+)я\s+(?:хочу|собираюсь)\s+умереть(?:$|[\s,.!?»")\]]+)/iu },
  {
    id: "want_end_life",
    pattern: /(?:^|[\s,.!?«"(\[]+)я\s+(?:хочу|собираюсь)\s+покончить\s+с\s+собой(?:$|[\s,.!?»")\]]+)/iu,
  },
  {
    id: "will_end_life",
    pattern: /(?:^|[\s,.!?«"(\[]+)я\s+покончу\s+с\s+(?:собой|жизнью)(?:$|[\s,.!?»")\]]+)/iu,
  },
  { id: "kill_self", pattern: /(?:^|[\s,.!?«"(\[]+)я\s+убью\s+себя(?:$|[\s,.!?»")\]]+)/iu },
  {
    id: "self_harm_intent",
    pattern:
      /(?:^|[\s,.!?«"(\[]+)я\s+(?:хочу|собираюсь)\s+причинить\s+себе\s+вред(?:$|[\s,.!?»")\]]+)/iu,
  },
  {
    id: "self_harm_imminent",
    pattern:
      /(?:^|[\s,.!?«"(\[]+)я\s+сейчас\s+причиню\s+себе\s+вред(?:$|[\s,.!?»")\]]+)/iu,
  },
  { id: "want_die_en", pattern: /\bi\s+want\s+to\s+die\b/i },
  { id: "kill_myself_en", pattern: /\bi\s+(?:will|want\s+to)\s+kill\s+myself\b/i },
];

export function detectExplicitSafetyHardStop(message: string): ExplicitSafetyHardStopResult {
  const text = message.trim();
  if (!text) return { shouldStop: false };

  for (const { id, pattern } of EXPLICIT_CRISIS_CONSTRUCTIONS) {
    if (pattern.test(text)) {
      return {
        shouldStop: true,
        event_type: "crisis_hard_stop",
        severity: "tier_3",
        protocol: "regex_crisis_explicit",
        action_taken: "hard_stop",
        confidence: "high",
        matched_pattern: id,
        response: CRISIS_LEVEL2_RESPONSE,
      };
    }
  }

  return { shouldStop: false };
}
