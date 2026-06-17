/**
 * Emotional trajectory analysis for response depth routing.
 * Pure logic — no Supabase / Deno imports (testable under Node).
 */

export type ResponseDepth = "brief" | "medium" | "deep";

export type DepthReason =
  | "safety_brief"
  | "crisis"
  | "greeting_short"
  | "short_neutral"
  | "uncertainty_in_process"
  | "explicit_closure"
  | "recent_emotional_trajectory"
  | "emotional_momentum_deep"
  | "long_emotional"
  | "thread_emotional"
  | "default_medium"
  | "open_figure"
  | "open_figure_momentum"
  | "open_figure_uncertainty";

export type OpenFigureKind =
  | "emotional"
  | "relational"
  | "body"
  | "identity"
  | "choice"
  | "unknown";

export type OpenFigureIntensity = "low" | "medium" | "high";

export type OpenFigureConfidence = "low" | "medium" | "high";

export type OpenFigureTrigger =
  | "short_emotional"
  | "strong_uncertainty"
  | "arc_continuation"
  | "emotional_momentum"
  | "relational_charge"
  | "none";

export interface OpenFigureState {
  isOpen: boolean;
  kind: OpenFigureKind;
  intensity: OpenFigureIntensity;
  confidence: OpenFigureConfidence;
  trigger: OpenFigureTrigger;
  evidence: string[];
}

export const CLOSED_OPEN_FIGURE: OpenFigureState = {
  isOpen: false,
  kind: "unknown",
  intensity: "low",
  confidence: "low",
  trigger: "none",
  evidence: [],
};

export type SafetyCategory =
  | "normal"
  | "crisis"
  | "off_topic"
  | "boundary_pressure"
  | "medical_boundary"
  | "legal_financial_boundary"
  | "prompt_attack"
  | "dependency_risk";

export type ChatTurn = { role: string; content: string };

