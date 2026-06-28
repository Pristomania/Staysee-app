import { normalizeMessageRole } from "./messageRole.ts";

/**
 * StaySee Memory MVP — structured JSON in conversation_summary (text column).
 * Merge, decay, compress, token-safe injection. Server-side only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { estimateTokens } from "./cost.ts";
import type { DurableMemoryCorrection } from "./memoryCorrectionApply.ts";
import {
  applyDurableCorrections,
  durableCorrectionsToHintStrings,
} from "./memoryCorrectionApply.ts";

// ── Config ────────────────────────────────────────────────────────────────────

/** Refresh rolling summary after this many new messages (GPT-like continuity). */
export const MESSAGES_PER_SUMMARY_UPDATE = 10;
export const SUMMARY_TOKEN_PRESSURE_THRESHOLD = 5_500;

/** Rebuild summary when memory is older than this (ms) — e.g. return after a few days. */
export const SUMMARY_STALE_MS = 24 * 60 * 60 * 1000;

/** Max tokens for memory block injected into system prompt. */
export const MEMORY_INJECTION_TOKEN_BUDGET = 720;

/** Per-field caps (prevents endless append). */
const CAPS: Record<keyof Omit<StructuredMemory, "last_updated">, number> = {
  people: 8,
  themes: 10,
  emotional_state: 5,
  important_events: 6,
  preferences: 6,
  risks: 4,
  open_loops: 5,
};

const MAX_ITEM_CHARS = 140;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StructuredMemory {
  people: string[];
  themes: string[];
  emotional_state: string[];
  important_events: string[];
  preferences: string[];
  risks: string[];
  open_loops: string[];
  last_updated: string;
}

export interface ConversationMemoryMeta {
  id: string;
  title: string | null;
  conversation_summary: string | null;
  summary: string | null;
  emotional_tone: string | null;
  summary_updated_at: string | null;
}

export interface MemoryPromptInput {
  conversationSummary: string | null;
  conversationTitle?: string | null;
  emotionalTone?: string | null;
  corrections?: string[];
  durableCorrections?: DurableMemoryCorrection[];
}

export interface SummaryBuildInput {
  conversationId: string;
  previousSummary: string | null;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  corrections?: string[];
  durableCorrections?: DurableMemoryCorrection[];
}

export interface SummaryUpdateInput {
  supabase: SupabaseClient;
  conversationId: string;
  /** Parsed + merged memory (preferred). */
  memory?: StructuredMemory;
  /** Raw model output to parse when memory not provided. */
  modelOutput?: string;
  emotionalTone?: string;
  /** Allow saving intentionally cleared memory (e.g. delete_fact). */
  allowEmptyMemory?: boolean;
}

export interface SummaryRefreshCheck {
  conversationSummary: string | null;
  summaryUpdatedAt: string | null;
  messagesSinceSummary: number;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  hasCorrections: boolean;
}

export interface MemoryInjectionResult {
  text: string;
  tokenEstimate: number;
  compressed: boolean;
  fieldCounts: Record<string, number>;
}

// ── Safe rules (prompts) ──────────────────────────────────────────────────────

export const MEMORY_SAFE_RULES = `ПРАВИЛА ПАМЯТИ (жёстко):
- Факты (кто, где живёт, сроки, события) — только из реплик пользователя, ПОДТВЕРЖДЁННЫХ СЛОВ и строк пользователя в АРХИВЕ. Не из ответов StaySee.
- ПАМЯТЬ БЕСЕДЫ и СКВОЗНАЯ ПАМЯТЬ — черновик; при «помнишь» не утверждай деталь, если её нет дословно в сообщениях пользователя ниже.
- Запрещено: «ты не говорил(а)», если в цитатах/архиве есть реплики пользователя про тему.
- Не восстанавливай биографию из памяти без дословной опоры.
- При пробелах: «в твоих сообщениях я не вижу X — напомни своими словами», а не выдуманный пересказ.
- Не говори «помню всё» / «ничего не забыла» / «я не придумала» без проверки цитат.
- Различай факты пользователя и гипотезы StaySee.`;

const MEMORY_BEHAVIOR_RULES = `ПАМЯТЬ РАЗГОВОРА (поведение):
ПАМЯТЬ БЕСЕДЫ и СКВОЗНАЯ ПАМЯТЬ держат линию тем и эмоций; для конкретных фактов сверяй ПОДТВЕРЖДЁННЫЕ СЛОВА и архив (роль пользователь).
Память помогает ориентироваться в разговоре, но не требует пересказывать известное в каждом ответе.
Продолжай разговор с учётом известного — не переспрашивай то, что уже есть в словах пользователя, если только не уточняешь после паузы.
Если факта нет в репликах/цитатах пользователя — уточни, не додумывай.
В preferences: стиль общения, границы, что помогает в контакте.`;

