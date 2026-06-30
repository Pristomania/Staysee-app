/**
 * High-precision prompt-attack hard-stop — full constructions only.
 * PR7a: separate from broad PROMPT_ATTACK_PATTERNS in safety.ts (not reused).
 */

import { PROMPT_ATTACK_RESPONSE } from "./safety.ts";

export interface ExplicitPromptAttackHardStopResult {
  shouldStop: boolean;
  event_type?: "prompt_attack_hard_stop";
  severity?: "tier_3";
  protocol?: "regex_prompt_attack_explicit";
  action_taken?: "hard_stop";
  confidence?: "high";
  matched_pattern?: string;
  response?: string;
}

const EXPLICIT_PROMPT_ATTACK_CONSTRUCTIONS: Array<{ id: string; pattern: RegExp }> = [
  { id: "ignore_prev_instructions_ru", pattern: /игнорируй\s+предыдущие\s+инструкции/i },
  { id: "ignore_system_instructions_ru", pattern: /игнорируй\s+системные\s+инструкции/i },
  { id: "forget_your_rules_ru", pattern: /забудь\s+свои\s+правила/i },
  { id: "forget_prev_rules_ru", pattern: /забудь\s+предыдущие\s+правила/i },
  { id: "cancel_your_instructions_ru", pattern: /отмени\s+свои\s+инструкции/i },
  { id: "show_system_prompt_ru", pattern: /покажи\s+системный\s+промпт/i },
  { id: "reveal_system_instructions_ru", pattern: /раскрой\s+системные\s+инструкции/i },
  { id: "print_system_prompt_ru", pattern: /выведи\s+системный\s+промпт/i },
  {
    id: "what_in_system_prompt_ru",
    pattern: /что\s+написано\s+в\s+тво(?:ём|ем)\s+системном\s+промпте/i,
  },
  { id: "ignore_prev_instructions_en", pattern: /ignore\s+previous\s+instructions/i },
  { id: "show_system_prompt_en", pattern: /show\s+(?:me\s+)?(?:your\s+)?system\s+prompt/i },
];

export function detectExplicitPromptAttackHardStop(
  message: string
): ExplicitPromptAttackHardStopResult {
  const text = message.trim();
  if (!text) return { shouldStop: false };

  for (const { id, pattern } of EXPLICIT_PROMPT_ATTACK_CONSTRUCTIONS) {
    if (pattern.test(text)) {
      return {
        shouldStop: true,
        event_type: "prompt_attack_hard_stop",
        severity: "tier_3",
        protocol: "regex_prompt_attack_explicit",
        action_taken: "hard_stop",
        confidence: "high",
        matched_pattern: id,
        response: PROMPT_ATTACK_RESPONSE,
      };
    }
  }

  return { shouldStop: false };
}
