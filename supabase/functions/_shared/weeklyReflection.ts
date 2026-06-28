/**
 * «Неделя здесь» — тёплый снимок динамики одной беседы за 7 дней (модель + fallback).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  formatMemoryForInjection,
  parseStoredMemory,
  type StructuredMemory,
} from "./memory.ts";
import { normalizeMessageRole } from "./messageRole.ts";
import { WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE } from "./weeklyReflectionPrivacy.ts";

export {
  isWeeklyReflectionVisibleEntryType,
  WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE,
} from "./weeklyReflectionPrivacy.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_LINES = 36;
const MAX_USER_EXCERPT_CHARS = 280;

export interface WeeklyReflectionInput {
  conversationId: string;
  conversationTitle: string | null;
  conversationSummary: string | null;
}

export interface WeekTranscriptLine {
  role: "user" | "assistant";
  content: string;
  day: string;
}

function sinceIsoWeek(): string {
  const since = new Date(Date.now() - WEEK_MS);
  since.setHours(0, 0, 0, 0);
  return since.toISOString();
}

function dayWordRu(n: number): string {
  if (n === 1) return "день";
  if (n >= 2 && n <= 4) return "дня";
  return "дней";
}

function trimExcerpt(text: string, max = MAX_USER_EXCERPT_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Evenly sample lines when the week is very chatty. */
export function sampleTranscriptLines(
  lines: WeekTranscriptLine[],
  max: number
): WeekTranscriptLine[] {
  if (lines.length <= max) return lines;
  const out: WeekTranscriptLine[] = [];
  const step = lines.length / max;
  for (let i = 0; i < max; i++) {
    out.push(lines[Math.floor(i * step)]!);
  }
  return out;
}

export async function fetchWeekTranscript(
  supabase: SupabaseClient,
  conversationId: string
): Promise<WeekTranscriptLine[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("sender, role, content, created_at")
    .eq("conversation_id", conversationId)
    .gte("created_at", sinceIsoWeek())
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.error("[weeklyReflection] messages:", error.message);
    return [];
  }

  const lines: WeekTranscriptLine[] = [];
  for (const m of data ?? []) {
    const content = (m.content ?? "").trim();
    if (content.length < 2) continue;
    const role = normalizeMessageRole(m);
    lines.push({
      role,
      content: role === "user" ? trimExcerpt(content) : trimExcerpt(content, 200),
      day: m.created_at.slice(0, 10),
    });
  }
  return sampleTranscriptLines(lines, MAX_TRANSCRIPT_LINES);
}

export async function fetchWeekUserMarks(
  supabase: SupabaseClient,
  conversationId: string
): Promise<string[]> {
  const { data } = await supabase
    .from("progress_entries")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("entry_type", WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE)
    .gte("created_at", sinceIsoWeek())
    .order("created_at", { ascending: true })
    .limit(12);

  return (data ?? [])
    .map((r) => (r.content ?? "").trim())
    .filter((t) => t.length > 0);
}

export function buildWeeklyReflectionPrompt(input: {
  title: string;
  memory: StructuredMemory | null;
  transcript: WeekTranscriptLine[];
  userMarks: string[];
  activeDays: number;
}): string {
  const title = input.title.trim() || "эта беседа";
  const days = dayWordRu(input.activeDays);

  let memoryBlock = "Память беседы пока пуста.";
  if (input.memory) {
    const { text } = formatMemoryForInjection(input.memory);
    if (text.trim()) memoryBlock = text;
  }

  const transcriptBlock = input.transcript.length
    ? input.transcript
        .map((l) => {
          const who = l.role === "user" ? "Вы" : "StaySee";
          return `[${l.day}] ${who}: ${l.content}`;
        })
        .join("\n")
    : "За неделю в переписке почти не было содержательных реплик.";

  const marksBlock = input.userMarks.length
    ? input.userMarks.map((m) => `• ${m}`).join("\n")
    : "Пользователь не оставлял своих следов вручную.";

  return `Ты StaySee AI — тёплый, спокойный собеседник для осознанного самонаблюдения.

Задача: написать «Оглянуться за неделю» ТОЛЬКО для одной беседы «${title}».
Это не отчёт и не коучинг. Не ставь диагнозов. Не давай списков советов.
Не используй слова: прогресс, дневник, метрики, цели, шаги к успеху.
Не указывай точное число сообщений или реплик.

Формат ответа:
- 2–4 коротких абзаца, русский, обращение на «вы»;
- опишите ДИНАМИКУ недели: к чему возвращались, что смещалось по ощущению, что может откликаться сейчас;
- если неделя тихая — скажите это бережно;
- только факты из данных ниже, ничего не выдумывайте.

Контекст: за 7 дней пользователь заглядывал сюда ${input.activeDays} ${days}.

ПАМЯТЬ ЭТОЙ БЕСЕДЫ:
${memoryBlock}

СЛЕДЫ, КОТОРЫЕ ПОЛЬЗОВАТЕЛЬ САМ СОХРАНИЛ:
${marksBlock}

ФРАГМЕНТЫ ПЕРЕПИСКИ ЗА НЕДЕЛЮ (только эта комната):
${transcriptBlock}

Верните только текст снимка, без заголовков и markdown.`.trim();
}