/** Prompt block when user returns after a pause or memory is stale. */
export function buildMemoryContinuityPrompt(options: {
  summaryStale?: boolean;
  longPause?: boolean;
}): string {
  if (!options.summaryStale && !options.longPause) return "";
  const lines = [
    "НЕПРЕРЫВНОСТЬ ДИАЛОГА (внутреннее):",
    "Пользователь продолжает ту же беседу после паузы. Сначала сверь ПАМЯТЬ БЕСЕДЫ и СКВОЗНУЮ ПАМЯТЬ.",
    "Сохраняй смысл важного, о чём уже говорили (люди, ситуации, чувства, решения) — не обнуляй контекст.",
  ];
  if (options.summaryStale) {
    lines.push(
      "Память беседы могла обновиться недавно — всё равно опирайся на неё и на последние реплики."
    );
  }
  if (options.longPause) {
    lines.push(
      "После перерыва можно одной короткой фразой уточнить актуальность, затем продолжай по сути."
    );
  }
  return lines.join("\n");
}

/** Extra rules when user asks «помнишь» / «что я говорила». */
export function buildRecallGroundingPrompt(opts: {
  evidenceCount: number;
  archiveCount: number;
}): string {
  const lines = [
    "РЕЖИМ ВОСПОМИНАНИЯ (внутреннее):",
    "Пользователь спрашивает о своих прошлых репликах. Отвечай коротко.",
    "Утверждай только то, что есть в ПОДТВЕРЖДЁННЫХ СЛОВАХ или в АРХИВЕ (реплики пользователя).",
    "ПАМЯТЬ БЕСЕДЫ — ориентир по темам; не пересказывай из неё даты, быт, родственников, если нет в цитатах пользователя.",
    "Если в чате несколько линий (сын, мужчина, ссора) — не смешивай: по вопросу про ссору опирайся на свежие цитаты про ссору, не на старую тему.",
    "Запрещён уверенный биографический монолог без цитат.",
    "Если детали только в памяти, но не в цитатах — не называй их фактом.",
    "Если есть АРХИВ с репликами пользователя — можно цитировать userText оттуда так же, как ПОДТВЕРЖДЁННЫЕ СЛОВА.",
  ];
  if (opts.evidenceCount >= 3) {
    lines.push(
      "Несколько цитат ниже по одной теме — кратко перечисли формулировки пользователя из них; не добавляй фактов между цитатами."
    );
  } else {
    lines.push("Максимум 2–3 проверяемых факта из цитат, затем уточнение при пробеле.");
  }
  if (opts.evidenceCount === 0 && opts.archiveCount === 0) {
    lines.push(
      "Цитат и архива пользователя сейчас нет — скажи честно, что в переписке не видишь слов пользователя про это, и попроси напомнить."
    );
  } else if (opts.evidenceCount === 0) {
    lines.push(
      "Дословных цитат нет — опирайся только на фразы пользователя в АРХИВЕ; остальное не утверждай."
    );
  }
  return lines.join("\n");
}

const ACUTE_RISK_RE = [
  /суицид/i,
  /самоповреж/i,
  /передоз/i,
  /причинить себе вред/i,
  /112|103/i,
  /острый кризис/i,
  /паническ/i,
];

const MEMORY_CONTENT_FIELDS: Array<keyof Omit<StructuredMemory, "last_updated">> = [
  "people",
  "themes",
  "emotional_state",
  "important_events",
  "preferences",
  "risks",
  "open_loops",
];

// ── Structured memory I/O ─────────────────────────────────────────────────────

export function emptyStructuredMemory(): StructuredMemory {
  return {
    people: [],
    themes: [],
    emotional_state: [],
    important_events: [],
    preferences: [],
    risks: [],
    open_loops: [],
    last_updated: new Date().toISOString(),
  };
}

function normalizeItem(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
}

/** Living-together claims that contradict user saying they live separately. */
export const MEMORY_COHABIT_CONFLICT_RE =
  /жив[уё]м?\s+вместе|вместе\s+жив|одной\s+(квартир|дом)|прожива.*вместе\s+с\s+(?:ним|нею|муж|партн)|съехались|одна\s+семья/i;

/** User signals separate living / not together. */
export const MEMORY_SEPARATE_SIGNAL_RE =
  /не\s+живу|не\s+живём|не\s+живем|не\s+прожива|не\s+вместе|раздельно|отдельно\s+жив|не\s+одной\s+семь|живут\s+раздельно|разное\s+жиль/i;

const CORRECTION_PATTERNS = [
  /нет,?\s*я говор/i,
  /нет,?\s*ты не понял/i,
  /нет,?\s*ты не поняла/i,
  /нет,?\s*я имела в виду/i,
  /нет,?\s*я имел в виду/i,
  /не об этом/i,
  /не про это/i,
  /не то/i,
  /ты меня не так поняла/i,
  /ты меня неправильно поняла/i,
  /я говорила о другом/i,
  /я говорил о другом/i,
  /это не то, что я/i,
  /это не то что я/i,
  /это не так/i,
  /на самом деле/i,
  /уточняю/i,
  /поправлю/i,
  /уточняю/i,
  /^нет\b/i,
  /без обсуждения/i,
  /просто о делах/i,
  /поговорили по телефону/i,
  /на следующий день/i,
  /исправь/i,
  /ты написала/i,
  /ты написал/i,
  /не\s+живу/i,
  /не\s+живём/i,
  /не\s+живем/i,
  /не\s+прожива/i,
  /не\s+вместе/i,
  /раздельно/i,
  /отдельно\s+жив/i,
  /придумал/i,
  /придумала/i,
  /выдумал/i,
  /выдумала/i,
  /фантаз/i,
  /не\s+было/i,
  /не\s+говорила/i,
  /ты\s+это\s+придум/i,
  /додумал/i,
  /додумала/i,
];

