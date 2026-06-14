/**
 * Emotional trajectory analysis for response depth routing.
 * Pure logic — no Supabase / Deno imports (testable under Node).
 */

export type ResponseDepth = "brief" | "medium" | "deep";

export type DepthReason =
  | "continue_redo"
  | "safety_brief"
  | "crisis"
  | "greeting_short"
  | "short_neutral"
  | "uncertainty_in_process"
  | "recent_emotional_trajectory"
  | "emotional_momentum_deep"
  | "long_emotional"
  | "thread_emotional"
  | "default_medium";

export type SafetyCategory =
  | "normal"
  | "crisis"
  | "off_topic"
  | "boundary_pressure"
  | "medical_boundary"
  | "legal_financial_boundary"
  | "prompt_attack"
  | "dependency_risk";

export interface ResponseDepthAnalysis {
  depth: ResponseDepth;
  depthReason: DepthReason;
  recentUserTurns: number;
  emotionalMomentum: boolean;
}

/** Cyrillic-safe word boundary (JS \b is ASCII-only). */
const CYR_WORD_END = `(?=[\\s,.!?…»"'\\)\\]—–-]|$)`;
const CYR_WORD_START = `(?:^|[\\s,.!?«"'\\(\\[—–-])`;

function cyrWords(...words: string[]): RegExp {
  return new RegExp(
    `${CYR_WORD_START}(${words.join("|")})${CYR_WORD_END}`,
    "iu"
  );
}

const BRIEF_GREETING =
  /^(привет|здравствуй|здравствуйте|добрый|доброе|хай|hello|hi|hey)(?:[!.,?\s]|$)/i;
const BRIEF_THANKS =
  /^(спасибо|благодарю|thanks|thank you)(?:[!.,?\s]|$)/i;
const BRIEF_SHORT = /^(да|нет|ок|okay|ладно|понятно|ясно)\s*!?\s*$/i;
const CONTINUE =
  /^(дальше|продолжай|продолжи|ещё|еще|continue)(?:[!.,?\s]|$)/i;

const REDO_REQUEST =
  /^(давай\s+(ещ[её]\s+)?раз|ещ[её]\s+раз|повтори|по-новому|заново|переформулируй|скажи иначе)/i;

const UNCERTAINTY_IN_PROCESS_RE =
  /^(?:я\s+)?(?:не\s*знаю|пока\s+не\s+понятно|непонятно|сложно\s+сказать|не\s+чувствую|не\s+могу\s+понять|запуталась|не\s+уверена)(?:\s*[.!?…]*)?$/iu;

const DEEP_EMOTIONAL = [
  /грустн|грусть|тоск|тревог|тревож|страх|боюсь|страшно/i,
  /одинок|устал|устала|выгоран|выматывает|больно|плачу|рыдаю/i,
  /не могу|не знаю что делать|не выдерживаю|на пределе/i,
  /отношен|развод|предал|предала|потерял|потеряла|умер|смерть/i,
  /травм|депресс|паник|кризис|смысл жизни/i,
  /выговориться|разобраться|что со мной/i,
];

const TRAJECTORY_LOOKBACK = 6;

const RELATION_WORDS = cyrWords(
  "он",
  "она",
  "сын",
  "дочь",
  "муж",
  "мужчина",
  "мама",
  "мать",
  "отец",
  "подруга",
  "парень",
  "брат",
  "сестра"
);

const MOMENTUM_PATTERNS = [
  /устал|устала|устаю|выматывает|выгоран|нет сил|на пределе|не выдерживаю/i,
  /не\s*понятно|непонятно|не\s*знаю|растерян/i,
  /тревож|страшно|боюсь|паник|тревог/i,
  /больно|пусто|тяжело|грустн|грусть|тоск|плачу|злюсь|злость|(?:^|\s)зла(?=[\s,.!?…]|$)/i,
  /работа\w*|работаю/i,
  RELATION_WORDS,
  /отношен|непривычн|новый|новая|новое|изменил/i,
  /одинок|как\s+всегда|опять|снова|одно\s+и\s+то\s+же/i,
  /^сон$/i,
  /^молчу$/i,
];

type ChatTurn = { role: string; content: string };

function collectRecentUserTurns(
  message: string,
  recentHistory: ChatTurn[]
): string[] {
  const trimmed = message.trim();
  const fromHistory = recentHistory
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);

  const last = fromHistory[fromHistory.length - 1];
  const turns =
    last === trimmed ? fromHistory : [...fromHistory, trimmed];

  return turns.slice(-TRAJECTORY_LOOKBACK);
}

function turnHasEmotionalSignal(text: string): boolean {
  return (
    MOMENTUM_PATTERNS.some((p) => p.test(text)) ||
    DEEP_EMOTIONAL.some((p) => p.test(text))
  );
}

function countMomentumSignals(turns: string[]): number {
  let count = 0;
  for (const pattern of MOMENTUM_PATTERNS) {
    if (turns.some((t) => pattern.test(t))) count++;
  }
  return count;
}

function momentumAcrossMultipleTurns(turns: string[]): boolean {
  let hits = 0;
  for (const t of turns) {
    if (turnHasEmotionalSignal(t)) hits++;
  }
  return hits >= 2;
}

