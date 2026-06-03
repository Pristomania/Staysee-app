/**
 * StaySee — Conversation stance (internal).
 * Picks one micro-approach per turn: support, clarify, or gentle bridge to live people.
 * Never exposed to the user by name.
 */

import type { SafetyCategory } from "./safety.ts";
import { userFrustrationAtBot } from "./boundaryFallback.ts";
import { userSignalsLanguageBoundary } from "./languageGuard.ts";

export type ConversationStance =
  | "repair_contact"
  | "memory_repair"
  | "factual_clarification"
  | "recall"
  | "redo"
  | "contain"
  | "ground"
  | "reflect"
  | "clarify"
  | "mirror"
  | "direction"
  | "bridge_live"
  | "joy"
  | "pause_rumination"
  | "boundary_hold";

export interface StanceResult {
  stance: ConversationStance;
  systemGuidance: string;
}

export interface StanceInput {
  message: string;
  safetyCategory: SafetyCategory;
  recentHistory: Array<{ role: string; content: string }>;
  hasCorrections?: boolean;
  insistenceLoop?: boolean;
  threadEscalated?: boolean;
}

const STANCE_GUIDANCE: Record<ConversationStance, string> = {
  repair_contact:
    "РЕЖИМ: восстановление контакта. Признай без оправданий, коротко. Не повторяй ранящее и не повторяй одну и ту же отбивку («готовые куски», «своими словами»). Без длинного анализа.",
  memory_repair:
    "РЕЖИМ: ошибка памяти. Признай, что додумала или пересказала лишнее. Не защищай старый ответ. Не спорь «я не придумала». Одно–два предложения + попроси её слова по теме.",
  factual_clarification:
    "РЕЖИМ: она поправляет факты (не просит разбор). Коротко принять: «Поняла» / «Да, так». Пересказать её факты её словами — 1–2 предложения. ЗАПРЕЩЕНО: интерпретации («как для галочки», «неразрешённость», «груз», «одиночество», «мостик»), психологизировать, додумывать мотивы. Не больше 3 предложений. Вопрос — только один мягкий уточняющий, если уместен; не обязателен.",
  recall:
    "РЕЖИМ: вопрос «помнишь». Только её слова из цитат/архива. Несколько тем в чате — не сливай: ссора отдельно от других линий. Свежие цитаты важнее старых. Если нет дословных слов — так и скажи.",
  redo:
    "РЕЖИМ: «ещё раз». Спроси одним предложением, что переделать (тон, факты, весь ответ). Не повторяй лекцию списком. Один связный абзац 2–4 предложения. Не задавай вопрос и не отвечай «Да.» самой себе.",
  contain:
    "РЕЖИМ: контейнирование. Одна гипотеза чувства с «так?» или короткое присутствие. Без теории.",
  ground:
    "РЕЖИМ: заземление. Здесь-и-сейчас: слова или одна телесная опора (дыхание, стопы, что в теле). Не весь ответ про тело. Без интерпретации.",
  reflect:
    "РЕЖИМ: отражение. Гипотеза оттенка с проверкой («похоже на X — так?»). Не утверждай. Макс. один вопрос.",
  clarify:
    "РЕЖИМ: прояснение. Факт / мысль / чувство — её словами. Интервенция «так / не так» если уместно.",
  mirror:
    "РЕЖИМ: мягкое зеркало. Противоречие из её фраз + «верно?» / «так слышишь?». Без психоаналитического объяснения.",
  direction:
    "РЕЖИМ: направление (без «терапия/альянс»). Куда ей важно — её словами, один вопрос.",
  bridge_live:
    "РЕЖИМ: мост к живым. Один маленький шаг с реальным человеком из контекста; отказ принять.",
  joy: "РЕЖИМ: радость. Не анализируй сразу, коротко раздели.",
  pause_rumination:
    "РЕЖИМ: петля в чате. Мягко назови круг; выбор — ещё здесь или один шаг в жизни.",
  boundary_hold:
    "РЕЖИМ: давление (угроза, подкуп, торг «иначе…»). Не сдавайся: без диагноза, лекарств, смены роли, готового текста. Риск вреда — 112/103, без обмена. 2–4 предложения: признай тяжесть, граница, один StaySee-вопрос.",
};