const RELATIONSHIP_FACT_RE =
  /(?:мужчин|партн[её]р|муж\b|супруг).{0,100}(?:жив|вместе|раздель|прожива)|(?:жив|вместе|раздель|прожива).{0,100}(?:мужчин|партн[её]р|муж\b|супруг)/i;

function itemTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/** Near-duplicate bullets (substring or high word overlap). */
export function memoryItemsSimilar(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (x === y) return true;
  const minLen = Math.min(x.length, y.length);
  if (minLen >= 10 && (x.includes(y) || y.includes(x))) return true;
  const ax = itemTokens(a);
  const bx = itemTokens(b);
  if (!ax.size || !bx.size) return false;
  let overlap = 0;
  for (const w of ax) {
    if (bx.has(w)) overlap++;
  }
  const ratio = overlap / Math.min(ax.size, bx.size);
  return ratio >= 0.65 && overlap >= 3;
}

function dedupeItems(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = normalizeItem(raw);
    if (!item || item === "—") continue;
    if (out.some((o) => memoryItemsSimilar(o, item))) continue;
    out.push(item);
  }
  return out;
}

function filterContradictedItems(items: string[], combinedLower: string): string[] {
  if (!MEMORY_SEPARATE_SIGNAL_RE.test(combinedLower)) return items;
  return items.filter((item) => !MEMORY_COHABIT_CONFLICT_RE.test(item));
}

/** Apply user corrections to structured memory (strip stale facts, add overrides). */
export function applyCorrectionHints(
  mem: StructuredMemory,
  hints: string[]
): StructuredMemory {
  if (!hints.length) return mem;
  const combined = hints.join(" ").toLowerCase();
  const m: StructuredMemory = { ...mem };

  for (const field of MEMORY_CONTENT_FIELDS) {
    m[field] = dedupeItems(filterContradictedItems(m[field], combined));
  }

  if (/придумал|придумала|выдумал|выдумала|не было|не говорила|фантаз|додумал/i.test(combined)) {
    m.open_loops = dedupeItems([
      ...m.open_loops,
      "Пользователь указал на неточность памяти — факты только из слов пользователя",
    ]);
    m.important_events = m.important_events.filter((e) => {
      const el = e.toLowerCase();
      return hints.some((h) => {
        const hl = h.toLowerCase();
        return hl.includes(el.slice(0, 14)) || el.includes(hl.slice(0, 14));
      });
    });
  }

  if (MEMORY_SEPARATE_SIGNAL_RE.test(combined)) {
    const factLine =
      hints.find((h) => MEMORY_SEPARATE_SIGNAL_RE.test(h)) ??
      "Не живёт вместе с партнёром (раздельное проживание).";
    const normalized = normalizeItem(factLine);
    if (
      !m.important_events.some(
        (e) => MEMORY_SEPARATE_SIGNAL_RE.test(e) || /раздельн|не вместе/i.test(e)
      )
    ) {
      m.important_events = dedupeItems([...m.important_events, normalized]);
    }
    if (!m.people.some((p) => /мужчин|партн|муж\b|супруг/i.test(p))) {
      m.people = dedupeItems([...m.people, "Мужчина (партнёр)"]);
    }
    m.people = m.people.map((p) => {
      if (MEMORY_COHABIT_CONFLICT_RE.test(p)) {
        return normalizeItem("Мужчина — живут раздельно");
      }
      return p;
    });
  }

  return normalizeStructuredMemory(m);
}

/** Corrections + relationship/living facts from recent user messages. */
export function collectMemoryCorrectionHints(
  messages: Array<{ role: string; content: string }>
): string[] {
  const hints = new Set<string>();
  const userMsgs = messages.filter((m) => m.role === "user");

  for (const msg of userMsgs) {
    const t = msg.content.trim();
    if (!t) continue;
    const isCorrection = CORRECTION_PATTERNS.some((p) => p.test(t));
    const isRelationshipFact =
      t.length >= 15 && RELATIONSHIP_FACT_RE.test(t);
    if (isCorrection || isRelationshipFact) {
      hints.add(t.slice(0, MAX_ITEM_CHARS));
    }
  }

  return [...hints].slice(-8);
}

function capField<K extends keyof typeof CAPS>(
  items: string[],
  field: K
): string[] {
  return dedupeItems(items).slice(0, CAPS[field]);
}

