/**
 * Thread-level role enforcement (pre-generation guidance).
 * Post-response output is not truncated here — see docs/issues/reply-pipeline-cleanup.md.
 */

import { userSignalsLanguageBoundary, LANGUAGE_BOUNDARY_GUIDANCE } from "./languageGuard.ts";
import { userFrustrationAtBot } from "./boundaryFallback.ts";
import {
  analyzeRoleContamination,
  buildRoleResetGuidance,
  userImposedRoleOverride,
  type ChatTurn,
} from "./roleGuard.ts";
import {
  classifyMessage,
  evaluateSafety,
  guidanceForCategory,
  isRelationalLifeTurn,
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

  const currentCategory = classifyMessage(currentMessage.trim());
  const activeBoundaryNow = BOUNDARY_CATEGORIES.includes(currentCategory);
  const relationalTurn = isRelationalLifeTurn(currentMessage);

  const recentUserCategories = userTexts
    .slice(-THREAD_ESCALATION_USER_LOOKBACK)
    .map((t) => classifyMessage(t));
  const recentBoundaryPressure = recentUserCategories
    .slice(-2)
    .some((c) => c === "boundary_pressure");

  const recentAssistant = assistantTexts.slice(-2);
  const oversizedAssistant = recentAssistant.some((t) => t.length >= 480);

  const boundaryHits = recentUserCategories.filter((c) =>
    BOUNDARY_CATEGORIES.includes(c)
  ).length;

  /** Decay escalation on everyday relational turns — prior instrumental chat ≠ this turn. */
  const threadEscalated = relationalTurn
    ? activeBoundaryNow
    : activeBoundaryNow ||
      recentBoundaryPressure ||
      boundaryHits >= 2;

  const lastAssistant = assistantTexts[assistantTexts.length - 1] ?? "";
  const assistantRefusedBoundary =
    lastAssistant.length > 80 && matches(lastAssistant, BOUNDARY_REFUSAL_IN_ASSISTANT);

  const userInsistentNow =
    !relationalTurn && matches(currentMessage.trim(), INSTRUMENTAL_LOOSE);

  const insistenceLoop =
    threadEscalated &&
    (userInsistentNow ||
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
  const relationalTurn = isRelationalLifeTurn(message);

  let category = base.category;
  const frustrationTurn = userFrustrationAtBot(message);
  if (userImposedRoleOverride(message)) {
    category = strongerCategory(category, "boundary_pressure");
  }
  const userInsistentNow =
    !frustrationTurn &&
    !relationalTurn &&
    matches(message.trim(), INSTRUMENTAL_LOOSE);
  if (
    !frustrationTurn &&
    !relationalTurn &&
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
    if (thread.threadEscalated && !relationalTurn) {
      guidanceParts.push(THREAD_ESCALATION_GUIDANCE);
    }
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

/**
 * Post-response pass-through. Role/boundary protection is pre-generation (prompt guidance).
 * Post-generation truncation and fallback replacement removed — docs/issues/reply-pipeline-cleanup.md.
 */
export function enforceRoleBoundedReply(
  content: string,
  _category: SafetyCategory,
  _opts?: {
    insistenceLoop?: boolean;
    threadEscalated?: boolean;
    userMessage?: string;
    relationalLifeTurn?: boolean;
  }
): string {
  return content.trim();
}
