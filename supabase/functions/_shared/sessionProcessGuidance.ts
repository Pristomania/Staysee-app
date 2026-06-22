/**
 * PR3c-2 — session process phase guidance from processState_{N-1}.
 * Descriptive phase context only — not behavioral rules or forbidden phrases.
 */

import type { SafetyCategory } from "./safety.ts";
import type { SessionProcessState } from "./sessionProcessState.ts";
import type {
  ProcessCertainty,
  ProcessClosure,
  ProcessContact,
  ProcessMovement,
} from "./structuredTurnSchema.ts";

const SESSION_PROCESS_GUIDANCE_ENV_KEY = "STAYSEE_SESSION_PROCESS_GUIDANCE";

const IMMEDIATE_SAFETY_CATEGORIES: SafetyCategory[] = [
  "crisis",
  "prompt_attack",
];

export type SessionProcessGuidanceMode = "off" | "on";

export interface SessionProcessGuidanceInput {
  /** processState_{N-1}; null on first turn or parse fail */
  priorState: SessionProcessState | null;
  /** Structural: explicit closure path active on current turn */
  explicitClosureActive: boolean;
  safetyCategory?: SafetyCategory | null;
  /** Test hook — defaults to Deno env */
  readEnv?: () => string | undefined;
}

const SESSION_PROCESS_GUIDANCE_HEADER =
  "СОСТОЯНИЕ ПРОЦЕССА (предыдущий ход)";

const CONTACT_LINES: Record<ProcessContact, string> = {
  active: "Контакт в разговоре: активный, обмен продолжается.",
  reduced: "Контакт в разговоре: сниженный, обмен идёт с меньшей плотностью.",
  distant: "Контакт в разговоре: дистанцированный, связь ослаблена.",
  closing: "Контакт в разговоре: смещается к закрытию.",
};

const MOVEMENT_LINES: Record<ProcessMovement, string> = {
  opening: "Движение темы: разворачивается, исследование продолжается.",
  stuck: "Движение темы: застряло, движение приостановлено.",
  deepening: "Движение темы: углубляется, фигура раскрывается.",
  integrating: "Движение темы: интегрируется, части складываются вместе.",
  settling: "Движение темы: оседает, становится яснее.",
};

const CLOSURE_LINES: Record<ProcessClosure, string> = {
  none: "Закрытие: не наступило.",
  user_closing: "Закрытие: пользователь склоняется к завершению разговора.",
  system_should_not_close:
    "Закрытие: тема остаётся открытой, завершение не наступило.",
};

const CERTAINTY_LINES: Record<ProcessCertainty, string> = {
  low: "Определённость: низкая, многое ещё открыто.",
  medium: "Определённость: средняя, часть картины прояснена.",
  high: "Определённость: высокая, многое уже прояснено.",
};

/** Parse raw env value; unknown / empty / missing → "off". */
export function parseSessionProcessGuidanceMode(
  raw: string | undefined | null
): SessionProcessGuidanceMode {
  return raw?.trim() === "on" ? "on" : "off";
}

export function getSessionProcessGuidanceMode(
  readEnv: () => string | undefined = () => {
    if (typeof Deno !== "undefined") {
      return Deno.env.get(SESSION_PROCESS_GUIDANCE_ENV_KEY);
    }
    return undefined;
  }
): SessionProcessGuidanceMode {
  return parseSessionProcessGuidanceMode(readEnv());
}

export function isSessionProcessGuidanceEnabled(
  readEnv?: () => string | undefined
): boolean {
  return getSessionProcessGuidanceMode(readEnv ?? (() => undefined)) === "on";
}

function isImmediateSafetyCategory(
  category: SafetyCategory | null | undefined
): boolean {
  if (!category) return false;
  return IMMEDIATE_SAFETY_CATEGORIES.includes(category);
}

export function buildSessionProcessGuidanceBlock(
  state: Pick<
    SessionProcessState,
    "contact" | "movement" | "closure" | "certainty"
  >
): string {
  const lines = [
    SESSION_PROCESS_GUIDANCE_HEADER,
    "",
    CONTACT_LINES[state.contact],
    MOVEMENT_LINES[state.movement],
    CLOSURE_LINES[state.closure],
    CERTAINTY_LINES[state.certainty],
  ];
  return lines.join("\n");
}

export function buildSessionProcessGuidance(
  input: SessionProcessGuidanceInput
): string | null {
  if (!isSessionProcessGuidanceEnabled(input.readEnv)) return null;
  if (!input.priorState) return null;
  if (input.explicitClosureActive) return null;
  if (isImmediateSafetyCategory(input.safetyCategory)) return null;
  return buildSessionProcessGuidanceBlock(input.priorState);
}

export function sessionProcessGuidanceInjected(
  input: SessionProcessGuidanceInput
): boolean {
  return buildSessionProcessGuidance(input) !== null;
}