export function isUncertaintyInProcessMessage(message: string): boolean {
  return UNCERTAINTY_IN_PROCESS_RE.test(message.trim());
}

/** Prior user turns with emotional/substantive arc (not isolated uncertainty). */
export function hasSubstantivePriorArc(priorUserTurns: string[]): boolean {
  if (priorUserTurns.length === 0) return false;
  return priorUserTurns.some(
    (t) =>
      turnHasEmotionalSignal(t) ||
      (t.length >= 20 &&
        /мужчин|ночевал|отношен|тревог|чувств|работа|боюсь|грустн|злюсь|непривычн|жив/i.test(
          t
        ))
  );
}

export interface EmotionalTrajectory {
  recentUserTurns: string[];
  emotionalMomentum: boolean;
  shortAfterEmotional: boolean;
  signalCount: number;
  uncertaintyInProcess: boolean;
}

export function analyzeEmotionalTrajectory(
  message: string,
  recentHistory: ChatTurn[]
): EmotionalTrajectory {
  const recentUserTurns = collectRecentUserTurns(message, recentHistory);
  const signalCount = countMomentumSignals(recentUserTurns);
  const emotionalMomentum =
    signalCount >= 2 || momentumAcrossMultipleTurns(recentUserTurns);

  const trimmed = message.trim();
  const priorTurns = recentUserTurns.slice(0, -1);
  const shortAfterEmotional =
    trimmed.length < 40 &&
    priorTurns.length > 0 &&
    priorTurns.some((t) => turnHasEmotionalSignal(t));

  const uncertaintyInProcess =
    isUncertaintyInProcessMessage(trimmed) &&
    hasSubstantivePriorArc(priorTurns);

  return {
    recentUserTurns,
    emotionalMomentum,
    shortAfterEmotional,
    signalCount,
    uncertaintyInProcess,
  };
}

function hasRecentEmotionalTrajectory(trajectory: EmotionalTrajectory): boolean {
  return trajectory.emotionalMomentum || trajectory.shortAfterEmotional;
}

export function analyzeResponseDepth(
  message: string,
  safetyCategory: SafetyCategory,
  recentHistory: ChatTurn[]
): ResponseDepthAnalysis {
  const trimmed = message.trim();
  const len = trimmed.length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const trajectory = analyzeEmotionalTrajectory(message, recentHistory);
  const recentUserTurnCount = trajectory.recentUserTurns.length;
  const hasTrajectory = hasRecentEmotionalTrajectory(trajectory);

  if (CONTINUE.test(trimmed) || REDO_REQUEST.test(trimmed)) {
    return {
      depth: "brief",
      depthReason: "continue_redo",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  if (
    safetyCategory === "off_topic" ||
    safetyCategory === "boundary_pressure" ||
    safetyCategory === "medical_boundary" ||
    safetyCategory === "legal_financial_boundary"
  ) {
    return {
      depth: "brief",
      depthReason: "safety_brief",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  if (safetyCategory === "crisis") {
    return {
      depth: "deep",
      depthReason: "crisis",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  const recentUserText = trajectory.recentUserTurns.join(" ");
  const threadDepth =
    recentHistory.length >= 6 &&
    (recentUserText.length > 500 ||
      recentHistory.filter((m) => m.role === "user").length >= 4);

  const emotional = DEEP_EMOTIONAL.some(
    (p) => p.test(trimmed) || p.test(recentUserText)
  );
  const isLong = len >= 260 || words >= 48;

  if (emotional && (isLong || words >= 20)) {
    return {
      depth: "deep",
      depthReason: "long_emotional",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  if (threadDepth && emotional && !trajectory.shortAfterEmotional) {
    return {
      depth: "deep",
      depthReason: "thread_emotional",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  if (trajectory.uncertaintyInProcess) {
    return {
      depth: "medium",
      depthReason: "uncertainty_in_process",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  if (hasTrajectory) {
    return {
      depth: "medium",
      depthReason: "recent_emotional_trajectory",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: trajectory.emotionalMomentum,
    };
  }

  if (
    words <= 8 &&
    (BRIEF_GREETING.test(trimmed) ||
      BRIEF_THANKS.test(trimmed) ||
      BRIEF_SHORT.test(trimmed))
  ) {
    return {
      depth: "brief",
      depthReason: "greeting_short",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: false,
    };
  }

  if (len < 40) {
    return {
      depth: "brief",
      depthReason: "short_neutral",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: false,
    };
  }

  if (len < 100 && words < 18) {
    return {
      depth: "brief",
      depthReason: "short_neutral",
      recentUserTurns: recentUserTurnCount,
      emotionalMomentum: false,
    };
  }

  return {
    depth: "medium",
    depthReason: "default_medium",
    recentUserTurns: recentUserTurnCount,
    emotionalMomentum: trajectory.emotionalMomentum,
  };
}

export function detectResponseDepth(
  message: string,
  safetyCategory: SafetyCategory,
  recentHistory: ChatTurn[]
): ResponseDepth {
  return analyzeResponseDepth(message, safetyCategory, recentHistory).depth;
}