/** Parse JSON or legacy prose from conversation_summary. */
export function parseStoredMemory(raw: string | null | undefined): StructuredMemory | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t) as Partial<StructuredMemory>;
      return normalizeStructuredMemory(parsed);
    } catch {
      console.warn("[memory] JSON parse failed, trying legacy prose");
    }
  }
  return proseToStructuredMemory(t);
}

function normalizeStructuredMemory(partial: Partial<StructuredMemory>): StructuredMemory {
  const base = emptyStructuredMemory();
  return {
    people: capField(partial.people ?? [], "people"),
    themes: capField(partial.themes ?? [], "themes"),
    emotional_state: capField(partial.emotional_state ?? [], "emotional_state"),
    important_events: capField(partial.important_events ?? [], "important_events"),
    preferences: capField(partial.preferences ?? [], "preferences"),
    risks: capField(partial.risks ?? [], "risks"),
    open_loops: capField(partial.open_loops ?? [], "open_loops"),
    last_updated: partial.last_updated ?? new Date().toISOString(),
  };
}

function proseToStructuredMemory(prose: string): StructuredMemory {
  const mem = emptyStructuredMemory();
  const lines = prose.split("\n");
  const map: Record<string, keyof StructuredMemory> = {
    "люди": "people",
    "люди:": "people",
    "эмоциональные темы": "themes",
    "эмоциональное состояние": "emotional_state",
    "важные события": "important_events",
    "нерешённые ситуации": "open_loops",
    "нерешенные ситуации": "open_loops",
    "стиль общения": "preferences",
    "безопасность": "risks",
    "медицина": "risks",
  };
  let current: keyof StructuredMemory | null = null;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    const key = Object.keys(map).find((k) => l.toLowerCase().startsWith(k));
    if (key) {
      current = map[key];
      const rest = l.slice(key.length).replace(/^:\s*/, "").trim();
      if (rest && rest !== "—" && current) {
        (mem[current] as string[]).push(rest);
      }
      continue;
    }
    if (current) (mem[current] as string[]).push(l);
  }
  return normalizeStructuredMemory(mem);
}

export function serializeMemory(mem: StructuredMemory): string {
  const normalized = normalizeStructuredMemory({
    ...mem,
    last_updated: new Date().toISOString(),
  });
  return JSON.stringify(normalized);
}

/** True when structured memory has at least one fact. */
export function structuredMemoryHasContent(mem: StructuredMemory | null): boolean {
  if (!mem) return false;
  return MEMORY_CONTENT_FIELDS.some((f) => mem[f].length > 0);
}

/** Alias: all known arrays empty (or null memory). */
export function isStructuredMemoryEffectivelyEmpty(
  memory: StructuredMemory | null | undefined
): boolean {
  if (!memory) return true;
  return !structuredMemoryHasContent(memory);
}

/** Parsed/raw summary with no meaningful structured content. */
export function isStructuredMemoryEffectivelyEmptyRaw(
  raw: string | null | undefined
): boolean {
  if (!raw?.trim()) return true;
  const parsed = parseStoredMemory(raw);
  if (!parsed) return true;
  return !structuredMemoryHasContent(parsed);
}

/** Detect empty JSON shell saved by a failed rolling update. */
export function isTrivialEmptySummary(raw: string | null | undefined): boolean {
  const parsed = parseStoredMemory(raw);
  if (!parsed) return false;
  return !structuredMemoryHasContent(parsed);
}

export function structuredMemoryFieldCounts(
  mem: StructuredMemory
): Record<string, number> {
  return Object.fromEntries(
    MEMORY_CONTENT_FIELDS.map((f) => [f, mem[f]?.length ?? 0])
  );
}

/** Whether a candidate summary may replace the stored one. */
export function evaluateSummarySaveCandidate(input: {
  previousRaw: string | null;
  candidate: StructuredMemory;
  allowEmptyMemory?: boolean;
}): { allowed: boolean; reason?: string } {
  if (input.allowEmptyMemory) {
    return { allowed: true };
  }
  if (structuredMemoryHasContent(input.candidate)) {
    return { allowed: true };
  }
  const previousMeaningful =
    !!input.previousRaw?.trim() && !isTrivialEmptySummary(input.previousRaw);
  if (previousMeaningful) {
    return { allowed: false, reason: "empty_summary_guard" };
  }
  return { allowed: false, reason: "empty_summary_candidate" };
}

/** Extract JSON object from model output. */
export function parseSummaryFromModel(raw: string): StructuredMemory | null {
  const t = raw.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : t;
  const jsonStart = candidate.indexOf("{");
  const jsonEnd = candidate.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      return normalizeStructuredMemory(
        JSON.parse(candidate.slice(jsonStart, jsonEnd + 1)) as Partial<StructuredMemory>
      );
    } catch (e) {
      console.error("[memory] parseSummaryFromModel:", e);
    }
  }
  return proseToStructuredMemory(t);
}

// ── Merge + decay + compress ───────────────────────────────────────────────────

