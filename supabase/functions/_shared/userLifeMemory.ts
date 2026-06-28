/**
 * Cross-conversation memory (user_memory) — life context in full sentences.
 * Differs from per-chat conversation_summary: fewer items, longer, more connected.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fetchCrossMemoryEnabled } from "./profilePrefs.ts";
import type { StructuredMemory } from "./memory.ts";
import {
  MEMORY_COHABIT_CONFLICT_RE,
  MEMORY_SEPARATE_SIGNAL_RE,
  memoryItemsSimilar,
} from "./memory.ts";
import {
  crossMemoryContradictsCorrection,
  type DurableMemoryCorrection,
} from "./memoryCorrectionApply.ts";
import { estimateTokens } from "./cost.ts";
import type { OpenRouterUsagePayload } from "./usageAnalytics.ts";
import {
  filterCrossMemoryCandidates,
  filterCrossMemoryRowsForInjection,
  isBlockedCrossMemoryContent,
  isStableLifeFact,
  isStablePeopleFact,
} from "./crossMemoryPolicy.ts";

export const CROSS_MEMORY_MIN_CHARS = 40;
export const CROSS_MEMORY_MAX_CHARS = 420;
export const MAX_CROSS_MEMORY_ROWS = 10;
export const CROSS_MEMORY_INJECTION_TOKEN_BUDGET = 480;

export type CrossMemoryType =
  | "preference"
  | "insight"
  | "theme"
  | "emotion"
  | "communication"
  | "life_context";

export interface CrossMemoryCandidate {
  memory_type: CrossMemoryType;
  content: string;
  importance: number;
}

const TYPE_IMPORTANCE: Record<CrossMemoryType, number> = {
  communication: 5,
  preference: 5,
  life_context: 4,
  insight: 4,
  theme: 3,
  emotion: 3,
};

function normalizeSentence(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, CROSS_MEMORY_MAX_CHARS);
}

/** Reject tags, single words, bare names without context. */
export function isLifeMemoryFragment(s: string): boolean {
  const t = s.trim();
  if (t.length < CROSS_MEMORY_MIN_CHARS) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length <= 2) return true;
  }
  if (/^[\p{L}\p{N}\s]{1,25}$/u.test(t) && !t.includes(",")) {
    const w = t.split(/\s+/).length;
    if (w <= 2) return true;
  }
  return false;
}

function mergePeopleToSentence(items: string[]): string | null {
  const parts = items.map((s) => s.trim()).filter((s) => s && isStablePeopleFact(s));
  if (!parts.length) return null;
  const long = parts.find((p) => !isLifeMemoryFragment(p));
  if (long) return normalizeSentence(long);
  return normalizeSentence(
    `В жизни пользователя значимы люди: ${parts.join(", ")}.`
  );
}

/** @deprecated themes no longer promoted to cross-memory */
function mergeThemesToSentence(_items: string[]): string | null {
  return null;
}

function mergePreferencesToSentence(items: string[]): string | null {
  const parts = items.map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const long = parts.filter((p) => p.length >= CROSS_MEMORY_MIN_CHARS);
  if (long.length === 1) return normalizeSentence(long[0]);
  if (long.length > 1) {
    return normalizeSentence(
      `Предпочтения в общении: ${long.join(" ")}`
    );
  }
  return normalizeSentence(
    `Пользователю важно в диалоге: ${parts.join("; ")}.`
  );
}

/** @deprecated emotional_state no longer promoted to cross-memory */
function mergeEmotionalToSentence(_items: string[]): string | null {
  return null;
}

/** Rule-based: stable profile + contact prefs only (no themes/emotions/crises). */
export function buildCrossMemoryCandidates(
  memory: StructuredMemory
): CrossMemoryCandidate[] {
  const out: CrossMemoryCandidate[] = [];

  const people = mergePeopleToSentence(memory.people);
  if (people && !isBlockedCrossMemoryContent(people)) {
    out.push({ memory_type: "life_context", content: people, importance: 4 });
  }

  const prefs = mergePreferencesToSentence(memory.preferences);
  if (prefs && !isBlockedCrossMemoryContent(prefs)) {
    out.push({
      memory_type: "communication",
      content: prefs,
      importance: 5,
    });
  }

  for (const ev of memory.important_events.slice(0, 2)) {
    const t = ev.trim();
    if (!isStableLifeFact(t)) continue;
    out.push({
      memory_type: "life_context",
      content: normalizeSentence(t),
      importance: 4,
    });
  }

  return filterCrossMemoryCandidates(out) as CrossMemoryCandidate[];
}

