/**
 * Identity / Narrative Engine — life movement map for StaySee prompts.
 * Interprets conversation memory, weekly dynamics, cross-memory, and recent turns
 * into a hedged narrative layer (not facts, not new constraints).
 */

import type { StructuredMemory } from "./memory.ts";

export type ConversationSummary = StructuredMemory;

export interface WeeklyReflection {
  content: string;
  created_at?: string;
}

export interface UserMemoryRow {
  memory_type: string;
  content: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface NarrativeContext {
  currentSituation: string[];
  majorChanges: string[];
  recurringPatterns: string[];
  growthSignals: string[];
  paradoxes: string[];
}

const MAX_PER_FIELD = 4;
const MAX_RECENT_USER_LINES = 5;

const CHANGE_RE =
  /(?:впервые|начал[аиоё]?|переех|съех|опустел|пуст(ой|ая|ое)|появил|изменил|теперь|раньше|после|уже не|новый этап|другой человек|одна\b|один\b|ночует|ночёвк)/i;
const GROWTH_RE =
  /(?:границ|отдельн|свою комнат|выдерж|сохраня|выбира|без потери себя|не слива|береж|медленн|тихо|не спеш)/i;
const HEDGE_RE = /^(?:возможно|похоже|вероятно|может быть)\b/i;
const DIAGNOSTIC_RE =
  /(?:травм|созависим|нарцисс|диагноз|птср|расстройств|привязанност[ьи]\s+(?:травм|наруш))/i;

const PARADOX_PAIRS: Array<{ a: RegExp; b: RegExp; label: string }> = [
  {
    a: /близост/i,
    b: /(?:одиноч|дистанц|отдал)/i,
    label: "близости и дистанции",
  },
  {
    a: /(?:одиноч|одна\b|пуст(ой|ая))/i,
    b: /(?:близост|рядом|человек|мужчин|партн)/i,
    label: "одиночества и появления другого человека рядом",
  },
  {
    a: /(?:слияни|раствор)/i,
    b: /(?:границ|отдельн|сво[ёе] пространств)/i,
    label: "слияния и сохранения границ",
  },
  {
    a: /(?:свобод|автоном)/i,
    b: /(?:отношен|пар[аы]|близост)/i,
    label: "свободы и отношений",
  },
  {
    a: /(?:контрол|управля)/i,
    b: /(?:довер|неопредел|отпуск)/i,
    label: "контроля и доверия неопределённости",
  },
  {
    a: /(?:страх).{0,24}(?:близост|слияни)/i,
    b: /(?:страх).{0,24}(?:одиноч|пуст)/i,
    label: "страха близости и страха одиночества",
  },
];

function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSimilar(a: string, b: string): boolean {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 14 && kb.length >= 14 && (ka.includes(kb) || kb.includes(ka))) {
    return true;
  }
  return false;
}

function dedupeItems(items: string[], max = MAX_PER_FIELD): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || DIAGNOSTIC_RE.test(t)) continue;
    if (out.some((x) => isSimilar(x, t))) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function hedge(text: string, variant: "possible" | "likely" | "probable" = "likely"): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || HEDGE_RE.test(t)) return t;
  const prefix =
    variant === "possible"
      ? "Возможно, "
      : variant === "probable"
        ? "Вероятно, "
        : "Похоже, ";
  const lower = t.charAt(0).toLowerCase() + t.slice(1);
  return `${prefix}${lower}`;
}

function asNarrativePhrase(text: string, factual = false): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || DIAGNOSTIC_RE.test(t)) return "";
  if (factual) return t;
  return hedge(t);
}

function recentUserLines(messages: ChatMessage[] | undefined): string[] {
  if (!messages?.length) return [];
  const lines: string[] = [];
  for (let i = messages.length - 1; i >= 0 && lines.length < MAX_RECENT_USER_LINES; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.replace(/\s+/g, " ").trim();
    if (t.length >= 8) lines.unshift(t);
  }
  return lines;
}

function splitWeeklyPhrases(text: string): string[] {
  return text
    .split(/[\n.;]+/)
    .map((p) => p.replace(/^[\s\-–—]+/, "").trim())
    .filter((p) => p.length >= 10);
}

function compareWeeklies(newer: string, older: string): string[] {
  const newerPhrases = splitWeeklyPhrases(newer);
  const olderPhrases = splitWeeklyPhrases(older);
  const changes: string[] = [];
  for (const phrase of newerPhrases) {
    const inOlder = olderPhrases.some((o) => isSimilar(phrase, o));
    if (!inOlder && CHANGE_RE.test(phrase)) changes.push(phrase);
  }
  return changes;
}