export interface ResponseDepthAnalysis {
  depth: ResponseDepth;
  depthReason: DepthReason;
  recentUserTurns: number;
  emotionalMomentum: boolean;
  openFigure: OpenFigureState;
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

/** Farewell / explicit exit — whole message or trailing clause after comma. */
const EXPLICIT_CLOSURE_PATTERNS: RegExp[] = [
  /^пока$/iu,
  /^на\s+сегодня\s+хватит$/iu,
  /^на\s+сегодня\s+вс[её]$/iu,
  /^не\s+хочу\s+сейчас\s+говорить$/iu,
  /^оставим$/iu,
  /^закроем\s+тему$/iu,
  /^пора\s+бежать$/iu,
  /^побежала$/iu,
  /^я\s+побежала$/iu,
  /^побежал$/iu,
  /^я\s+побежал$/iu,
  /^убегаю$/iu,
  /^я\s+убегаю$/iu,
  /^надо\s+идти$/iu,
  /^мне\s+надо\s+идти$/iu,
  /^пойду$/iu,
  /^я\s+пойду$/iu,
  /^пойду\s+спать$/iu,
  /^я\s+пойду\s+спать$/iu,
  /^пойду\s+работать$/iu,
  /^я\s+пойду\s+работать$/iu,
  /^пойду\s+поработаю$/iu,
  /^я\s+пойду\s+поработаю$/iu,
  /^пойду\s+чай\s+пить$/iu,
  /^я\s+пойду\s+чай\s+пить$/iu,
  /^ладно,?\s+пойду$/iu,
  /^ладно,?\s+я\s+пойду$/iu,
  /^ладно,?\s+пойду\s+чай\s+пить$/iu,
  /^до\s+связи$/iu,
  /^увидимся$/iu,
  /^мне\s+достаточно$/iu,
  /^достаточно$/iu,
  /^до\s+завтра$/iu,
  /^вс[её],?\s+я\s+ушла$/iu,
  /^вс[её],?\s+я\s+ушел$/iu,
  /^вс[её],?\s+я\s+ушёл$/iu,
  /^вс[её],?\s+я\s+пошла$/iu,
  /^вс[её],?\s+я\s+пошел$/iu,
  /^вс[её],?\s+я\s+пошёл$/iu,
];

/** Strong uncertainty — may trigger in-process even without prior arc. */
const STRONG_UNCERTAINTY_PHRASE_PATTERNS: RegExp[] = [
  /^(?:даже\s+)?(?:я\s+)?не\s*знаю$/iu,
  /^(?:я\s+)?пока\s+не\s*знаю$/iu,
  /^(?:да\s+)?(?:вот\s+)?(?:я\s+)?(?:и\s+)?не\s*знаю$/iu,
  /^пока\s+не\s+понятно$/iu,
  /^пока\s+непонятно$/iu,
  /^непонятно$/iu,
  /^сложно\s+сказать$/iu,
  /^(?:я\s+)?не\s+могу\s+понять$/iu,
  /^(?:я\s+)?не\s+понимаю\s+пока$/iu,
  /^сложно\s+понять$/iu,
  /^неясно$/iu,
  /^(?:я\s+)?не\s+чувствую(?:\s+пока)?$/iu,
  /^(?:я\s+)?не\s+могу\s+почувствовать$/iu,
  /^(?:я\s+)?запуталась$/iu,
  /^(?:я\s+)?запутался$/iu,
  /^(?:я\s+)?не\s+уверена$/iu,
  /^(?:я\s+)?не\s+уверен$/iu,
];

/** Soft uncertainty — needs substantive prior arc. */
const SOFT_UNCERTAINTY_PHRASE_PATTERNS: RegExp[] = [
  /^наверное$/iu,
  /^может\s+быть$/iu,
  /^посмотрим$/iu,
  /^странно$/iu,
];

function normalizeUncertaintyCandidate(message: string): string {
  return message.trim().replace(/\s+/g, " ").replace(/[.!?…]+$/u, "").trim();
}

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function closureClauseMatches(text: string): boolean {
  return matchesAnyPattern(text, EXPLICIT_CLOSURE_PATTERNS);
}

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

/** Short emotional charge — whole message or prominent substring. */
const SHORT_EMOTIONAL_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^(?:мне\s+)?устал[ао]?$/iu, label: "усталость" },
  { pattern: /^(?:мне\s+)?страшно$/iu, label: "страх" },
  { pattern: /^страшно$/iu, label: "страх" },
  { pattern: /^больно$/iu, label: "боль" },
  { pattern: /^тяжело$/iu, label: "тяжесть" },
  { pattern: /^пусто$/iu, label: "пустота" },
  { pattern: /^не\s+могу$/iu, label: "не_могу" },
  { pattern: /мне\s+страшно/i, label: "страх" },
  { pattern: /мне\s+больно/i, label: "боль" },
  { pattern: /мне\s+тяжело/i, label: "тяжесть" },
  { pattern: /мне\s+плохо/i, label: "плохо" },
  { pattern: /не\s+выдерживаю/i, label: "перегруз" },
  { pattern: /на\s+пределе/i, label: "перегруз" },
  { pattern: /опять\s+сорвал/i, label: "срыв" },
  { pattern: /я\s+злюсь/i, label: "злость" },
  { pattern: /мне\s+грустно/i, label: "грусть" },
];

const STRONG_UNCERTAINTY_INFIX: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /не\s+знаю\s+что\s+делать/i, label: "не_знаю_что_делать" },
  { pattern: /не\s+понимаю/i, label: "не_понимаю" },
  { pattern: /запуталась/i, label: "запуталась" },
  { pattern: /запутался/i, label: "запутался" },
];

const RELATIONAL_CHARGE_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /молчит/i, label: "молчание" },
  { pattern: /не\s+отвечает/i, label: "нет_ответа" },
  { pattern: /поссорил/i, label: "ссора" },
  { pattern: /поругал/i, label: "ссора" },
  { pattern: /ушла/i, label: "уход" },
  { pattern: /ушёл/i, label: "уход" },
  { pattern: /ушел/i, label: "уход" },
  { pattern: /бросил/i, label: "уход" },
  { pattern: /игнорир/i, label: "игнор" },
];