function isAcuteRiskItem(item: string): boolean {
  return ACUTE_RISK_RE.some((re) => re.test(item));
}

/** Lightweight decay: soften acute crisis noise; keep stable patterns. */
export function applyMemoryDecay(mem: StructuredMemory): StructuredMemory {
  const out = { ...mem };
  const updated = new Date(mem.last_updated || Date.now());
  const daysSince = (Date.now() - updated.getTime()) / 86_400_000;

  if (daysSince > 2) {
    const chronicRisks = out.risks.filter((r) => !isAcuteRiskItem(r));
    const acute = out.risks.filter((r) => isAcuteRiskItem(r));
    if (acute.length > 0 && daysSince > 5) {
      out.risks = chronicRisks;
    } else if (acute.length > 1) {
      out.risks = [...chronicRisks, acute[acute.length - 1]];
    }
  }

  if (out.important_events.length > CAPS.important_events) {
    out.important_events = out.important_events.slice(-CAPS.important_events);
  }

  return normalizeStructuredMemory(out);
}

/** Merge previous memory with model delta; dedupe; no endless append. */
export function mergeStructuredMemory(
  previous: StructuredMemory | null,
  incoming: StructuredMemory
): StructuredMemory {
  const base = previous ?? emptyStructuredMemory();

  const mergeField = (a: string[], b: string[], field: keyof typeof CAPS) =>
    capField([...a, ...b], field);

  const merged: StructuredMemory = {
    people: mergeField(base.people, incoming.people, "people"),
    themes: mergeField(base.themes, incoming.themes, "themes"),
    emotional_state: mergeField(base.emotional_state, incoming.emotional_state, "emotional_state"),
    important_events: mergeField(base.important_events, incoming.important_events, "important_events"),
    preferences: mergeField(base.preferences, incoming.preferences, "preferences"),
    risks: mergeField(base.risks, incoming.risks, "risks"),
    open_loops: mergeField(base.open_loops, incoming.open_loops, "open_loops"),
    last_updated: new Date().toISOString(),
  };

  return applyMemoryDecay(merged);
}

/** Shrink memory for storage/injection when over budget. */
export function compressStructuredMemory(mem: StructuredMemory): {
  memory: StructuredMemory;
  compressed: boolean;
} {
  let compressed = false;
  const m = normalizeStructuredMemory(mem);
  let serialized = serializeMemory(m);
  let tokens = estimateTokens(serialized);

  if (tokens <= MEMORY_INJECTION_TOKEN_BUDGET) {
    return { memory: m, compressed: false };
  }

  compressed = true;
  const tighter: StructuredMemory = {
    ...m,
    people: m.people.slice(0, 5),
    themes: m.themes.slice(0, 6),
    emotional_state: m.emotional_state.slice(0, 3),
    important_events: m.important_events.slice(-4),
    preferences: m.preferences.slice(0, 4),
    risks: m.risks.slice(0, 2),
    open_loops: m.open_loops.slice(0, 3),
    last_updated: m.last_updated,
  };

  serialized = serializeMemory(tighter);
  tokens = estimateTokens(serialized);
  if (tokens > MEMORY_INJECTION_TOKEN_BUDGET) {
    tighter.themes = tighter.themes.slice(0, 4);
    tighter.important_events = tighter.important_events.slice(-2);
    tighter.open_loops = tighter.open_loops.slice(0, 2);
  }

  console.log(
    `[memory] compression event tokens_before=${tokens} fields=${JSON.stringify(fieldCounts(tighter))}`
  );

  return { memory: normalizeStructuredMemory(tighter), compressed: true };
}

function fieldCounts(mem: StructuredMemory): Record<string, number> {
  return {
    people: mem.people.length,
    themes: mem.themes.length,
    emotional_state: mem.emotional_state.length,
    important_events: mem.important_events.length,
    preferences: mem.preferences.length,
    risks: mem.risks.length,
    open_loops: mem.open_loops.length,
  };
}

/** Human-readable block for system prompt (from JSON). */
export function formatMemoryForInjection(mem: StructuredMemory): MemoryInjectionResult {
  const lines: string[] = [];
  const add = (label: string, items: string[]) => {
    if (items.length) lines.push(`${label}: ${items.join("; ")}`);
  };

  add("Люди", mem.people);
  add("Темы", mem.themes);
  add("Состояние", mem.emotional_state);
  add("События", mem.important_events);
  add("Предпочтения", mem.preferences);
  add("Риски", mem.risks);
  add("Открыто", mem.open_loops);

  let text = lines.join("\n");
  let tokenEstimate = estimateTokens(text);
  let compressed = false;

  if (tokenEstimate > MEMORY_INJECTION_TOKEN_BUDGET) {
    const { memory: smaller, compressed: did } = compressStructuredMemory(mem);
    compressed = did;
    const lines2: string[] = [];
    const add2 = (label: string, items: string[]) => {
      if (items.length) lines2.push(`${label}: ${items.join("; ")}`);
    };
    add2("Люди", smaller.people);
    add2("Темы", smaller.themes);
    add2("Состояние", smaller.emotional_state);
    add2("События", smaller.important_events);
    add2("Предпочтения", smaller.preferences);
    add2("Риски", smaller.risks);
    add2("Открыто", smaller.open_loops);
    text = lines2.join("\n");
    tokenEstimate = estimateTokens(text);
    mem = smaller;
  }

  return { text, tokenEstimate, compressed, fieldCounts: fieldCounts(mem) };
}

