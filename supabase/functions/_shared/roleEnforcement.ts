/**
 * Thread-level role enforcement + post-response guard.
 * Fixes "broken" chats where history keeps the model in assistant/content mode.
 */

import { userSignalsLanguageBoundary, LANGUAGE_BOUNDARY_GUIDANCE } from "./languageGuard.ts";
import {
  isStaleBoundaryScript,
  pickBoundaryFallback,
  userFrustrationAtBot,
} from "./boundaryFallback.ts";
import {
  analyzeRoleContamination,
  buildRoleResetGuidance,
  replyUsesWrongRole,
  userImposedRoleOverride,
  type ChatTurn,
} from "./roleGuard.ts";
import {
  classifyMessage,
  evaluateSafety,
  guidanceForCategory,
  type SafetyCategory,
  type SafetyResult,
} from "./safety.ts";

export type { ChatTurn };

const CATEGORY_RANK: Record<SafetyCategory, number> = {
  crisis: 100,
  boundary_pressure: 90,
  prompt_attack: 85,
  medical_boundary: 80,
  legal_financial_boundary: 75,
  dependency_risk: 70,
  off_topic: 65,
  emotional_support: 10,
  normal: 0,
};

const INSTRUMENTAL_LOOSE = [
  /напиши/i,
  /составь/i,
  /сделай/i,
  /перепиши/i,
  /сгенерируй/i,
  /придумай/i,
  /следующий\s+день/i,
  /допиши/i,
  /продолжи\s+(?:текст|историю|рассказ)/i,
  /дай\s+(?:мне\s+)?(?:список|план|текст|ответ|диагноз)/i,
  /хочу\s+чтобы\s+ты\s+(?:написал|написала)/i,
  /хочу\s+чтобы\s+ты\s+(?:составил|составила)/i,
  /хочу\s+чтобы\s+ты\s+(?:сделал|сделала)/i,
  /хочу\s+чтобы\s+ты\s+(?:был|была|стал|стала)/i,
  /хочу\s+чтобы\s+ты\s+играл(?:а)?\s+роль/i,
  /поставь\s+диагноз/i,
  /какое\s+лекарств/i,
  /какую\s+таблетк/i,
  /ты\s+(?:врач|доктор|chatgpt|ассистент)/i,
];

const BOUNDARY_REFUSAL_IN_ASSISTANT = [
  /не\s+(?:могу|буду)\s+(?:выполн|делать|писать|составлять)/i,
  /не\s+про\s+(?:услуг|задани|поручени)/i,
  /staysee/i,
  /не\s+ставлю\s+диагноз/i,
  /не\s+назначаю/i,
  /границ/i,
  /не\s+ассистент/i,
];

const DIAGNOSIS_IN_REPLY = [
  /у\s+тебя\s+(?:скорее\s+всего\s+)?(?:биполяр|депресс|тревожн|птср|шизофрен|окр|расстройств)/i,
  /(?:диагноз|заболевани[ея])\s*[—:-]/i,
  /(?:прими|принимай|назначу|рекомендую)\s+(?:\w+\s+){0,2}(?:таблетк|препарат|лекарств|антидепресс|сертралин|флуоксетин)/i,
  /(?:биполярн|депрессивн|тревожн)\s+(?:расстройств|состояни)/i,
];

const THREAD_ESCALATION_GUIDANCE = `
УКАЗАНИЕ НИТИ (не показывать):
Беседа уже уходила в «сделай за меня» / давление / медицину. Длинные прошлые ответы ассистента — НЕ образец; не продолжай тот же формат.
ЗАПРЕЩЕНО: списки, план, эссе, код, диагноз, лекарства, роль врача/ChatGPT, «продолжение» предыдущего материала.
2–4 предложения: тёплая граница, без лекции. Тон по её реплике — радость/«погнали» не своди к злости и страху. Один живой вопрос, не меню эмоций.
`.trim();

const INSISTENCE_GUIDANCE = `
УКАЗАНИЕ НАСТОЙЧИВОСТИ (не показывать):
Она повторяет требование после отказа. Не выполняй, не «договаривайся», не удлиняй. 2–4 предложения, без списков и без шаблона «злость/страх/усталость».
`.trim();

function strongerCategory(a: SafetyCategory, b: SafetyCategory): SafetyCategory {
  return CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b;
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function recentUserTexts(history: ChatTurn[], current: string, n = 8): string[] {
  const fromHist = history
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .slice(-n);
  return [...fromHist, current.trim()].filter(Boolean);
}

function recentAssistantTexts(history: ChatTurn[], n = 3): string[] {
  return history
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.trim())
    .slice(-n);
}