const DEPTH_RANK: Record<ResponseDepth, number> = {
  brief: 0,
  medium: 1,
  deep: 2,
};

function maxDepth(a: ResponseDepth, b: ResponseDepth): ResponseDepth {
  return DEPTH_RANK[a] >= DEPTH_RANK[b] ? a : b;
}

function matchMarkers(
  text: string,
  markers: Array<{ pattern: RegExp; label: string }>
): string[] {
  return markers.filter((m) => m.pattern.test(text)).map((m) => m.label);
}

function detectShortEmotional(text: string): string[] {
  const normalized = normalizeUncertaintyCandidate(text);
  const hits = matchMarkers(normalized, SHORT_EMOTIONAL_MARKERS);
  if (hits.length > 0) return hits;
  if (normalized.length <= 40 && turnHasEmotionalSignal(normalized)) {
    return ["emotional_signal"];
  }
  return [];
}

function detectStrongUncertaintyInfix(text: string): string[] {
  const normalized = normalizeUncertaintyCandidate(text);
  if (isStrongUncertaintyPhrase(normalized)) {
    return ["strong_uncertainty_phrase"];
  }
  return matchMarkers(normalized, STRONG_UNCERTAINTY_INFIX);
}

function detectRelationalCharge(text: string): string[] {
  return matchMarkers(text, RELATIONAL_CHARGE_MARKERS);
}

function inferOpenFigureKind(
  emotional: string[],
  relational: string[],
  uncertainty: string[]
): OpenFigureKind {
  if (relational.length > 0) return "relational";
  if (uncertainty.length > 0) return "choice";
  if (emotional.some((e) => /перегруз|не_могу|плохо|усталость/i.test(e))) {
    return "body";
  }
  if (emotional.some((e) => /срыв|грусть|злость|страх/i.test(e))) {
    return "emotional";
  }
  if (emotional.length > 0) return "emotional";
  return "unknown";
}

function inferOpenFigureIntensity(
  trigger: OpenFigureTrigger,
  trajectory: EmotionalTrajectory,
  distressMarkers: number,
  safetyCategory: SafetyCategory
): OpenFigureIntensity {
  if (safetyCategory === "crisis") return "high";
  if (trigger === "relational_charge") return "high";
  if (trigger === "emotional_momentum" && trajectory.recentUserTurns.length >= 3) {
    return "high";
  }
  if (trigger === "strong_uncertainty" || trigger === "short_emotional") {
    return distressMarkers >= 2 ? "high" : "medium";
  }
  if (trigger === "arc_continuation") return "medium";
  return "low";
}

function inferOpenFigureConfidence(
  evidenceCount: number,
  text: string
): OpenFigureConfidence {
  if (evidenceCount >= 3 || text.length >= 48) return "high";
  if (evidenceCount >= 2 || text.length >= 24) return "medium";
  return "low";
}

export interface AnalyzeOpenFigureInput {
  message: string;
  recentHistory: ChatTurn[];
  safetyCategory: SafetyCategory;
  trajectory: EmotionalTrajectory;
}

