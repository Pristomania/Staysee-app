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

Удержи текущую фигуру из слов пользователя. Предложи 1–2 конкретных варианта формата (не длинное меню):
— пару вопросов, если так легче;
— остаться с фактами/сценой как есть;
— посмотреть через ощущение или тело;
— признать «пока не знаю» как временную опору внутри живого процесса — не как финал хода.

Право не знать сохраняется. Не завершай ход одним наблюдением, отражением или паузой.

В relational-дуге держи настоящее: что сейчас непривычно, что в теле, что важно сохранить — не главный вопрос про прогноз «изменит ли это отношения».

Не дави. Не веди. Не завершай тему.`.trim();

const UNCERTAINTY_OPEN_FIGURE_ADDENDUM = `Если фигура открыта: после признания неопределённости сделай один мягкий шаг контакта — вопрос, сцена, ощущение или мягкое зеркало. Не закрывай фигуру за человека.`.trim();

export function buildUncertaintyTurnGuidance(
  input: UncertaintyTurnGuidanceInput
): string | null {
  if (input.depthReason !== "uncertainty_in_process") return null;
  if (isExplicitConversationClosure(input.message)) return null;

  if (input.openFigure?.isOpen) {
    return `${UNCERTAINTY_TURN_GUIDANCE_BLOCK}\n\n${UNCERTAINTY_OPEN_FIGURE_ADDENDUM}`;
  }
  return UNCERTAINTY_TURN_GUIDANCE_BLOCK;
}

export function uncertaintyGuidanceInjected(
  input: UncertaintyTurnGuidanceInput
): boolean {
  return buildUncertaintyTurnGuidance(input) !== null;
}