/** Thread escalation — sliding window, aligned with roleGuard (10 turns). */
const THREAD_ESCALATION_WINDOW = 10;
const THREAD_ESCALATION_USER_LOOKBACK = 4;

const BOUNDARY_CATEGORIES: SafetyCategory[] = [
  "off_topic",
  "boundary_pressure",
  "medical_boundary",
  "legal_financial_boundary",
];

export interface ThreadAnalysis {
  insistenceLoop: boolean;
  threadEscalated: boolean;
  oversizedAssistant: boolean;
  roleContaminated: boolean;
}

export function analyzeConversationThread(
  history: ChatTurn[],
  currentMessage: string
): ThreadAnalysis {
  const recent = history.slice(-THREAD_ESCALATION_WINDOW);
  const userTexts = [
    ...recent.filter((m) => m.role === "user").map((m) => m.content.trim()),
    currentMessage.trim(),
  ].filter(Boolean);
  const assistantTexts = recent
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.trim());

  const recentUserCategories = userTexts
    .slice(-THREAD_ESCALATION_USER_LOOKBACK)
    .map((t) => classifyMessage(t));
  const currentCategory = classifyMessage(currentMessage.trim());
  const boundaryHits = recentUserCategories.filter((c) =>
    BOUNDARY_CATEGORIES.includes(c)
  ).length;
  const activeBoundaryNow = BOUNDARY_CATEGORIES.includes(currentCategory);
  const recentBoundaryPressure = recentUserCategories
    .slice(-2)
    .some((c) => c === "boundary_pressure");

  const recentAssistant = assistantTexts.slice(-2);
  const oversizedAssistant = recentAssistant.some((t) => t.length >= 480);
  const longAssistantStreak =
    recentAssistant.filter((t) => t.length >= 380).length >= 2;

  const threadEscalated =
    activeBoundaryNow ||
    recentBoundaryPressure ||
    boundaryHits >= 2 ||
    (boundaryHits >= 1 && (oversizedAssistant || longAssistantStreak));

  const lastAssistant = assistantTexts[assistantTexts.length - 1] ?? "";
  const assistantRefusedBoundary =
    lastAssistant.length > 80 && matches(lastAssistant, BOUNDARY_REFUSAL_IN_ASSISTANT);

  const userInsistentNow = matches(currentMessage.trim(), INSTRUMENTAL_LOOSE);
  const recentInstrumental = userTexts.slice(-4).filter((t) => matches(t, INSTRUMENTAL_LOOSE)).length;

  const insistenceLoop =
    threadEscalated &&
    (userInsistentNow ||
      recentInstrumental >= 2 ||
      (assistantRefusedBoundary && userInsistentNow));

  const role = analyzeRoleContamination(history, currentMessage);
  const roleContaminated = role.contaminated;

  return {
    insistenceLoop,
    threadEscalated,
    oversizedAssistant,
    roleContaminated,
  };
}

/**
 * Merge per-message safety with thread context (history-aware).
 */
export function evaluateTurnSafety(
  message: string,
  history: ChatTurn[]
): SafetyResult & ThreadAnalysis {
  const base = evaluateSafety(message);
  const thread = analyzeConversationThread(history, message);
  const roleState = analyzeRoleContamination(history, message);

  let category = base.category;
  const frustrationTurn = userFrustrationAtBot(message);
  if (userImposedRoleOverride(message)) {
    category = strongerCategory(category, "boundary_pressure");
  }
  const userInsistentNow =
    !frustrationTurn && matches(message.trim(), INSTRUMENTAL_LOOSE);
  if (
    !frustrationTurn &&
    thread.threadEscalated &&
    (thread.insistenceLoop || userInsistentNow)
  ) {
    const peakFromHistory = recentUserTexts(history, message, 8)
      .map((t) => classifyMessage(t))
      .reduce((best, c) => strongerCategory(best, c), "normal" as SafetyCategory);
    category = strongerCategory(category, peakFromHistory);
    if (thread.insistenceLoop && category === "normal") {
      category = peakFromHistory !== "normal" ? peakFromHistory : "off_topic";
    }
  }

  const guidanceParts: string[] = [];
  if (category === base.category && base.systemGuidance) {
    guidanceParts.push(base.systemGuidance);
  } else {
    const catGuide = guidanceForCategory(category);
    if (catGuide) guidanceParts.push(catGuide);
    if (userSignalsLanguageBoundary(message)) {
      guidanceParts.push(LANGUAGE_BOUNDARY_GUIDANCE);
    }
  }
  if (frustrationTurn) {
    guidanceParts.push(`
УКАЗАНИЕ (не показывать): Она злится на бота. Признай раздражение. НЕ повторяй фразы «готовые куски», «своими словами», «рядом с тобой» из прошлых ответов. Новая формулировка, 2–3 предложения, без меню эмоций.
`.trim());
  } else {
    if (thread.threadEscalated) guidanceParts.push(THREAD_ESCALATION_GUIDANCE);
    if (thread.insistenceLoop) guidanceParts.push(INSISTENCE_GUIDANCE);
  }
  const roleReset = buildRoleResetGuidance(roleState);
  if (roleReset) guidanceParts.push(roleReset);

  const systemGuidance = guidanceParts.length
    ? [...new Set(guidanceParts)].join("\n\n")
    : undefined;

  return {
    category,
    immediateResponse: base.immediateResponse,
    systemGuidance,
    ...thread,
  };
}

