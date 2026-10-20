/**
 * Long messages: the one-message size limit, and how a long message is read by the model.
 *
 * The person always sees a message in full. The model reads a message of more than LONG_MESSAGE_CHARS
 * in full for the next FULL_TEXT_ASSISTANT_REPLIES replies, then reads a short version of it. The short
 * version is made once (a cheap model, at the moment it is first needed) and stored for reuse; it is
 * never shown to the person. Memory has already read the full text when the message arrived.
 *
 * Pure logic plus injected dependencies -- no Deno or Supabase imports, so it is testable offline.
 */

export const MAX_MESSAGE_CHARS = 10_000;
export const LONG_MESSAGE_CHARS = 4_000;
/** The model reads a long message in full for this many assistant replies, then the short version. */
export const FULL_TEXT_ASSISTANT_REPLIES = 10;
export const SUMMARY_MODEL = "google/gemini-3.7-flash";
export const SUMMARY_MAX_CHARS = 1_500;
/** At most this many short versions are made while answering one message. */
export const MAX_NEW_SUMMARIES_PER_REPLY = 2;

const SUMMARY_MAX_TOKENS = 700;

export function isMessageTooLong(text: string): boolean {
  return text.length > MAX_MESSAGE_CHARS;
}

export interface HistoryRow {
  id?: string;
  role: "user" | "assistant";
  content: string;
}

/** Ids of long messages from the person that have already had their full-text replies. */
export function findExpiredLongMessageIds(rows: readonly HistoryRow[]): string[] {
  const expired: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.role !== "user" || typeof row.id !== "string" || row.content.length <= LONG_MESSAGE_CHARS) continue;
    let repliesAfter = 0;
    for (let next = index + 1; next < rows.length; next += 1) {
      if (rows[next].role === "assistant") repliesAfter += 1;
    }
    if (repliesAfter >= FULL_TEXT_ASSISTANT_REPLIES) expired.push(row.id);
  }
  return expired;
}

/** Labelled, so the model cannot take the short version for the person's own words. */
export function formatCompactedContent(summary: string): string {
  return `[Краткая версия длинного сообщения человека: ${summary}]`;
}

export function compactExpiredLongMessages<T extends HistoryRow>(
  rows: readonly T[],
  summaries: ReadonlyMap<string, string>,
): T[] {
  const expired = new Set(findExpiredLongMessageIds(rows));
  return rows.map((row) => {
    const summary = typeof row.id === "string" && expired.has(row.id) ? summaries.get(row.id) : undefined;
    return summary === undefined ? row : { ...row, content: formatCompactedContent(summary) };
  });
}

export interface LongMessageSummaryResult {
  summary: string;
  usage?: { promptTokens: number; completionTokens: number; costUsd: number } | null;
}

export interface LongMessageDeps {
  loadSummaries(ids: string[]): Promise<Map<string, string>>;
  summarize(text: string): Promise<LongMessageSummaryResult | null>;
  saveSummary(row: { id: string; userId: string; summary: string }): Promise<void>;
}

/**
 * Replaces long messages that have had their full-text replies by their short version. Never throws and
 * never loses meaning: anything that goes wrong (lookup, model, storage) leaves the full text in place.
 */
export async function compactLongMessagesForModel<T extends HistoryRow>(
  rows: readonly T[],
  userId: string,
  deps: LongMessageDeps,
): Promise<readonly T[]> {
  const expired = findExpiredLongMessageIds(rows);
  if (expired.length === 0) return rows;

  let known = new Map<string, string>();
  try {
    known = new Map(await deps.loadSummaries(expired));
  } catch {
    // A failed lookup only means the short versions are made again; the reply goes on.
  }

  const missing = expired.filter((id) => !known.has(id)).slice(0, MAX_NEW_SUMMARIES_PER_REPLY);
  await Promise.all(missing.map(async (id) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return;
    try {
      const made = await deps.summarize(row.content);
      if (!made || made.summary.trim() === "") return;
      known.set(id, made.summary);
      try {
        await deps.saveSummary({ id, userId, summary: made.summary });
      } catch {
        // Not saved: it is used for this reply and made again next time.
      }
    } catch {
      // No short version: the full text stays in this reply.
    }
  }));

  return compactExpiredLongMessages(rows, known);
}

const SUMMARY_SYSTEM_PROMPT = [
  "Ты делаешь точную краткую версию длинного сообщения человека. Её будет читать ассистент психологического приложения вместо полного текста.",
  "Сохрани смысл, факты, имена, даты и эмоциональный тон человека. Если в тексте вставлена переписка нескольких людей или чужие слова, чётко укажи, кто что писал и о чём просил.",
  "Ничего не добавляй от себя: не оценивай, не советуй, не смягчай и не усиливай, не ставь диагнозов.",
  "Пиши по-русски, от третьего лица («Человек пишет…»), одним связным текстом без списков и заголовков, 600–1000 символов.",
].join("\n");

export function buildLongMessageSummaryRequest(text: string) {
  return {
    model: SUMMARY_MODEL,
    messages: [
      { role: "system" as const, content: SUMMARY_SYSTEM_PROMPT },
      { role: "user" as const, content: text },
    ],
    max_tokens: SUMMARY_MAX_TOKENS,
    temperature: 0.2,
    stream: false,
    provider: { allow_fallbacks: true, data_collection: "deny", zdr: true },
    usage: { include: true },
  };
}

function cutBackToLastSentence(text: string): string {
  const end = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"), text.lastIndexOf("…"));
  return end >= 12 ? text.slice(0, end + 1) : text;
}

function readUsage(value: unknown): LongMessageSummaryResult["usage"] {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Record<string, unknown>;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const cost = usage.cost;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || typeof cost !== "number" || !Number.isFinite(cost)) return null;
  return { promptTokens: prompt as number, completionTokens: completion as number, costUsd: cost };
}

/** Reads an OpenRouter answer; null when it holds no usable text. */
export function parseLongMessageSummaryResponse(body: unknown): LongMessageSummaryResult | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } | null;
  const content = choice?.message?.content;
  if (typeof content !== "string") return null;
  let summary = content.trim();
  if (summary === "") return null;
  if (choice?.finish_reason === "length") summary = cutBackToLastSentence(summary);
  if (summary.length > SUMMARY_MAX_CHARS) summary = cutBackToLastSentence(summary.slice(0, SUMMARY_MAX_CHARS));
  if (summary.length > SUMMARY_MAX_CHARS) summary = summary.slice(0, SUMMARY_MAX_CHARS);
  return { summary, usage: readUsage((body as { usage?: unknown }).usage) };
}
