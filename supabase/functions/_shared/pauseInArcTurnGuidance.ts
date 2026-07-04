/**
 * Turn-level guidance when user marks a pause inside an open emotional process.
 * Injected only for the current model call — not a global prompt layer.
 */

import type { SafetyCategory } from "./safety.ts";
import type {
  ChatTurn,
  DepthReason,
  OpenFigureState,
} from "./responseDepthTrajectory.ts";
import {
  analyzeEmotionalTrajectory,
  isUncertaintyPhrase,
} from "./responseDepthTrajectory.ts";

export interface PauseInArcTurnGuidanceInput {
  message: string;
  depthReason: DepthReason;
  openFigure: OpenFigureState;
  emotionalMomentum: boolean;
  shortAfterEmotional: boolean;
  recentHistory: ChatTurn[];
  safetyCategory: SafetyCategory;
}

const SAFETY_BRIEF_CATEGORIES: SafetyCategory[] = [
  "off_topic",
  "boundary_pressure",
  "medical_boundary",
];

export const PAUSE_IN_ARC_TURN_GUIDANCE_BLOCK = `Человек обозначает паузу или временный уход — не закрытие разговора.

Прими паузу коротко и спокойно, без эмоционального удержания.
Запрещено: «буду ждать», «я всегда здесь», «я здесь», «возвращайся», «вернёшься — напиши», «если захочешь», «буду рада услышать», любые availability-хвосты.
Не подводи итог. Не предлагай продолжить. Не произноси прощания. Не открывай новую тему.
Одно короткое предложение — максимум.`.trim();

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Cyrillic-safe token boundary (JS \\b is ASCII-only). */
function hasCyrToken(text: string, token: string): boolean {
  const re = new RegExp(
    `(?:^|[\\s,.!?«"'(\\[—–-])${token}(?=[\\s,.!?»"')\\]—–-]|$)`,
    "iu"
  );
  return re.test(text);
}

function messageHasEmotionalSubstance(text: string): boolean {
  const words = wordCount(text);
  if (words < 12) return false;
  return /пуга|страх|тревог|груст|ответствен|решени|чувств|боюсь|мандраж|держит|на\s+мне/i.test(
    text
  );
}

/**
 * Short pause/departure phrase in the current message — routing only, not output filtering.
 */
export function isPauseDeparturePhrase(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (isUncertaintyPhrase(trimmed)) return false;
  if (/пока\s+не\s/i.test(trimmed)) return false;

  if (messageHasEmotionalSubstance(trimmed)) return false;

  const norm = trimmed.replace(/[.!?…]+$/u, "").replace(/\s+/g, " ").trim();
  const words = wordCount(norm);
  if (words > 15) return false;

  if (/^пока$/iu.test(norm)) return true;
  if (/на\s+минуту/i.test(norm)) return true;
  if (
    hasCyrToken(norm, "пойду") ||
    hasCyrToken(norm, "отойду") ||
    /(?:^|[\s,.!?«"'(\[—–-])отойти(?=[\s,.!?»"')\]—–-]|$)/iu.test(norm) ||
    hasCyrToken(norm, "вернусь") ||
    hasCyrToken(norm, "уйду") ||
    hasCyrToken(norm, "выйду")
  ) {
    return true;
  }
  if (/потом\s+продолжим/i.test(norm)) return true;
  if (hasCyrToken(norm, "пока") && words <= 5) return true;
  if (hasCyrToken(norm, "потом") && words <= 15) return true;

  return false;
}

function hasEmotionalOpenContext(input: PauseInArcTurnGuidanceInput): boolean {
  return (
    input.openFigure.isOpen ||
    input.emotionalMomentum ||
    input.shortAfterEmotional
  );
}

export function buildPauseInArcTurnGuidance(
  input: PauseInArcTurnGuidanceInput
): string | null {
  if (input.depthReason === "explicit_closure") return null;
  if (input.safetyCategory === "crisis") return null;
  if (SAFETY_BRIEF_CATEGORIES.includes(input.safetyCategory)) return null;
  if (!isPauseDeparturePhrase(input.message)) return null;
  if (!hasEmotionalOpenContext(input) && !isTemporaryDeparturePhrase(input.message)) {
    return null;
  }
  return PAUSE_IN_ARC_TURN_GUIDANCE_BLOCK;
}

/** Pause with return / step-away — not final conversation exit. */
function isTemporaryDeparturePhrase(message: string): boolean {
  const norm = message.trim().replace(/[.!?…]+$/u, "").replace(/\s+/g, " ").trim();
  if (!norm) return false;
  if (/^пока$/iu.test(norm)) return false;
  if (/^на\s+сегодня\s+/iu.test(norm)) return false;
  return (
    /вернусь|позже|потом\s+продолжим|отойти|отойду|на\s+минуту/i.test(norm) ||
    (/пойду/i.test(norm) && /пока|вернусь|позже|потом/i.test(norm))
  );
}

export function pauseInArcGuidanceInjected(
  input: PauseInArcTurnGuidanceInput
): boolean {
  return buildPauseInArcTurnGuidance(input) !== null;
}

/** Resolve shortAfterEmotional when caller only has recentHistory (responseBudget omits it). */
export function resolveShortAfterEmotional(
  message: string,
  recentHistory: ChatTurn[]
): boolean {
  return analyzeEmotionalTrajectory(message, recentHistory).shortAfterEmotional;
}
