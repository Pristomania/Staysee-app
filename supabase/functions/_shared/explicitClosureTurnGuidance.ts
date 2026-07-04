/**
 * Turn-level guidance when depth-router detects explicit conversation exit.
 * Injected only for the current model call — not a global prompt layer.
 */

import type { DepthReason } from "./responseDepthTrajectory.ts";
import { isExplicitConversationClosure } from "./responseDepthTrajectory.ts";

export interface ExplicitClosureTurnGuidanceInput {
  depthReason: DepthReason;
  message: string;
}

export const EXPLICIT_CLOSURE_TURN_GUIDANCE_BLOCK = `ТЕКУЩИЙ ХОД: человек завершает разговор или уходит к делам.

Когда человек завершает, ответ остаётся тёплым и коротким — без новой темы.

Запрещено: «буду ждать», «я всегда здесь», «я здесь», «буду рядом», «возвращайся», «если захочешь», «если захочешь вернуться», «можем потом», «вернёмся позже», «буду рада услышать».`.trim();

export function buildExplicitClosureTurnGuidance(
  input: ExplicitClosureTurnGuidanceInput
): string | null {
  if (input.depthReason !== "explicit_closure") return null;
  if (!isExplicitConversationClosure(input.message)) return null;
  return EXPLICIT_CLOSURE_TURN_GUIDANCE_BLOCK;
}

export function explicitClosureGuidanceInjected(
  input: ExplicitClosureTurnGuidanceInput
): boolean {
  return buildExplicitClosureTurnGuidance(input) !== null;
}