function collectCorpus(args: {
  summary?: ConversationSummary;
  weekly?: WeeklyReflection[];
  crossMemory?: UserMemoryRow[];
  recentMessages?: ChatMessage[];
}): string {
  const chunks: string[] = [];
  const s = args.summary;
  if (s) {
    chunks.push(...s.themes, ...s.emotional_state, ...s.important_events, ...s.open_loops);
  }
  for (const w of args.weekly ?? []) chunks.push(w.content);
  for (const row of args.crossMemory ?? []) chunks.push(row.content);
  for (const line of recentUserLines(args.recentMessages)) chunks.push(line);
  return chunks.join("\n");
}

function extractCurrentSituation(args: {
  summary?: ConversationSummary;
  weekly?: WeeklyReflection[];
  crossMemory?: UserMemoryRow[];
  recentMessages?: ChatMessage[];
}): string[] {
  const items: string[] = [];
  const userLines = recentUserLines(args.recentMessages);

  for (const line of userLines.slice(-3)) {
    if (CHANGE_RE.test(line) || /(?:сейчас|сегодня|вчера|эта неделя)/i.test(line)) {
      items.push(asNarrativePhrase(`сейчас в её словах: ${line}`, false));
    }
  }

  const events = args.summary?.important_events ?? [];
  for (const ev of events.slice(-2)) {
    items.push(asNarrativePhrase(`в жизни отмечено: ${ev}`));
  }

  for (const state of (args.summary?.emotional_state ?? []).slice(-2)) {
    items.push(asNarrativePhrase(`по ощущению сейчас: ${state}`));
  }

  for (const row of args.crossMemory ?? []) {
    if (row.memory_type === "life_context") {
      items.push(asNarrativePhrase(`из устойчивого контекста: ${row.content}`));
    }
  }

  const latestWeekly = args.weekly?.[0]?.content?.trim();
  if (latestWeekly) {
    const lead = splitWeeklyPhrases(latestWeekly)[0];
    if (lead) items.push(asNarrativePhrase(`динамика недели: ${lead}`, "probable"));
  }

  return dedupeItems(items);
}

function extractMajorChanges(args: {
  summary?: ConversationSummary;
  weekly?: WeeklyReflection[];
  recentMessages?: ChatMessage[];
}): string[] {
  const items: string[] = [];

  for (const ev of args.summary?.important_events ?? []) {
    if (CHANGE_RE.test(ev)) items.push(asNarrativePhrase(`изменение: ${ev}`));
  }

  for (const loop of args.summary?.open_loops ?? []) {
    if (CHANGE_RE.test(loop)) items.push(asNarrativePhrase(`переход в открытой линии: ${loop}`));
  }

  for (const line of recentUserLines(args.recentMessages)) {
    if (CHANGE_RE.test(line)) {
      items.push(asNarrativePhrase(`в недавних словах — сдвиг: ${line}`));
    }
  }

  const weeklies = args.weekly ?? [];
  if (weeklies.length >= 2) {
    for (const phrase of compareWeeklies(weeklies[0]!.content, weeklies[1]!.content)) {
      items.push(asNarrativePhrase(`между неделями: ${phrase}`, "probable"));
    }
  } else if (weeklies[0]?.content) {
    for (const phrase of splitWeeklyPhrases(weeklies[0].content)) {
      if (CHANGE_RE.test(phrase)) items.push(asNarrativePhrase(phrase, "probable"));
    }
  }

  return dedupeItems(items);
}

function extractRecurringPatterns(args: {
  summary?: ConversationSummary;
  weekly?: WeeklyReflection[];
}): string[] {
  const items: string[] = [];
  const themes = args.summary?.themes ?? [];
  for (const theme of themes) {
    items.push(asNarrativePhrase(`возвращается тема: ${theme}`));
  }

  for (const loop of args.summary?.open_loops ?? []) {
    items.push(asNarrativePhrase(`незавершённая линия: ${loop}`));
  }

  const weeklies = args.weekly ?? [];
  if (weeklies.length >= 2 && themes.length > 0) {
    const texts = weeklies.map((w) => w.content);
    for (const theme of themes) {
      const hits = texts.filter(
        (t) => isSimilar(theme, t) || normalizeKey(t).includes(normalizeKey(theme))
      );
      if (hits.length >= 2) {
        items.push(
          asNarrativePhrase(`тема «${theme}» повторялась в динамике недели`, "probable")
        );
      }
    }
  }

  for (const w of weeklies.slice(0, 2)) {
    for (const phrase of splitWeeklyPhrases(w.content)) {
      if (/(?:возвращал|снова|опять|к этому|остаётся живым|остается живым)/i.test(phrase)) {
        items.push(asNarrativePhrase(phrase, "probable"));
      }
    }
  }

  return dedupeItems(items);
}

