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
 *
 * Cloud.ru is the main host. When it refuses (the key, or the balance: an empty balance answers 403) the same model is asked of OpenRouter
 * (the reserve balance) through the private route, and Cloud.ru is left alone for a few minutes: see searchProviders.ts.
 */

import { CLOUDRU_BASE_URL } from "./modelHost.ts";
import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";
import {
  OPENROUTER_BASE_URL,
  type OpenRouterAccess,
  type SwitchReason,
  cloudruIsPaused,
  cloudruLastRefusalStatus,
  pauseCloudru,
  resumeCloudru,
} from "./searchProviders.ts";

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
  /** What the host charged, when it says so (OpenRouter does): the cost log takes it as it is. */
  costUsd?: number;
}

export interface RecallGateResult {
  decision: RecallDecision | null;
  usage: RecallGateUsage | null;
  latencyMs: number;
  /** The provider refused the key (401, 403) or has no money (402): the caller raises the alert. */
  refusedStatus?: 401 | 402 | 403;
  /** Which host answered (or was the last asked). */
  provider: "cloudru" | "openrouter";
  /** The host could not be used: it refused, or it did not answer (a timeout, a server error). */
  failure?: "refused" | "unavailable";
  /** Set when the reserve (OpenRouter) was used instead of Cloud.ru, and why. */
  switchedBecause?: SwitchReason;
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

function readUsage(raw: unknown): RecallGateUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown };
  return {
    promptTokens: wholeNumber(u.prompt_tokens),
    completionTokens: wholeNumber(u.completion_tokens),
    totalTokens: wholeNumber(u.total_tokens),
    ...(typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? { costUsd: u.cost } : {}),
  };
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
      const refused = response.status === 401 || response.status === 402 || response.status === 403 ? response.status : undefined;
      return {
        decision: null,
        usage: null,
        latencyMs: Date.now() - started,
        provider: "cloudru",
        failure: refused ? "refused" : "unavailable",
        ...(refused ? { refusedStatus: refused } : {}),
      };
    }
    const data = await response.json();
    return { decision: parseRecallDecision(data?.choices?.[0]?.message?.content), usage: readUsage(data?.usage), latencyMs: Date.now() - started, provider: "cloudru" };
  } catch (e) {
    console.warn("[recallGate] failed:", e instanceof Error ? e.message : "unknown");
    return { decision: null, usage: null, latencyMs: Date.now() - started, provider: "cloudru", failure: "unavailable" };
  }
}

const OPENROUTER_GATE_TIMEOUT_MS = 5000;

/** The same question to the same model on OpenRouter (the reserve), through the private route. */
export async function askRecallGateOpenRouter(
  message: string,
  access: OpenRouterAccess & { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<RecallGateResult> {
  const started = Date.now();
  const fetchImpl = access.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), access.timeoutMs ?? OPENROUTER_GATE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access.apiKey}`, "Content-Type": "application/json", ...(access.extraHeaders ?? {}) },
      body: JSON.stringify({
        model: RECALL_GATE_MODEL,
        temperature: 0,
        max_tokens: 600,
        reasoning: { effort: "low", exclude: true },
        usage: { include: true },
        provider: OPENROUTER_PRIVATE_ROUTE,
        messages: [
          { role: "system", content: RECALL_GATE_SYSTEM_PROMPT },
          { role: "user", content: clipForRecallGate(message) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[recallGate] OpenRouter HTTP ${response.status}`);
      const refused = response.status === 401 || response.status === 402 || response.status === 403 ? response.status : undefined;
      return {
        decision: null,
        usage: null,
        latencyMs: Date.now() - started,
        provider: "openrouter",
        failure: refused ? "refused" : "unavailable",
        ...(refused ? { refusedStatus: refused } : {}),
      };
    }
    const data = await response.json();
    return { decision: parseRecallDecision(data?.choices?.[0]?.message?.content), usage: readUsage(data?.usage), latencyMs: Date.now() - started, provider: "openrouter" };
  } catch (e) {
    console.warn("[recallGate] OpenRouter failed:", e instanceof Error ? e.message : "unknown");
    return { decision: null, usage: null, latencyMs: Date.now() - started, provider: "openrouter", failure: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cloud.ru first; when it refuses or does not answer, the reserve on OpenRouter. After a refusal Cloud.ru is left alone for a few minutes
 * (a refused call costs time), then it is asked again, and a good answer from it ends the pause. An answer that is not the expected JSON
 * is not a failure of the host: it is returned as it is, without a second call.
 */
export async function askRecallGateWithFallback(
  message: string,
  config: {
    cloudru?: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string };
    openrouter?: OpenRouterAccess & { fetchImpl?: typeof fetch; timeoutMs?: number };
    now?: number;
  }
): Promise<RecallGateResult> {
  const now = config.now ?? Date.now();
  let switchedBecause: SwitchReason | undefined;
  let first: RecallGateResult | null = null;

  if (config.cloudru && !cloudruIsPaused(now)) {
    first = await askRecallGate(message, config.cloudru);
    if (!first.failure) {
      resumeCloudru();
      return first;
    }
    if (first.failure === "refused") pauseCloudru(now, first.refusedStatus);
    switchedBecause = first.failure === "refused" ? "refused" : "unavailable";
  } else if (config.cloudru) {
    switchedBecause = "paused";
  }

  const refusedStatus = first?.refusedStatus ?? (switchedBecause === "paused" ? cloudruLastRefusalStatus() : undefined);
  if (!config.openrouter) {
    return first ?? { decision: null, usage: null, latencyMs: 0, provider: "cloudru", failure: "unavailable", ...(refusedStatus ? { refusedStatus } : {}) };
  }
  const second = await askRecallGateOpenRouter(message, config.openrouter);
  return {
    ...second,
    ...(refusedStatus ? { refusedStatus } : {}),
    ...(switchedBecause ? { switchedBecause } : {}),
    latencyMs: second.latencyMs + (first?.latencyMs ?? 0),
  };
}