// ── Read / inject ─────────────────────────────────────────────────────────────

export function getConversationSummary(meta: ConversationMemoryMeta | null): string | null {
  if (!meta) return null;
  return meta.conversation_summary?.trim() || meta.summary?.trim() || null;
}

export function getParsedMemory(meta: ConversationMemoryMeta | null): StructuredMemory | null {
  return parseStoredMemory(getConversationSummary(meta));
}

export function injectSummaryIntoPrompt(input: MemoryPromptInput): string {
  const parts: string[] = [];

  const durableHints = durableCorrectionsToHintStrings(input.durableCorrections ?? []);
  const ephemeralHints = input.corrections ?? [];
  const allHints = [...new Set([...durableHints, ...ephemeralHints])];

  if (allHints.length > 0) {
    const list = allHints.map((c) => `"${c}"`).join(" | ");
    parts.push(
      `ПОПРАВКИ ПОЛЬЗОВАТЕЛЯ (высший приоритет — перекрывают память): ${list}\n` +
        `Если память противоречит поправке — верь пользователю, не старой памяти.`
    );
  }

  let parsed = parseStoredMemory(input.conversationSummary);
  if (parsed && (input.durableCorrections?.length ?? 0) > 0) {
    parsed = applyDurableCorrections(parsed, input.durableCorrections!);
  }
  if (parsed && ephemeralHints.length) {
    parsed = applyCorrectionHints(parsed, ephemeralHints);
  }
  if (parsed) {
    const { text, tokenEstimate, compressed, fieldCounts } = formatMemoryForInjection(parsed);
    const tone = input.emotionalTone ? ` (тон: ${input.emotionalTone})` : "";
    parts.push(`ПАМЯТЬ БЕСЕДЫ${tone}:\n${text}`);
    console.log(
      `[memory] inject size=${input.conversationSummary?.length ?? 0} ` +
        `tokens≈${tokenEstimate} compressed=${compressed} fields=${JSON.stringify(fieldCounts)}`
    );
  } else if (input.conversationSummary?.trim()) {
    const legacy = input.conversationSummary.trim().slice(0, 2400);
    parts.push(`ПАМЯТЬ БЕСЕДЫ (текст):\n${legacy}`);
    console.log(`[memory] inject legacy prose len=${legacy.length}`);
  } else if (input.conversationTitle?.trim()) {
    parts.push(`ТЕМА: ${input.conversationTitle.trim()}`);
  }

  parts.push(MEMORY_SAFE_RULES);
  parts.push(MEMORY_BEHAVIOR_RULES);

  if (parts.length === 0) return "";
  return `--- КОНТЕКСТ (внутренний) ---\n${parts.join("\n\n")}\n--- КОНЕЦ ---`;
}

// ── Summary builder (model → JSON) ────────────────────────────────────────────

const JSON_SCHEMA_EXAMPLE = `{
  "people": ["имя или роль"],
  "themes": ["повторяющаяся тема"],
  "emotional_state": ["как переживает сейчас"],
  "important_events": ["факт от пользователя"],
  "preferences": ["стиль общения"],
  "risks": ["безопасность/медицина если было"],
  "open_loops": ["нерешённое"],
  "last_updated": ""
}`;