export function analyzeOpenFigure(input: AnalyzeOpenFigureInput): OpenFigureState {
  const trimmed = input.message.trim();
  if (!trimmed || isExplicitConversationClosure(trimmed)) {
    return CLOSED_OPEN_FIGURE;
  }

  if (
    input.safetyCategory === "off_topic" ||
    input.safetyCategory === "boundary_pressure" ||
    input.safetyCategory === "medical_boundary"
  ) {
    return CLOSED_OPEN_FIGURE;
  }

  const priorTurns = input.trajectory.recentUserTurns.slice(0, -1);
  const emotionalHits = detectShortEmotional(trimmed);
  const uncertaintyHits = detectStrongUncertaintyInfix(trimmed);
  const relationalHits = detectRelationalCharge(trimmed);
  const arcContinuation =
    trimmed.length < 100 &&
    priorTurns.length > 0 &&
    hasSubstantivePriorArc(priorTurns) &&
    (turnHasEmotionalSignal(trimmed) ||
      input.trajectory.shortAfterEmotional ||
      uncertaintyHits.length > 0);

  const evidence = [
    ...emotionalHits,
    ...uncertaintyHits,
    ...relationalHits,
  ];
  if (arcContinuation) evidence.push("arc_continuation");
  if (input.trajectory.emotionalMomentum) evidence.push("emotional_momentum");

  let trigger: OpenFigureTrigger = "none";
  if (input.safetyCategory === "crisis") {
    trigger = "short_emotional";
    evidence.push("crisis");
  } else if (uncertaintyHits.length > 0) {
    trigger = "strong_uncertainty";
  } else if (relationalHits.length > 0) {
    trigger = "relational_charge";
  } else if (input.trajectory.emotionalMomentum) {
    trigger = "emotional_momentum";
  } else if (arcContinuation) {
    trigger = "arc_continuation";
  } else if (emotionalHits.length > 0) {
    trigger = "short_emotional";
  }

  if (trigger === "none") {
    return CLOSED_OPEN_FIGURE;
  }

  const kind = inferOpenFigureKind(emotionalHits, relationalHits, uncertaintyHits);
  const intensity = inferOpenFigureIntensity(
    trigger,
    input.trajectory,
    evidence.length,
    input.safetyCategory
  );
  const confidence = inferOpenFigureConfidence(evidence.length, trimmed);

  if (input.safetyCategory === "crisis") {
    return {
      isOpen: true,
      kind: kind === "unknown" ? "emotional" : kind,
      intensity: "high",
      confidence: "high",
      trigger,
      evidence,
    };
  }

  return {
    isOpen: true,
    kind,
    intensity,
    confidence,
    trigger,
    evidence,
  };
}

function openFigureDepthReason(
  trigger: OpenFigureTrigger,
  priorReason: DepthReason
): DepthReason {
  if (trigger === "strong_uncertainty") return "open_figure_uncertainty";
  if (trigger === "emotional_momentum") return "open_figure_momentum";
  if (priorReason === "uncertainty_in_process") return "uncertainty_in_process";
  if (priorReason === "recent_emotional_trajectory") {
    return "recent_emotional_trajectory";
  }
  return "open_figure";
}

function applyOpenFigureFloor(
  depth: ResponseDepth,
  depthReason: DepthReason,
  openFigure: OpenFigureState
): { depth: ResponseDepth; depthReason: DepthReason } {
  if (!openFigure.isOpen) {
    return { depth, depthReason };
  }

  const nextDepth = maxDepth(depth, "medium");
  let nextReason = depthReason;

  if (DEPTH_RANK[depth] < DEPTH_RANK.medium) {
    nextReason = openFigureDepthReason(openFigure.trigger, depthReason);
  }

  return { depth: nextDepth, depthReason: nextReason };
}

function buildAnalysis(
  depth: ResponseDepth,
  depthReason: DepthReason,
  trajectory: EmotionalTrajectory,
  openFigure: OpenFigureState
): ResponseDepthAnalysis {
  const floored = applyOpenFigureFloor(depth, depthReason, openFigure);
  return {
    depth: floored.depth,
    depthReason: floored.depthReason,
    recentUserTurns: trajectory.recentUserTurns.length,
    emotionalMomentum: trajectory.emotionalMomentum,
    openFigure,
  };
}


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

export function isExplicitConversationClosure(message: string): boolean {
  const t = normalizeUncertaintyCandidate(message);
  if (!t) return false;
  if (closureClauseMatches(t)) return true;

  const parts = t.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (closureClauseMatches(last)) return true;
  }
  return false;
}

export function isStrongUncertaintyPhrase(message: string): boolean {
  const t = normalizeUncertaintyCandidate(message);
  if (!t || isExplicitConversationClosure(t)) return false;
  return matchesAnyPattern(t, STRONG_UNCERTAINTY_PHRASE_PATTERNS);
}

export function isSoftUncertaintyPhrase(message: string): boolean {
  const t = normalizeUncertaintyCandidate(message);
  if (!t || isExplicitConversationClosure(t)) return false;
  return matchesAnyPattern(t, SOFT_UNCERTAINTY_PHRASE_PATTERNS);
}