export function buildLifeMemorySynthesisPrompt(
  memory: StructuredMemory,
  existingContents: string[]
): string {
  const snapshot = {
    people: memory.people.filter((p) => isStablePeopleFact(p)),
    preferences: memory.preferences,
    important_events: memory.important_events
      .filter((e) => isStableLifeFact(e))
      .slice(0, 2),
  };

  const existingBlock =
    existingContents.length > 0
      ? `\nУЖЕ В СКВОЗНОЙ ПАМЯТИ (не дублируй):\n${existingContents.map((c) => `• ${c}`).join("\n")}`
      : "";

  return `Ты формируешь СКВОЗНУЮ ПАМЯТЬ о пользователе (между разными беседами).

Только СТАБИЛЬНЫЙ ПРОФИЛЬ и ПРЕДПОЧТЕНИЯ КОНТАКТА. Не переноси темы беседы, эмоции, кризисы, конфликты, страхи.

Черновик из последней беседы (JSON):
${JSON.stringify(snapshot)}

${existingBlock}

Верни ТОЛЬКО JSON-массив (0–2 элемента), без markdown:
[
  {
    "memory_type": "communication|preference|life_context",
    "content": "полное предложение 40–280 символов"
  }
]

Правила:
- life_context — устойчивые факты профиля (семья как факт, город, работа, проект), без сюжета беседы.
- communication/preference — как говорить с человеком (тон, слова, что помогает, грамматический род обращения при явном предпочтении).
- НЕЛЬЗЯ: темы, эмоции, страхи, кризисы, «переживает», «сепарация», «предательство», текущие конфликты.
- Пример можно: «У пользователя есть сын.» Нельзя: «Переживает сепарацию с сыном.»
- Только подтверждённое из черновика. Не выдумывай.
- Не дублируй уже записанное.`.trim();
}

export function parseLifeMemoryFromModel(raw: string): CrossMemoryCandidate[] {
  const t = raw.trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1)) as Array<{
      memory_type?: string;
      content?: string;
    }>;
    const allowed: CrossMemoryType[] = [
      "preference",
      "communication",
      "life_context",
    ];
    const out: CrossMemoryCandidate[] = [];
    for (const row of arr) {
      const content = normalizeSentence(row.content ?? "");
      if (!content || isLifeMemoryFragment(content)) continue;
      if (isBlockedCrossMemoryContent(content)) continue;
      const rawType = String(row.memory_type ?? "life_context").split("|")[0].trim();
      const memory_type = allowed.includes(rawType as CrossMemoryType)
        ? (rawType as CrossMemoryType)
        : null;
      if (!memory_type) continue;
      out.push({
        memory_type,
        content,
        importance: TYPE_IMPORTANCE[memory_type],
      });
    }
    return filterCrossMemoryCandidates(out).slice(0, 3) as CrossMemoryCandidate[];
  } catch {
    return [];
  }
}

function similarMemory(a: string, b: string): boolean {
  return memoryItemsSimilar(a, b);
}

/** Remove cross-memory rows contradicted by durable corrections or ephemeral hints. */
export async function pruneContradictedCrossMemory(
  supabase: SupabaseClient,
  userId: string,
  hints: string[],
  durableCorrections: DurableMemoryCorrection[] = []
): Promise<void> {
  const { data: rows, error } = await supabase
    .from("user_memory")
    .select("id, content")
    .eq("user_id", userId);

  if (error) {
    console.warn("[userLifeMemory] prune fetch failed:", error.message);
    return;
  }

  const combined = hints.join(" ").toLowerCase();
  const legacySeparate = MEMORY_SEPARATE_SIGNAL_RE.test(combined);

  for (const row of rows ?? []) {
    const content = (row.content as string).trim();
    let shouldDelete = false;

    if (durableCorrections.length && crossMemoryContradictsCorrection(content, durableCorrections)) {
      shouldDelete = true;
    } else if (
      legacySeparate &&
      MEMORY_COHABIT_CONFLICT_RE.test(content) &&
      !MEMORY_SEPARATE_SIGNAL_RE.test(content)
    ) {
      shouldDelete = true;
    }

    if (shouldDelete) {
      const { error: delErr } = await supabase
        .from("user_memory")
        .delete()
        .eq("id", row.id);
      if (!delErr) {
        console.log("[userLifeMemory] pruned contradicted cross-memory row");
      }
    }
  }
}

