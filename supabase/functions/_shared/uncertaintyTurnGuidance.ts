/**
 * Turn-level guidance when depth-router detects process uncertainty.
 * Injected only for the current model call — not a global prompt layer.
 */

import type { DepthReason } from "./responseDepthTrajectory.ts";
import { isExplicitConversationClosure } from "./responseDepthTrajectory.ts";

export interface UncertaintyTurnGuidanceInput {
  depthReason: DepthReason;
  message: string;
  openFigure?: { isOpen: boolean };
}

export const UNCERTAINTY_TURN_GUIDANCE_BLOCK = `ТЕКУЩИЙ ХОД: процессная неопределённость.

Пользователь не завершает разговор — он внутри открытой темы и пока не знает ответ.

Не закрывай контакт шаблонами: «со временем прояснится», «это нормально», «если захочешь — я рядом», «буду рада услышать позже».

Удержи текущую фигуру из слов пользователя.

Неопределённость не означает завершение процесса.
Продолжай выстраивать контакт.

Право не знать сохраняется.

В relational-дуге держи настоящее: что сейчас непривычно, что в теле, что важно сохранить — не главный вопрос про прогноз «изменит ли это отношения».

Не дави. Не веди. Не завершай тему.`.trim();

export function buildUncertaintyTurnGuidance(
  input: UncertaintyTurnGuidanceInput
): string | null {
  if (input.depthReason !== "uncertainty_in_process") return null;
  if (isExplicitConversationClosure(input.message)) return null;

  return UNCERTAINTY_TURN_GUIDANCE_BLOCK;
}

export function uncertaintyGuidanceInjected(
  input: UncertaintyTurnGuidanceInput
): boolean {
  return buildUncertaintyTurnGuidance(input) !== null;
}