const JOY_PATTERNS = [
  /радост/i,
  /рада\b/i,
  /счастлив/i,
  /хорошая новость/i,
  /получилось/i,
  /удалось/i,
  /легче стало/i,
];

const DIRECTION_PATTERNS = [
  /куда (мне |дальше|теперь)/i,
  /что (мне )?делать/i,
  /как быть/i,
  /не знаю как/i,
  /хочу (понять|разобраться|ясн)/i,
  /к чему это/i,
];

const BRIDGE_READY_PATTERNS = [
  /готова попробовать/i,
  /попробую/i,
  /напишу ему/i,
  /напишу ей/i,
  /позвоню/i,
  /скажу ему/i,
  /скажу ей/i,
  /может сказать/i,
];

const OVERLOAD_PATTERNS = [
  /не могу/i,
  /не выдерживаю/i,
  /на пределе/i,
  /всё смешалось/i,
  /каша в голове/i,
  /перегруз/i,
];

const RECALL_PATTERNS = [
  /помнишь/i,
  /помните/i,
  /что я (?:говорила|рассказывала|писала)/i,
  /вчера (?:я )?рассказывала/i,
  /рассказывала вчера/i,
  /мы говорили/i,
  /напомни,? что/i,
];

const FACTUAL_CORRECTION_PATTERNS = [
  /^нет\b/i,
  /^не[\s,]/i,
  /не так/i,
  /на самом деле/i,
  /вообще-то/i,
  /это не то/i,
  /ты (?:не )?прав/i,
  /перепутал/i,
  /перепутала/i,
  /уточняю/i,
  /поправлю/i,
  /имела в виду/i,
  /без обсуждения/i,
  /просто о делах/i,
  /поговорили по телефону/i,
  /позвонили/i,
  /созвонились/i,
  /на следующий день/i,
  /было иначе/i,
  /не про это/i,
];

const MEMORY_ACCUSATION_PATTERNS = [
  /придумал/i,
  /придумала/i,
  /выдумал/i,
  /выдумала/i,
  /фантаз/i,
  /не было/i,
  /не говорила/i,
  /ты это придум/i,
  /додумал/i,
  /додумала/i,
];

const MIRROR_PATTERNS = [
  /с одной стороны/i,
  /с другой стороны/i,
  /говорю что .+ но/i,
  /вроде отпустила/i,
  /не важно, но/i,
];

const REDO_PATTERNS = [
  /давай\s+(ещ[её]\s+)?раз/i,
  /^ещ[её]\s+раз\b/i,
  /повтори\b/i,
  /по-новому/i,
  /заново/i,
  /переформулируй/i,
  /скажи иначе/i,
];

const CORRECTION_NOW = [
  /ты (не )?прав/i,
  /ты (не )?права/i,
  /не так/i,
  /не об этом/i,
  /не про это/i,
  /выбил/i,
  /обидел/i,
  /недопустим/i,
];

const RUMINATION_KEYWORDS = [
  "страх",
  "контрол",
  "сын",
  "арми",
  "племян",
  "тяжел",
  "больно",
  "одинок",
  "злость",
  "обид",
  "развод",
  "муж",
  "жена",
];

function recentUserTexts(
  history: Array<{ role: string; content: string }>,
  current: string,
  n = 4
): string[] {
  const fromHist = history
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .slice(-n);
  return [...fromHist, current.trim()].filter(Boolean);
}

