/**
 * Turn-level guidance when depth-router detects an open figure.
 * Injected only for the current model call — not a global prompt layer.
 */

import type { SafetyCategory } from "./safety.ts";
import type {
  DepthReason,
  OpenFigureKind,
  OpenFigureState,
} from "./responseDepthTrajectory.ts";

export interface OpenFigureTurnGuidanceInput {
  openFigure: OpenFigureState;
  depthReason: DepthReason;
  safetyCategory: SafetyCategory;
}

const SAFETY_BRIEF_CATEGORIES: SafetyCategory[] = [
  "off_topic",
  "boundary_pressure",
  "medical_boundary",
];

const OPEN_FIGURE_TURN_GUIDANCE_BASE = `ТЕКУЩИЙ ХОД: открытая фигура.
Тема ещё жива, контакт продолжается.
Не завершай ход одним наблюдением, отражением или паузой.
Наблюдение допустимо только как мост к одному живому шагу контакта.

Сделай ровно один живой шаг:
— открытый вопрос по словам пользователя;
— или конкретная сцена из сказанного;
— или телесный/ощутительный маркер;
— или мягкое зеркало противоречия.

Не анкета. Максимум один вопрос.
Не дави. Не углубляй любой ценой.
Не закрывай фигуру вместо человека.
Право не знать сохраняется.`.trim();

const KIND_FOCUS: Partial<Record<OpenFigureKind, string>> = {
  emotional:
    "Держи эмоциональный заряд из сказанного — не сглаживай и не закрывай его одной фразой.",
  relational:
    "Держи отношенческий момент из сказанного — что между людьми сейчас живое.",
  body: "Можно опереться на тело или ощущение — если это естественно из сказанного.",
  choice:
    "Неопределённость здесь живая — не торопи к ответу и не закрывай её наблюдением.",
};

function kindFocusLine(kind: OpenFigureKind): string | null {
  return KIND_FOCUS[kind] ?? null;
}

export function buildOpenFigureTurnGuidanceBlock(
  openFigure: OpenFigureState
): string {
  const focus = kindFocusLine(openFigure.kind);
  return focus
    ? `${OPEN_FIGURE_TURN_GUIDANCE_BASE}\n\n${focus}`
    : OPEN_FIGURE_TURN_GUIDANCE_BASE;
}

export function buildOpenFigureTurnGuidance(
  input: OpenFigureTurnGuidanceInput
): string | null {
  if (!input.openFigure.isOpen) return null;
  if (input.depthReason === "explicit_closure") return null;
  if (input.depthReason === "safety_brief") return null;
  if (input.safetyCategory === "crisis") return null;
  if (SAFETY_BRIEF_CATEGORIES.includes(input.safetyCategory)) return null;
  return buildOpenFigureTurnGuidanceBlock(input.openFigure);
}

export function openFigureGuidanceInjected(
  input: OpenFigureTurnGuidanceInput
): boolean {
  return buildOpenFigureTurnGuidance(input) !== null;
}