export function isUncertaintyPhrase(message: string): boolean {
  return isStrongUncertaintyPhrase(message) || isSoftUncertaintyPhrase(message);
}

/** @deprecated alias */
export function isUncertaintyInProcessMessage(message: string): boolean {
  return isUncertaintyPhrase(message);
}

/** Prior user turns with emotional/substantive arc (not isolated uncertainty). */
export function hasSubstantivePriorArc(priorUserTurns: string[]): boolean {
  if (priorUserTurns.length === 0) return false;
  return priorUserTurns.some((t) => turnHasSubstantiveSignal(t));
}

function turnHasSubstantiveSignal(text: string): boolean {
  if (turnHasEmotionalSignal(text)) return true;
  const t = text.trim();
  if (t.length < 12 || BRIEF_GREETING.test(t) || BRIEF_SHORT.test(t)) return false;
  if (t.length >= 20) return true;
  return /по-новому|новому|непривычн|странн|интересн|сильно|думаю|чувств|муж|отношен|работ|тревог|грустн|злюсь|устал|боюсь|наблюд|голос|звучан|ночует|комнат|пространств/i.test(
    t
  );
}

function checkUncertaintyInProcess(
  message: string,
  priorUserTurns: string[]
): boolean {
  const trimmed = message.trim();
  if (isExplicitConversationClosure(trimmed)) return false;
  if (isStrongUncertaintyPhrase(trimmed)) return true;
  return (
    isSoftUncertaintyPhrase(trimmed) && hasSubstantivePriorArc(priorUserTurns)
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

  const uncertaintyInProcess = checkUncertaintyInProcess(trimmed, priorTurns);

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
  const openFigureInput = {
    message,
    recentHistory,
    safetyCategory,
    trajectory,
  };

  if (isExplicitConversationClosure(trimmed)) {
    return buildAnalysis(
      "brief",
      "explicit_closure",
      trajectory,
      CLOSED_OPEN_FIGURE
    );
  }

  if (
    safetyCategory === "off_topic" ||
    safetyCategory === "boundary_pressure" ||
    safetyCategory === "medical_boundary"
  ) {
    return buildAnalysis(
      "brief",
      "safety_brief",
      trajectory,
      CLOSED_OPEN_FIGURE
    );
  }

  if (safetyCategory === "crisis") {
    const openFigure = analyzeOpenFigure(openFigureInput);
    return buildAnalysis("deep", "crisis", trajectory, openFigure);
  }

  if (
    words <= 8 &&
    (BRIEF_GREETING.test(trimmed) ||
      BRIEF_THANKS.test(trimmed) ||
      BRIEF_SHORT.test(trimmed))
  ) {
    return buildAnalysis(
      "brief",
      "greeting_short",
      trajectory,
      CLOSED_OPEN_FIGURE
    );
  }

  const openFigure = analyzeOpenFigure(openFigureInput);

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
    return buildAnalysis("deep", "long_emotional", trajectory, openFigure);
  }

  if (threadDepth && emotional && !trajectory.shortAfterEmotional) {
    return buildAnalysis("deep", "thread_emotional", trajectory, openFigure);
  }

  if (trajectory.uncertaintyInProcess) {
    return buildAnalysis(
      "medium",
      "uncertainty_in_process",
      trajectory,
      openFigure
    );
  }

  if (hasRecentEmotionalTrajectory(trajectory)) {
    return buildAnalysis(
      "medium",
      "recent_emotional_trajectory",
      trajectory,
      openFigure
    );
  }

  if (len < 40) {
    return buildAnalysis("brief", "short_neutral", trajectory, openFigure);
  }

  if (len < 100 && words < 18) {
    return buildAnalysis("brief", "short_neutral", trajectory, openFigure);
  }

  return buildAnalysis("medium", "default_medium", trajectory, openFigure);
}

export function detectResponseDepth(
  message: string,
  safetyCategory: SafetyCategory,
  recentHistory: ChatTurn[]
): ResponseDepth {
  return analyzeResponseDepth(message, safetyCategory, recentHistory).depth;
}