export interface LifeMemoryModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

/** Refresh user_memory from conversation summary (rules + optional LLM). */
export async function refreshUserLifeMemory(
  supabase: SupabaseClient,
  userId: string,
  memory: StructuredMemory,
  model?: LifeMemoryModelConfig,
  correctionHints?: string[],
  conversationId?: string | null,
  durableCorrections: DurableMemoryCorrection[] = []
): Promise<void> {
  if (!(await fetchCrossMemoryEnabled(supabase, userId))) {
    return;
  }

  await pruneContradictedCrossMemory(
    supabase,
    userId,
    correctionHints ?? [],
    durableCorrections
  );

  const { data: existingRows } = await supabase
    .from("user_memory")
    .select("id, content, memory_type")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_CROSS_MEMORY_ROWS);

  const existing = (existingRows ?? []).map((r) => (r.content as string).trim());
  const known = new Set(existing.map((c) => c.toLowerCase()));

  const candidates = filterCrossMemoryCandidates(buildCrossMemoryCandidates(memory));

  if (model?.apiKey) {
    try {
      const prompt = buildLifeMemorySynthesisPrompt(memory, existing);
      const res = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${model.apiKey}`,
          "Content-Type": "application/json",
          ...(model.extraHeaders ?? {}),
        },
        body: JSON.stringify({
          model: model.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 400,
          temperature: 0.2,
          usage: { include: true },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text: string = data.choices?.[0]?.message?.content?.trim() ?? "";
        const { logLifeMemorySynthesisUsage } = await import("./usageAnalytics.ts");
        await logLifeMemorySynthesisUsage(supabase, {
          userId,
          conversationId: conversationId ?? null,
          model: model.model,
          synthesisPrompt: prompt,
          modelOutput: text,
          usage: data.usage as OpenRouterUsagePayload | undefined,
        });
        candidates.push(
          ...filterCrossMemoryCandidates(parseLifeMemoryFromModel(text))
        );
      }
    } catch (e) {
      console.warn("[userLifeMemory] synthesis model failed:", e);
    }
  }

  let rowCount = existing.length;
  for (const c of candidates) {
    if (rowCount >= MAX_CROSS_MEMORY_ROWS) break;
    if (crossMemoryContradictsCorrection(c.content, durableCorrections)) continue;
    const key = c.content.toLowerCase();
    if (known.has(key)) continue;
    if (existing.some((e) => similarMemory(e, c.content))) continue;

    const { error } = await supabase.from("user_memory").insert({
      user_id: userId,
      memory_type: c.memory_type,
      content: c.content,
    });

    if (!error) {
      known.add(key);
      rowCount++;
      console.log(
        `[userLifeMemory] added type=${c.memory_type} len=${c.content.length}`
      );
    } else {
      console.error(
        `[userLifeMemory] insert failed type=${c.memory_type}:`,
        error.message
      );
    }
  }
}

const TYPE_LABELS: Record<string, string> = {
  communication: "Стиль общения",
  preference: "Предпочтения контакта",
  life_context: "Факты профиля",
};

/** Rich block for system prompt (cross-memory only — filtered types). */
export function formatCrossMemoryForPrompt(
  items: Array<{ memory_type: string; content: string }>
): string {
  const filtered = filterCrossMemoryRowsForInjection(items);
  if (!filtered.length) return "";

  const grouped = new Map<string, string[]>();
  for (const i of filtered) {
    const label = TYPE_LABELS[i.memory_type] ?? i.memory_type;
    const list = grouped.get(label) ?? [];
    list.push(i.content.trim());
    grouped.set(label, list);
  }

  const lines: string[] = [
    "СКВОЗНАЯ ПАМЯТЬ (между беседами — стабильный профиль и стиль общения):",
    "Только устойчивые факты и предпочтения контакта. Не подставляй сюжеты и эмоции других бесед.",
  ];

  for (const [label, sentences] of grouped) {
    lines.push(`${label}:`);
    for (const s of sentences) {
      lines.push(`• ${s}`);
    }
  }

  let text = lines.join("\n");
  while (estimateTokens(text) > CROSS_MEMORY_INJECTION_TOKEN_BUDGET && text.length > 200) {
    const cut = text.lastIndexOf("\n• ");
    if (cut < 0) break;
    text = text.slice(0, cut);
  }

  return text;
}