export function buildWeeklyReflectionFallback(input: {
  title: string;
  memory: StructuredMemory | null;
  activeDays: number;
  hadTranscript: boolean;
}): string {
  const title = input.title.trim() || "эта беседа";
  const days = dayWordRu(input.activeDays);
  const lines: string[] = [];

  if (input.activeDays === 0 || !input.hadTranscript) {
    lines.push(`В «${title}» эта неделя прошла тихо — без заметных слов в переписке.`);
    lines.push("И тишина тоже может быть опорой, если так ощущается сейчас.");
    return lines.join("\n\n");
  }

  lines.push(`В «${title}» за семь дней вы заглядывали ${input.activeDays} ${days}.`);

  const mem = input.memory;
  if (mem?.themes?.length) {
    lines.push(`Возвращались к: ${mem.themes.slice(0, 3).join("; ")}.`);
  }
  if (mem?.emotional_state?.length) {
    lines.push(`По ощущению: ${mem.emotional_state.slice(0, 2).join("; ")}.`);
  }
  if (mem?.open_loops?.length) {
    lines.push(`Остаётся живым: ${mem.open_loops.slice(0, 2).join("; ")}.`);
  }
  lines.push("Можно без спешки оглянуться — что из этого откликается именно сейчас.");
  return lines.join("\n\n");
}

export function countActiveDays(transcript: WeekTranscriptLine[]): number {
  const days = new Set<string>();
  for (const l of transcript) {
    if (l.role === "user") days.add(l.day);
  }
  return days.size;
}

export async function generateWeeklyReflectionText(
  supabase: SupabaseClient,
  meta: WeeklyReflectionInput,
  model: {
    baseUrl: string;
    model: string;
    apiKey: string;
    extraHeaders?: Record<string, string>;
  }
): Promise<{ text: string; generated: boolean }> {
  const transcript = await fetchWeekTranscript(supabase, meta.conversationId);
  const userMarks = await fetchWeekUserMarks(supabase, meta.conversationId);
  const memory = parseStoredMemory(meta.conversationSummary);
  const activeDays = countActiveDays(transcript);
  const title = meta.conversationTitle ?? "эта беседа";

  if (!model.apiKey) {
    return {
      text: buildWeeklyReflectionFallback({
        title,
        memory,
        activeDays,
        hadTranscript: transcript.some((l) => l.role === "user"),
      }),
      generated: false,
    };
  }

  const prompt = buildWeeklyReflectionPrompt({
    title,
    memory,
    transcript,
    userMarks,
    activeDays,
  });

  try {
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
        max_tokens: 520,
        temperature: 0.45,
      }),
    });

    if (!res.ok) {
      console.warn("[weeklyReflection] model HTTP", res.status);
      throw new Error("model_failed");
    }

    const data = await res.json();
    const out = (data.choices?.[0]?.message?.content ?? "").trim();
    if (out.length < 40) throw new Error("model_empty");

    return { text: out, generated: true };
  } catch (e) {
    console.warn("[weeklyReflection] fallback:", e);
    return {
      text: buildWeeklyReflectionFallback({
        title,
        memory,
        activeDays,
        hadTranscript: transcript.some((l) => l.role === "user"),
      }),
      generated: false,
    };
  }
}
