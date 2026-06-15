/**
 * Per-turn guidance for grammatical gender when addressing the user.
 */

import type { SafetyCategory } from "./safety.ts";
import type { GenderDetectionResult } from "./userGrammaticalGender.ts";

export interface UserGenderTurnGuidanceOptions {
  safetyCategory: SafetyCategory;
  message: string;
  userTurnCount: number;
}

const BLOCKED_SAFETY_CATEGORIES = new Set<SafetyCategory>([
  "crisis",
  "medical_boundary",
  "legal_financial_boundary",
  "prompt_attack",
  "dependency_risk",
  "boundary_pressure",
]);

const ACUTE_DISTRESS_RE =
  /мне\s+плохо|не\s+знаю\s+что\s+делать|плачу|рыдаю|паник|не\s+выдерж|страшно|боюсь|хочу\s+умереть|суицид|самоповреж/i;

const FEMININE_HINT =
  `ОБРАЩЕНИЕ: пользователь говорит о себе в женском роде. Обращайся к пользователю в женском роде: «ты устала», «ты готова», «ты поняла»; не «ты устал».`.trim();

const MASCULINE_HINT =
  `ОБРАЩЕНИЕ: пользователь говорит о себе в мужском роде. Обращайся к пользователю в мужском роде: «ты устал», «ты готов», «ты понял»; не «ты устала».`.trim();

const NEUTRAL_HINT =
  `ОБРАЩЕНИЕ: пользователь предпочитает нейтральные формулировки. Избегай форм с явно мужским или женским родом, где это возможно.`.trim();

const SOFT_ASK_HINT =
  `ОБРАЩЕНИЕ: род обращения пока неясен. Где возможно — нейтральные формулировки без явного рода. Если уместно и контакт спокойный, один раз мягко можно спросить: «Как тебе комфортнее, чтобы я обращалась к тебе — в женском, мужском или нейтрально?» Не навязывай и не повторяй вопрос.`.trim();

export function isAcuteDistressMessage(message: string): boolean {
  return ACUTE_DISTRESS_RE.test(message.trim());
}

export function canAskGenderPreference(options: UserGenderTurnGuidanceOptions): boolean {
  if (BLOCKED_SAFETY_CATEGORIES.has(options.safetyCategory)) return false;
  if (options.safetyCategory !== "normal" && options.safetyCategory !== "emotional_support") {
    return false;
  }
  if (options.userTurnCount < 3) return false;
  if (isAcuteDistressMessage(options.message)) return false;
  return true;
}

export function buildUserGenderTurnGuidance(
  result: GenderDetectionResult,
  options: UserGenderTurnGuidanceOptions
): string | null {
  if (result.confidence !== "high") {
    if (result.gender === "unknown" && canAskGenderPreference(options)) {
      return SOFT_ASK_HINT;
    }
    return null;
  }

  switch (result.gender) {
    case "feminine":
      return FEMININE_HINT;
    case "masculine":
      return MASCULINE_HINT;
    case "neutral":
      return NEUTRAL_HINT;
    case "unknown":
      if (canAskGenderPreference(options)) return SOFT_ASK_HINT;
      return null;
    default:
      return null;
  }
}

export function userGenderGuidanceInjected(
  result: GenderDetectionResult,
  options: UserGenderTurnGuidanceOptions
): boolean {
  return buildUserGenderTurnGuidance(result, options) !== null;
}
