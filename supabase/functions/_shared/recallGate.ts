/**
 * The small model that stands before the search in the past ("the gate").
 *
 * It reads ONE message of the person and answers two things: does the answer need the earlier messages of this conversation
 * (the person asks to remember, or asks about a fact of their own life that only the earlier messages can know), and what
 * to search for (a short phrase about the topic). The app decides nothing by the words of the message: the model reads the meaning.
 *
 * Measured on Cloud.ru (21.11.2026, a made-up conversation of nine months): 41 of 41 requests to remember recognised,
 * 1 of 58 ordinary messages taken for a request, 0 of 18 ordinary messages that carry words like «раньше», «тогда», «помнишь»
 * taken for a request; about 0.4 s and 0.008 roubles a call.
 *
 * A failure of any kind returns null: the caller then goes on without the model (the old rule by words).
 */

import { CLOUDRU_BASE_URL } from "./modelHost.ts";

export const RECALL_GATE_MODEL = "openai/gpt-oss-120b";
const RECALL_GATE_TIMEOUT_MS = 3500;
const MAX_MESSAGE_CHARS = 1200;

/** words: the model is asked only when the message has words of asking to remember (the owner's choice); always: on every message; off: never. */
export type RecallGateMode = "words" | "always" | "off";

export function resolveRecallGateMode(raw: string | undefined | null): RecallGateMode {
  const value = raw?.trim().toLowerCase();
  return value === "always" || value === "off" ? value : "words";
}

export const RECALL_GATE_SYSTEM_PROMPT = `Ты — вспомогательный модуль приложения-собеседницы. Тебе дают ПОСЛЕДНЕЕ сообщение человека. Определи, нужно ли для ответа заглянуть в ПРОШЛЫЕ сообщения этой беседы. Это так, если человек:
1) просит вспомнить или найти, что он говорил или просил запомнить, или прошлый разговор на тему; ИЛИ
2) спрашивает о фактах о себе и своей жизни, которые приложение может знать только из прошлых сообщений (возраст, имена близких, место жительства, привычки, планы, здоровье, работа).
НЕ нужно заглядывать в прошлое, если: обычный рассказ о событиях (даже со словами «раньше», «тогда», «вчера»), собственные воспоминания человека из жизни, просьба совета, вопрос о мире или общий вопрос, продолжение текущей мысли.
Верни ТОЛЬКО JSON без пояснений: {"recall": true или false, "query": "..."}.
Поле query: если recall=true, короткая поисковая фраза из 2-5 слов о ТЕМЕ. Используй ТЕ ЖЕ существительные и слова, что в сообщении человека, не заменяй их синонимами и не добавляй слов вроде «дата», «причина», «информация», «имя». Не включай слова «вспомни», «помнишь», «говорила», «рассказывала» и местоимения «я», «мне», «мой» (например «любимый цвет», «поездка летом», «аллергия на лекарства», «зубной врач»). Если recall=false, пустая строка.`;

export interface RecallDecision {
  recall: boolean;
  /** The phrase to search for ("" when recall is false). */
  query: string;
}

export interface RecallGateUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RecallGateResult {
  decision: RecallDecision | null;
  usage: RecallGateUsage | null;
  latencyMs: number;
}

/** Reads the answer of the model. Anything that is not the expected JSON is null (never guessed). */
export function parseRecallDecision(content: unknown): RecallDecision | null {
  if (typeof content !== "string") return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { recall?: unknown; query?: unknown };
    if (typeof parsed.recall !== "boolean") return null;
    const query = typeof parsed.query === "string" ? parsed.query.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return { recall: parsed.recall, query: parsed.recall ? query : "" };
  } catch {
    return null;
  }
}

/** A long message is not a short request: the model gets its beginning and its end. */
export function clipForRecallGate(message: string): string {
  const text = message.trim();
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const half = Math.floor(MAX_MESSAGE_CHARS / 2);
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

function wholeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export async function askRecallGate(
  message: string,
  config: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string }
): Promise<RecallGateResult> {
  const started = Date.now();
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = config.baseUrl ?? CLOUDRU_BASE_URL;
  const body = {
    model: RECALL_GATE_MODEL,
    temperature: 0,
    max_tokens: 600,
    messages: [
      { role: "system", content: RECALL_GATE_SYSTEM_PROMPT },
      { role: "user", content: clipForRecallGate(message) },
    ],
  };

  const call = async (extra: Record<string, unknown>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? RECALL_GATE_TIMEOUT_MS);
    try {
      return await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...extra }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response = await call({ reasoning_effort: "low" });
    if (response.status === 400 || response.status === 422) response = await call({});
    if (!response.ok) {
      console.warn(`[recallGate] HTTP ${response.status}`);
      return { decision: null, usage: null, latencyMs: Date.now() - started };
    }
    const data = await response.json();
    const usage = data?.usage
      ? {
          promptTokens: wholeNumber(data.usage.prompt_tokens),
          completionTokens: wholeNumber(data.usage.completion_tokens),
          totalTokens: wholeNumber(data.usage.total_tokens),
        }
      : null;
    return { decision: parseRecallDecision(data?.choices?.[0]?.message?.content), usage, latencyMs: Date.now() - started };
  } catch (e) {
    console.warn("[recallGate] failed:", e instanceof Error ? e.message : "unknown");
    return { decision: null, usage: null, latencyMs: Date.now() - started };
  }
}
