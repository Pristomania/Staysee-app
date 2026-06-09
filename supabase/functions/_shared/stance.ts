/**
 * StaySee — Conversation stance (internal).
 * Picks one micro-approach per turn: support, clarify, or gentle step toward life.
 * Never exposed to the user by name.
 */

import type { SafetyCategory } from "./safety.ts";
import { userFrustrationAtBot } from "./boundaryFallback.ts";
import { userSignalsLanguageBoundary } from "./languageGuard.ts";
import { hasMetaRepairIntent } from "./metaRepair.ts";

export type ConversationStance =
  | "repair_contact"
  | "memory_repair"
  | "factual_clarification"
  | "recall"
  | "redo"
  | "writing_repair"
  | "contain"
  | "named_presence"
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
    "РЕЖИМ: ошибка памяти. Признай, что додумала или пересказала лишнее. Не защищай старый ответ. Не спорь «я не придумала». Одно–два предложения + попроси слова человека по теме.",
  factual_clarification:
    "РЕЖИМ: человек поправляет факты (не просит разбор). Коротко принять: «Поняла» / «Да, так». Пересказать факты словами человека — 1–2 предложения. ЗАПРЕЩЕНО: интерпретации («как для галочки», «неразрешённость», «груз», «одиночество», «мостик»), психологизировать, додумывать мотивы. Не больше 3 предложений. Вопрос — только один мягкий уточняющий, если уместен; не обязателен.",
  recall:
    "РЕЖИМ: вопрос «помнишь». Только слова человека из цитат/архива. Несколько тем в чате — не сливай: ссора отдельно от других линий. Свежие цитаты важнее старых. Если нет дословных слов — так и скажи.",
  redo:
    "РЕЖИМ: «ещё раз». Спроси одним предложением, что переделать (тон, факты, весь ответ). Не повторяй лекцию списком. Один связный абзац 2–4 предложения. Не задавай вопрос и не отвечай «Да.» самой себе.",
  writing_repair:
    "РЕЖИМ: человек просит исправить формулировку последнего твоего ответа (опечатки, склейки, обрыв), а не новый психологический разбор. Перепиши последнюю реплику ассистента из истории чистым русским: 2–4 предложения, без markdown. Сохрани смысл и тон. Если дословно не видно — попроси процитировать фрагмент одним коротким вопросом.",
  contain:
    "РЕЖИМ: контейнирование. Одна гипотеза чувства с «так?» или короткое присутствие. Без теории.",
  named_presence:
    "РЕЖИМ: короткая реплика с уже названным чувством или состоянием. Используй слово человека — не добавляй новый оттенок. ЗАПРЕЩЕНО без её слов: тяжело, пусто, болезненно, перегруз, волна, напряжение, «настоящая», метафоры. 1–2 предложения, макс. один вопрос. Вопрос уточняет качество её словами, не новую эмоцию: «Какая эта грусть сейчас?» · «Злость — про что она сейчас?» · «Тревога больше в теле или в мыслях?» · «Усталость физическая, эмоциональная или всё сразу?» · «Можно пока и не знать.» — по смыслу реплики. Если чувство уже названо — без гипотезы «похоже на X — так?».",
  ground:
    "РЕЖИМ: заземление. Здесь-и-сейчас: слова или одна телесная опора (дыхание, стопы, что в теле). Не весь ответ про тело. Без интерпретации.",
  reflect:
    "РЕЖИМ: отражение. Гипотеза оттенка с проверкой («похоже на X — так?»). Не утверждай. Макс. один вопрос.",
  clarify:
    "РЕЖИМ: прояснение. Факт / мысль / чувство — словами человека. Интервенция «так / не так» если уместно.",
  mirror:
    "РЕЖИМ: мягкое зеркало. Противоречие из фраз человека + «верно?» / «так слышишь?». Без психоаналитического объяснения.",
  direction:
    "РЕЖИМ: направление (без «терапия/альянс»). Куда важно — словами человека, один вопрос.",
  bridge_live:
    "РЕЖИМ: шаг в жизнь. Один маленький вариант из контекста — к себе, чувству, телу, выбору, действию или отношению (в том числе с человеком, если это естественно вытекает из контекста); отказ принять.",
  joy: "РЕЖИМ: радость. Не анализируй сразу, коротко раздели.",
  pause_rumination:
    "РЕЖИМ: петля в чате. Мягко назови круг; выбор — ещё здесь или один шаг в жизнь (не обязательно связанный с другими людьми).",
  boundary_hold:
    "РЕЖИМ: давление (угроза, подкуп, торг «иначе…»). Не сдавайся: без диагноза, лекарств, смены роли, готового текста. Риск вреда — 112/103, без обмена. 2–4 предложения: признай тяжесть, граница, один StaySee-вопрос.",
};

const JOY_PATTERNS = [
  /радост/i,
  /рада\b/i,
  /рад\b/i,
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
  /готов попробовать/i,
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

/** Явные маркеры перегруза/тела — ground уместен даже на короткой реплике. */
const GROUND_EXPLICIT_PATTERNS = [
  /тело/i,
  /дыхан/i,
  /паник/i,
  /тряс/i,
  /не\s+могу/i,
  /на\s+пределе/i,
  /перегруз/i,
];

const RECALL_PATTERNS = [
  /помнишь/i,
  /помните/i,
  /что я (?:говорил|говорила|рассказывал|рассказывала|писал|писала)/i,
  /вчера (?:я )?рассказывал/i,
  /вчера (?:я )?рассказывала/i,
  /рассказывал вчера/i,
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
  /ты (?:не )?права/i,
  /перепутал/i,
  /перепутала/i,
  /уточняю/i,
  /поправлю/i,
  /имел в виду/i,
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
  /не говорил/i,
  /не говорила/i,
  /ты это придум/i,
  /додумал/i,
  /додумала/i,
];

const MIRROR_PATTERNS = [
  /с одной стороны/i,
  /с другой стороны/i,
  /говорю что .+ но/i,
  /вроде отпустил/i,
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

const NAMED_EMOTION_MARKERS = [
  /грустн/i,
  /грусть/i,
  /злюс/i,
  /злость/i,
  /тревожн/i,
  /тревог/i,
  /устал/i,
  /усталост/i,
  /страшн/i,
  /боюсь/i,
  /хорошо/i,
  /радостн/i,
  /спокойн/i,
  /(?:^|\s)плохо(?:\s|$|[.!?,])/i,
  /(?:^|\s)не\s+знаю(?:\s|$|[.!?,])/i,
];

function isShortNamedEmotion(msg: string): boolean {
  const t = msg.trim();
  if (t.length >= 35) return false;
  return NAMED_EMOTION_MARKERS.some((p) => p.test(t));
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

  if (hasMetaRepairIntent(msg)) {
    return {
      stance: "writing_repair",
      systemGuidance: STANCE_GUIDANCE.writing_repair,
    };
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

  if (matches(msg, OVERLOAD_PATTERNS) || matches(msg, GROUND_EXPLICIT_PATTERNS)) {
    return { stance: "ground", systemGuidance: STANCE_GUIDANCE.ground };
  }

  if (isShortNamedEmotion(msg)) {
    return { stance: "named_presence", systemGuidance: STANCE_GUIDANCE.named_presence };
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