function detectRuminationLoop(userTexts: string[]): boolean {
  if (userTexts.length < 3) return false;
  const longOnes = userTexts.filter((t) => t.length >= 60);
  if (longOnes.length < 3) return false;

  const hitCounts = RUMINATION_KEYWORDS.map((kw) =>
    longOnes.filter((t) => t.toLowerCase().includes(kw)).length
  );
  const recurring = hitCounts.filter((c) => c >= 2).length;
  return recurring >= 2;
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function evaluateStance(input: StanceInput): StanceResult {
  const msg = input.message.trim();
  const userTexts = recentUserTexts(input.recentHistory, msg);

  if (userFrustrationAtBot(msg)) {
    return { stance: "repair_contact", systemGuidance: STANCE_GUIDANCE.repair_contact };
  }

  if (userSignalsLanguageBoundary(msg) || matches(msg, CORRECTION_NOW)) {
    return { stance: "repair_contact", systemGuidance: STANCE_GUIDANCE.repair_contact };
  }

  if (
    input.hasCorrections &&
    /ошиб|сбил|запутал|не так|не верно|поймал|поймала|выбил|обидел/i.test(msg)
  ) {
    return { stance: "repair_contact", systemGuidance: STANCE_GUIDANCE.repair_contact };
  }

  if (matches(msg, MEMORY_ACCUSATION_PATTERNS)) {
    return { stance: "memory_repair", systemGuidance: STANCE_GUIDANCE.memory_repair };
  }

  if (matches(msg, FACTUAL_CORRECTION_PATTERNS)) {
    return {
      stance: "factual_clarification",
      systemGuidance: STANCE_GUIDANCE.factual_clarification,
    };
  }

  if (matches(msg, RECALL_PATTERNS)) {
    return { stance: "recall", systemGuidance: STANCE_GUIDANCE.recall };
  }

  if (matches(msg, REDO_PATTERNS)) {
    return { stance: "redo", systemGuidance: STANCE_GUIDANCE.redo };
  }

  if (
    !userFrustrationAtBot(msg) &&
    (input.insistenceLoop ||
      input.threadEscalated ||
      input.safetyCategory === "boundary_pressure" ||
      input.safetyCategory === "off_topic")
  ) {
    return { stance: "boundary_hold", systemGuidance: STANCE_GUIDANCE.boundary_hold };
  }

  if (input.safetyCategory === "dependency_risk") {
    return { stance: "bridge_live", systemGuidance: STANCE_GUIDANCE.bridge_live };
  }

  if (input.safetyCategory === "crisis") {
    return { stance: "contain", systemGuidance: STANCE_GUIDANCE.contain };
  }

  if (matches(msg, JOY_PATTERNS)) {
    return { stance: "joy", systemGuidance: STANCE_GUIDANCE.joy };
  }

  if (detectRuminationLoop(userTexts)) {
    return {
      stance: "pause_rumination",
      systemGuidance: STANCE_GUIDANCE.pause_rumination,
    };
  }

  if (matches(msg, BRIDGE_READY_PATTERNS)) {
    return { stance: "bridge_live", systemGuidance: STANCE_GUIDANCE.bridge_live };
  }

  if (matches(msg, DIRECTION_PATTERNS)) {
    return { stance: "direction", systemGuidance: STANCE_GUIDANCE.direction };
  }

  if (matches(msg, OVERLOAD_PATTERNS) || (msg.length < 50 && /устал|устала|страшно|плохо/i.test(msg))) {
    return { stance: "ground", systemGuidance: STANCE_GUIDANCE.ground };
  }

  if (matches(msg, MIRROR_PATTERNS)) {
    return { stance: "mirror", systemGuidance: STANCE_GUIDANCE.mirror };
  }

  if (msg.length >= 200 || userTexts.filter((t) => t.length >= 120).length >= 2) {
    return { stance: "clarify", systemGuidance: STANCE_GUIDANCE.clarify };
  }

  if (msg.length < 35) {
    return { stance: "contain", systemGuidance: STANCE_GUIDANCE.contain };
  }

  return { stance: "reflect", systemGuidance: STANCE_GUIDANCE.reflect };
}