function countSentences(text: string): number {
  return (text.match(/[.!?…]+/g) ?? []).length;
}

function truncateToMaxSentences(text: string, max: number): string {
  const parts = text.split(/(?<=[.!?…]["')\]]*)\s+/u);
  if (parts.length <= max) return text.trim();
  return parts.slice(0, max).join(" ").trim();
}

function looksLikeContentDelivery(text: string, strict = false): boolean {
  const t = text.trim();
  const lenCap = strict ? 420 : 720;
  if (t.length >= lenCap) return true;
  if ((t.match(/\n\n/g) ?? []).length >= (strict ? 1 : 2)) return true;
  if (/^\s*[\d]+[.)]\s/m.test(t)) return true;
  if ((t.match(/^\s*[-•*]\s/gm) ?? []).length >= (strict ? 2 : 3)) return true;
  if (/(?:во-первых|во-вторых|итак,|шаг\s+\d|следующий шаг:|план действий)/i.test(t)) return true;
  if (matches(t, DIAGNOSIS_IN_REPLY)) return true;
  return false;
}

const BOUNDED_CATEGORIES: SafetyCategory[] = [
  "off_topic",
  "boundary_pressure",
  "medical_boundary",
  "legal_financial_boundary",
];

/**
 * Hard cap / replace assistant output that slipped past the prompt.
 */
export function enforceRoleBoundedReply(
  content: string,
  category: SafetyCategory,
  opts?: {
    insistenceLoop?: boolean;
    threadEscalated?: boolean;
    userMessage?: string;
  }
): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;

  const frustrationTurn = userFrustrationAtBot(opts?.userMessage ?? "");
  if (frustrationTurn) {
    if (trimmed.length <= 520) return trimmed;
    return truncateToMaxSentences(trimmed, 4).slice(0, 520).trim();
  }

  const strictThread = Boolean(opts?.threadEscalated);
  const bounded =
    BOUNDED_CATEGORIES.includes(category) || Boolean(opts?.insistenceLoop);

  if (!bounded) {
    if (strictThread && trimmed.length > 520) {
      return truncateToMaxSentences(trimmed, 4).slice(0, 520).trim();
    }
    return trimmed;
  }

  const wrongRole = replyUsesWrongRole(trimmed);
  const mustPivot =
    wrongRole ||
    looksLikeContentDelivery(trimmed, true) ||
    (category === "medical_boundary" && matches(trimmed, DIAGNOSIS_IN_REPLY));

  if (mustPivot) {
    const fallback = pickBoundaryFallback(opts?.userMessage ?? "", {
      wrongRoleInReply: wrongRole,
    });
    if (!isStaleBoundaryScript(trimmed, fallback)) return fallback;
    if (trimmed.length >= 40 && trimmed.length <= 520) return trimmed;
    return fallback;
  }

  const maxChars =
    category === "boundary_pressure" || opts?.insistenceLoop ? 400 : 480;
  let out =
    trimmed.length > maxChars ? truncateToMaxSentences(trimmed, 4).slice(0, maxChars) : trimmed;

  if (countSentences(out) > 4) {
    out = truncateToMaxSentences(out, 4);
  }

  if (out.length > maxChars) {
    out = truncateToMaxSentences(out.slice(0, maxChars), 3);
  }

  return out.trim() || pickBoundaryFallback(opts?.userMessage ?? "");
}