/** Load transcript slice for rolling summary (since last update or recent tail). */
export async function fetchTranscriptForSummary(
  supabase: SupabaseClient,
  conversationId: string,
  summaryUpdatedAt: string | null
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const stale = isSummaryStale(summaryUpdatedAt);
  const sinceCount = await countMessagesSinceSummary(
    supabase,
    conversationId,
    summaryUpdatedAt
  );

  let query = supabase
    .from("messages")
    .select("sender, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const useSince =
    !stale && summaryUpdatedAt && sinceCount > 0 && sinceCount <= 50;
  if (useSince) {
    query = query.gt("created_at", summaryUpdatedAt);
  }

  const limit = stale ? 80 : useSince ? Math.min(sinceCount + 4, 50) : 60;
  const { data, error } = await query.limit(limit);
  if (error) {
    console.error("[memory] fetchTranscriptForSummary:", error.message);
    return [];
  }

  return (data ?? []).map((m) => ({
    role: normalizeMessageRole(m),
    content: m.content ?? "",
  }));
}

export function buildConversationSummary(input: SummaryBuildInput): string {
  const userTranscript = input.transcript
    .filter((m) => m.role === "user")
    .slice(-35)
    .map((m) => `Пользователь: ${m.content}`)
    .join("\n");

  const durableNote = input.durableCorrections?.length
    ? `\nПОПРАВКИ ПОЛЬЗОВАТЕЛЯ (сохранённые, высший приоритет):\n${input.durableCorrections.map((c) => `• ${c.display_text}`).join("\n")}`
    : "";
  const correctionNote =
    input.corrections?.length
      ? `\nПОПРАВКИ (эпизод — удали из JSON противоречащие старые пункты):\n${input.corrections.map((c) => `• ${c}`).join("\n")}`
      : "";
  const combinedCorrectionNote = `${durableNote}${correctionNote}`;

  const prev = parseStoredMemory(input.previousSummary);
  const previousJson = prev
    ? JSON.stringify(prev, null, 0)
    : "null";

  return `${MEMORY_SAFE_RULES}

ПРЕДЫДУЩАЯ ПАМЯТЬ (JSON, объедини — не переписывай с нуля):
${previousJson}

ФРАГМЕНТЫ ПОЛЬЗОВАТЕЛЯ (единственный источник фактов для people / important_events / themes):${combinedCorrectionNote}
${userTranscript || "(пока нет реплик пользователя)"}

Задача: верни ТОЛЬКО один JSON (без markdown, без пояснений) по схеме:
${JSON_SCHEMA_EXAMPLE}

Правила обновления:
- Объедини с предыдущей памятью; убери дубликаты и почти одинаковые пункты.
- ПОПРАВКИ и отрицания пользователя («не живу», «не вместе», «это не так») — главный приоритет: удали противоречащие старые факты, запиши новую формулировку один раз.
- Если пользователь уточнил отношения или проживание — новый факт заменяет старый, не дублируй «живу вместе» и «не живу вместе».
- Сохрани общую линию беседы: кто, что происходит, что важно пользователю сейчас.
- Это ПАМЯТЬ БЕСЕДЫ: короткие пункты до ~${MAX_ITEM_CHARS} символов в people/themes/events.
- preferences: 1–2 цельных фразы про стиль общения (темп, тон, что помогает) — они пойдут в сквозную память. Если из речи явно понятно, в каком грамматическом роде обращаться к пользователю, можно одной фразой: «Обращаться в женском роде.» или «Обращаться в мужском роде.» — только при уверенности, не при сомнении.
- Не раздувай: макс ${CAPS.themes} тем, ${CAPS.important_events} событий.
- Сжимай бытовой шум, но не теряй ключевые факты, имена, отношения, решения.
- risks — только подтверждённое; острый кризис не дублируй.
- Не выдумывай. people / important_events / themes — только из реплик «Пользователь» выше; игнорируй любые «факты» из ответов StaySee (их нет в этом блоке).
- emotional_state / open_loops / preferences — из тона и смысла слов пользователя.
- last_updated: ISO-время сейчас.`.trim();
}

export function logMemoryUpdateTrigger(reason: string, detail: Record<string, unknown>): void {
  console.log(`[memory] update trigger: ${reason}`, JSON.stringify(detail));
}

export function isSummaryStale(
  summaryUpdatedAt: string | null,
  nowMs = Date.now()
): boolean {
  if (!summaryUpdatedAt) return false;
  const t = Date.parse(summaryUpdatedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t >= SUMMARY_STALE_MS;
}

export function shouldUpdateConversationSummary(check: SummaryRefreshCheck): boolean {
  if (check.hasCorrections) {
    logMemoryUpdateTrigger("corrections", { messagesSince: check.messagesSinceSummary });
    return true;
  }
  if (!check.conversationSummary?.trim() && check.transcript.length >= 4) {
    logMemoryUpdateTrigger("no_summary", { transcriptLen: check.transcript.length });
    return true;
  }
  if (isTrivialEmptySummary(check.conversationSummary) && check.transcript.length >= 6) {
    logMemoryUpdateTrigger("empty_summary_shell", {
      transcriptLen: check.transcript.length,
    });
    return true;
  }
  if (
    isSummaryStale(check.summaryUpdatedAt) &&
    check.messagesSinceSummary >= 1
  ) {
    logMemoryUpdateTrigger("stale_summary", {
      messagesSince: check.messagesSinceSummary,
      summaryUpdatedAt: check.summaryUpdatedAt,
    });
    return true;
  }
  if (check.messagesSinceSummary >= MESSAGES_PER_SUMMARY_UPDATE) {
    logMemoryUpdateTrigger("message_count", { count: check.messagesSinceSummary });
    return true;
  }
  const transcriptText = check.transcript.map((m) => m.content).join("\n");
  const tokens = estimateTokens(transcriptText);
  if (tokens >= SUMMARY_TOKEN_PRESSURE_THRESHOLD) {
    logMemoryUpdateTrigger("token_pressure", { tokens });
    return true;
  }
  const parsed = parseStoredMemory(check.conversationSummary);
  if (parsed) {
    const inj = formatMemoryForInjection(parsed);
    if (inj.tokenEstimate > MEMORY_INJECTION_TOKEN_BUDGET) {
      logMemoryUpdateTrigger("storage_compress", { tokens: inj.tokenEstimate });
      return true;
    }
  }
  return false;
}

/** Block on request when memory is empty or older than a day — first reply after pause stays in context. */
export function shouldEagerRefreshSummary(check: SummaryRefreshCheck): boolean {
  if (!shouldUpdateConversationSummary(check)) return false;
  if (check.hasCorrections) return true;
  return (
    isSummaryStale(check.summaryUpdatedAt) ||
    isTrivialEmptySummary(check.conversationSummary)
  );
}

/** Full pipeline: model output → merge → decay → compress → store. */
export function finalizeMemoryUpdate(
  previousRaw: string | null,
  modelOutput: string,
  correctionHints?: string[],
  durableCorrections?: DurableMemoryCorrection[]
): { serialized: string; memory: StructuredMemory; compressed: boolean } {
  const incoming = parseSummaryFromModel(modelOutput);
  if (!incoming) {
    throw new Error("unparseable_summary");
  }
  const previous = parseStoredMemory(previousRaw);
  let merged = mergeStructuredMemory(
    previous && durableCorrections?.length
      ? applyDurableCorrections(previous, durableCorrections)
      : previous,
    incoming
  );
  if (durableCorrections?.length) {
    merged = applyDurableCorrections(merged, durableCorrections);
  }
  if (correctionHints?.length) {
    merged = applyCorrectionHints(merged, correctionHints);
  }
  const { memory, compressed } = compressStructuredMemory(merged);

  if (
    !structuredMemoryHasContent(memory) &&
    previous &&
    structuredMemoryHasContent(previous) &&
    !durableCorrections?.length
  ) {
    console.warn("[memory] reject empty overwrite — keeping previous memory");
    const kept = compressStructuredMemory(previous);
    return {
      serialized: serializeMemory(kept.memory),
      memory: kept.memory,
      compressed: kept.compressed,
    };
  }

  const serialized = serializeMemory(memory);
  console.log(
    `[memory] finalized size=${serialized.length} tokens≈${estimateTokens(serialized)} compressed=${compressed}`
  );
  return { serialized, memory, compressed };
}

// ── Persist ───────────────────────────────────────────────────────────────────

export async function updateConversationSummary(
  input: SummaryUpdateInput
): Promise<void> {
  let serialized: string;
  let tone = input.emotionalTone;

  if (input.memory) {
    if (!structuredMemoryHasContent(input.memory) && !input.allowEmptyMemory) {
      console.warn(
        `[memory] skip save empty memory conversation=${input.conversationId}`
      );
      return;
    }
    const { memory, compressed } = compressStructuredMemory(input.memory);
    serialized = serializeMemory(memory);
    if (!tone) tone = extractEmotionalToneFromMemory(memory) ?? undefined;
    console.log(
      `[memory] save conversation=${input.conversationId} bytes=${serialized.length} compressed=${compressed}`
    );
  } else if (input.modelOutput) {
    const { serialized: s, memory, compressed } = finalizeMemoryUpdate(null, input.modelOutput);
    serialized = s;
    if (!tone) tone = extractEmotionalToneFromMemory(memory) ?? undefined;
    console.log(`[memory] save from model compressed=${compressed}`);
  } else {
    console.error("[memory] updateConversationSummary: no memory or modelOutput");
    return;
  }

  const withTimestamp = {
    conversation_summary: serialized,
    summary_updated_at: new Date().toISOString(),
  };

  let { error } = await input.supabase
    .from("conversations")
    .update(withTimestamp)
    .eq("id", input.conversationId);

  if (error?.message?.includes("summary_updated_at")) {
    ({ error } = await input.supabase
      .from("conversations")
      .update({ conversation_summary: serialized })
      .eq("id", input.conversationId));
  }

  if (error) console.error("[memory] updateConversationSummary:", error.message);
}

/** @deprecated use refreshUserLifeMemory from userLifeMemory.ts */
export async function promoteStableFactsToUserMemory(
  supabase: SupabaseClient,
  userId: string,
  memory: StructuredMemory
): Promise<void> {
  const { refreshUserLifeMemory } = await import("./userLifeMemory.ts");
  await refreshUserLifeMemory(supabase, userId, memory);
}

export async function countMessagesSinceSummary(
  supabase: SupabaseClient,
  conversationId: string,
  summaryUpdatedAt: string | null
): Promise<number> {
  let query = supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);

  if (summaryUpdatedAt) {
    query = query.gt("created_at", summaryUpdatedAt);
  }

  const { count, error } = await query;
  if (error) {
    console.error("[memory] countMessagesSinceSummary:", error.message);
    return 0;
  }
  return count ?? 0;
}

export function extractEmotionalToneFromMemory(mem: StructuredMemory): string | null {
  const line = mem.emotional_state[0] ?? mem.themes[0];
  return line?.slice(0, 120) ?? null;
}

/** @deprecated use extractEmotionalToneFromMemory */
export function extractEmotionalToneFromSummary(summary: string): string | null {
  const mem = parseStoredMemory(summary);
  return mem ? extractEmotionalToneFromMemory(mem) : null;
}