function extractGrowthSignals(args: {
  summary?: ConversationSummary;
  weekly?: WeeklyReflection[];
  recentMessages?: ChatMessage[];
}): string[] {
  const items: string[] = [];

  for (const pref of args.summary?.preferences ?? []) {
    if (GROWTH_RE.test(pref)) items.push(asNarrativePhrase(`в стиле контакта: ${pref}`));
  }

  for (const line of recentUserLines(args.recentMessages)) {
    if (GROWTH_RE.test(line)) {
      items.push(asNarrativePhrase(`признак движения в её словах: ${line}`));
    }
  }

  for (const ev of args.summary?.important_events ?? []) {
    if (GROWTH_RE.test(ev)) items.push(asNarrativePhrase(`в событиях: ${ev}`));
  }

  for (const w of args.weekly ?? []) {
    for (const phrase of splitWeeklyPhrases(w.content)) {
      if (GROWTH_RE.test(phrase)) items.push(asNarrativePhrase(phrase, "probable"));
    }
  }

  return dedupeItems(items);
}

function extractParadoxes(corpus: string): string[] {
  const items: string[] = [];
  for (const pair of PARADOX_PAIRS) {
    if (pair.a.test(corpus) && pair.b.test(corpus)) {
      items.push(
        hedge(`в жизни одновременно может ощущаться движение к ${pair.label}`, "possible")
      );
    }
  }
  return dedupeItems(items, 3);
}

export function buildNarrativeContext(args: {
  summary?: ConversationSummary;
  weekly?: WeeklyReflection[];
  crossMemory?: UserMemoryRow[];
  recentMessages?: ChatMessage[];
}): NarrativeContext {
  const corpus = collectCorpus(args);

  return {
    currentSituation: extractCurrentSituation(args),
    majorChanges: extractMajorChanges(args),
    recurringPatterns: extractRecurringPatterns(args),
    growthSignals: extractGrowthSignals(args),
    paradoxes: extractParadoxes(corpus),
  };
}

function formatSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `${title}:\n${items.map((i) => `• ${i}`).join("\n")}`;
}

export const NARRATIVE_RESPONSE_RULES = `ДВИЖЕНИЕ ЖИЗНИ (поведение):
Ответ опирается на текущую реплику с учётом уже известного контекста.
Можно лёгкий юмор и наблюдения, помогающие увидеть ситуацию яснее, если уместно.
Блок «ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ» — интерпретация, не факты: формулируй гипотезы осторожно («похоже», «возможно»), факты — только из её слов и архива.
Не ставь диагнозов и не называй патологии.`;

export function formatNarrativeForPrompt(ctx: NarrativeContext): string {
  const hasContent =
    ctx.currentSituation.length +
      ctx.majorChanges.length +
      ctx.recurringPatterns.length +
      ctx.growthSignals.length +
      ctx.paradoxes.length >
    0;
  if (!hasContent) return "";

  const sections = [
    formatSection("Текущая ситуация", ctx.currentSituation),
    formatSection("Изменения", ctx.majorChanges),
    formatSection("Повторяющиеся темы", ctx.recurringPatterns),
    formatSection("Признаки роста", ctx.growthSignals),
    formatSection("Парадоксы", ctx.paradoxes),
  ].filter(Boolean);

  return [
    "ИСТОРИЯ И ДВИЖЕНИЕ ЖИЗНИ:",
    "",
    sections.join("\n\n"),
    "",
    NARRATIVE_RESPONSE_RULES,
  ].join("\n");
}

export function narrativeContextIsEmpty(ctx: NarrativeContext): boolean {
  return (
    ctx.currentSituation.length === 0 &&
    ctx.majorChanges.length === 0 &&
    ctx.recurringPatterns.length === 0 &&
    ctx.growthSignals.length === 0 &&
    ctx.paradoxes.length === 0
  );
}
