/**
 * Where the models of the background memory (Memory V3) are asked.
 *
 * The four adapters of the memory (the extractor of both pipelines, the reconciler of the dialogue, the reconciler of the lifecycle) build
 * their request the way OpenRouter wants it and send it through a `fetchImpl` they are given. This module is that `fetchImpl`:
 *
 *   1. the request is sent to Cloud.ru (the main host) with the model of the profile; the answer is returned in the shape the adapters expect;
 *   2. when Cloud.ru refuses (401, 402, 403: the key or an empty balance), does not answer (a timeout, a server error, 429) or answers with
 *      something that is not a chat answer, the same request is sent to OpenRouter (the reserve balance), through the private route the
 *      adapter already carries (no collection of data, zero retention);
 *   3. after a refusal Cloud.ru is left alone for a few minutes (searchProviders.ts: one pause for the search and the memory).
 *
 * The adapters, their schemas, the validators of the contract and the reducers are not touched: the model changes, nothing else.
 *
 * A short addendum is appended to the system text of the EXTRACTOR only: a model other than the one the instruction was written for writes
 * the claims in English, copies the lines or keeps trifles of the day unless it is told once more what is worth keeping. Measured on the made-up
 * conversation of nine months (21.11.2026): without it DeepSeek V4 Flash failed the contract in 2-4 runs of 29, with it in 0-1.
 */

import { CLOUDRU_BASE_URL } from "../modelHost.ts";
import {
  cloudruIsPaused,
  cloudruLastRefusalStatus,
  pauseCloudru,
  resumeCloudru,
  type SwitchReason,
} from "../searchProviders.ts";

export type MemoryPipeline = "dialogue" | "lifecycle";

export interface MemoryModelProfile {
  /** The id written into the runs table: the same whichever host answered. */
  recordedModel: string;
  cloudru: { model: string; extra: Record<string, unknown>; priceUsdPer1M: { input: number; output: number } };
  openrouter: { model: string; extra: Record<string, unknown> };
  /** Appended to the system text of the extractor (never to the reconciler). */
  extractorAddendum: string;
}

/**
 * The model of the memory, the same for both pipelines (DeepSeek V4.1 Flash), with a short addendum of its own for each.
 * Chosen on 22.11.2026 on the real pipeline of the app over the made-up conversation of nine months (23 facts to keep), the memory run
 * every 5 turns as in the database:
 *   - the dialogue memory: 22 of 23 facts (Gemini 3.7 Flash: 20-21), 0 failed runs of 101, 0.35 roubles a run (Gemini 0.85);
 *   - the memory between conversations: 8 facts in 10 items (Gemini: 7 in 8), 0 failed runs, 0.18 roubles a run (Gemini 0.46).
 * Rejected on the same data: gpt-oss-120b (the reconciler sometimes ignores everything: 0 items in a whole conversation), Kimi K2.6 (14 of 29
 * runs broke the contract), DeepSeek V4 Pro (2.3 roubles a run), Qwen 3.6 35B, GigaChat 10B. The reasoning of the model stays OFF: with it
 * 12 of 29 runs broke the contract. The reserve on OpenRouter (deepseek/deepseek-v4.1-flash, about 8 times cheaper) keeps the memory going
 * when Cloud.ru does not answer; its facts are a little fewer (19 of 23 in the dialogue).
 *
 * The addendum exists because the model otherwise writes dates as «2026-07» (the contract wants YYYY-MM-DD or null): that alone broke
 * every run whose window held a month named without a day (found by running each item of a failed answer alone through the real normalizer).
 */
const CLOUDRU_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash";
/** Roubles with VAT from the catalog of Cloud.ru of 22.11.2026 (64.94 and 194.81 for 1M tokens) at 90 roubles a dollar. */
const CLOUDRU_PRICE_USD_PER_1M = { input: 0.7216, output: 2.1646 };

const DIALOGUE_ADDENDUM = "\nДополнительные правила записи памяти:\n- Формулировки claim пиши ТОЛЬКО по-русски, сжато, одним предложением, в безличной форме («Имеется непереносимость лактозы», «Брата зовут Иван, он живёт в Омске»). Английские слова и слово «User» недопустимы.\n- Сохраняй только то, что стоит помнить долго: имена и отношения с близкими, возраст, место жительства, работа и профессия, здоровье и режим, привычки и занятия, планы и цели, значимые события и решения, ссоры и примирения с важными людьми, даты. Не сохраняй мелочи одного дня: что съел, погоду, очередь на почте, головную боль, сон, настроение, покупки, случайные бытовые дела, отдельные эмоции без события.\n- Не копируй реплику дословно: перескажи суть. Если фактов нет, верни пустой результат.\n- Поля eventTimeStart и eventTimeEnd заполняй только полной датой ГГГГ-ММ-ДД, когда человек назвал и месяц, и день. Если известен только месяц, сезон или год («в июле», «весной», «в прошлом году»), оставь поле null: неполные даты вроде «2026-07» или «2026» недопустимы.";
const LIFECYCLE_ADDENDUM = "\nДополнительные правила записи памяти:\n- Формулировки claim пиши ТОЛЬКО по-русски, сжато, одним предложением, в безличной форме. Английские слова и слово «User» недопустимы.\n- Сквозная память нужна всем будущим беседам с человеком. Записывай устойчивые факты о нём и его жизни, каждый отдельной записью: имена и роли близких людей и питомцев, возраст, город, профессию и работу, здоровье и ограничения, привычки и постоянные занятия, цели и планы, важные отношения и события, даты. Если человек просит запомнить что-то, запиши это.\n- Примеры: «Собаку зовут Рекс», «Живёт в Самаре», «Не переносит лактозу», «Дочери восемь лет», «Работает врачом в поликлинике», «Собирается в августе в отпуск к родителям».\n- Не записывай мелочи одного дня, настроение и случайные желания.\n- Поля eventTimeStart и eventTimeEnd заполняй только полной датой ГГГГ-ММ-ДД, когда человек назвал и месяц, и день. Если известен только месяц, сезон или год («в июле», «весной», «в прошлом году»), оставь поле null: неполные даты вроде «2026-07» или «2026» недопустимы.";

export const MEMORY_V3_MODEL_PROFILES: Record<MemoryPipeline, MemoryModelProfile> = {
  dialogue: {
    recordedModel: CLOUDRU_MODEL,
    cloudru: { model: CLOUDRU_MODEL, extra: { reasoning_effort: "none" }, priceUsdPer1M: CLOUDRU_PRICE_USD_PER_1M },
    openrouter: { model: OPENROUTER_MODEL, extra: { reasoning: { effort: "none" } } },
    extractorAddendum: DIALOGUE_ADDENDUM,
  },
  lifecycle: {
    recordedModel: CLOUDRU_MODEL,
    cloudru: { model: CLOUDRU_MODEL, extra: { reasoning_effort: "none" }, priceUsdPer1M: CLOUDRU_PRICE_USD_PER_1M },
    openrouter: { model: OPENROUTER_MODEL, extra: { reasoning: { effort: "none" } } },
    extractorAddendum: LIFECYCLE_ADDENDUM,
  },
};

const CLOUDRU_TIMEOUT_MS = 45_000;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/** The extractor and the reconciler are told apart by the name of the schema the adapter asks for. */
export function isExtractorRequest(body: JsonRecord): boolean {
  const format = asRecord(body.response_format);
  const schema = asRecord(format?.json_schema);
  return typeof schema?.name === "string" && schema.name.includes("extractor");
}

function withAddendum(messages: unknown, addendum: string): unknown {
  if (!Array.isArray(messages) || !addendum) return messages;
  return messages.map((message, index) => {
    const m = asRecord(message);
    return index === 0 && m?.role === "system" && typeof m.content === "string" ? { ...m, content: m.content + addendum } : message;
  });
}

/** What Cloud.ru answered, in the shape of an OpenRouter answer (and the cost in dollars, which the adapters record). */
export function toOpenRouterShape(
  answer: unknown,
  price: { input: number; output: number }
): JsonRecord | null {
  const data = asRecord(answer);
  const choice = asRecord(Array.isArray(data?.choices) ? data.choices[0] : null);
  const message = asRecord(choice?.message);
  if (!data || !choice || !message) return null;
  const usage = asRecord(data.usage) ?? {};
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return {
    id: data.id,
    model: data.model,
    choices: [
      {
        index: 0,
        finish_reason: choice.finish_reason,
        message: {
          role: message.role,
          content: message.content,
          ...(message.refusal !== undefined && message.refusal !== null ? { refusal: message.refusal } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens,
      cost: Math.round(((promptTokens * price.input + completionTokens * price.output) / 1e6) * 1e8) / 1e8,
    },
  };
}

export interface MemoryRoutedFetchOptions {
  profile: MemoryModelProfile;
  cloudru?: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number };
  /** The reserve. Its key is the one the adapter sends; the headers are the ones OpenRouter wants (referer, title). */
  openrouter?: { fetchImpl?: typeof fetch };
  now?: () => number;
  /** Called when the reserve was used instead of Cloud.ru (the chat raises the alert; it never breaks the memory). */
  onSwitch?: (info: { reason: SwitchReason; refusedStatus?: 401 | 402 | 403 }) => void | Promise<void>;
}

export function createMemoryV3RoutedFetch(options: MemoryRoutedFetchOptions): typeof fetch {
  const { profile } = options;
  const now = options.now ?? (() => Date.now());

  const toReserve = async (url: string, init: RequestInit, body: JsonRecord, extractor: boolean, reason: SwitchReason, refused?: 401 | 402 | 403) => {
    const sendFetch = options.openrouter?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const reserveBody = {
      ...body,
      model: profile.openrouter.model,
      ...profile.openrouter.extra,
      messages: extractor ? withAddendum(body.messages, profile.extractorAddendum) : body.messages,
    };
    try {
      await options.onSwitch?.({ reason, ...(refused ? { refusedStatus: refused } : {}) });
    } catch (e) {
      console.warn("[memoryV3:route] switch handler failed:", e instanceof Error ? e.message : "unknown");
    }
    return await sendFetch(url, { ...init, body: JSON.stringify(reserveBody) });
  };

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const requestInit = init ?? {};
    let body: JsonRecord;
    try {
      body = JSON.parse(String(requestInit.body)) as JsonRecord;
    } catch {
      // Not a request of the adapters: sent as it is.
      return await (options.openrouter?.fetchImpl ?? globalThis.fetch.bind(globalThis))(url, requestInit);
    }
    const extractor = isExtractorRequest(body);

    if (!options.cloudru) return await toReserve(url, requestInit, body, extractor, "unavailable");
    if (cloudruIsPaused(now())) {
      return await toReserve(url, requestInit, body, extractor, "paused", cloudruLastRefusalStatus());
    }

    const cloudruFetch = options.cloudru.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const controller = new AbortController();
    const outer = requestInit.signal;
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.cloudru.timeoutMs ?? CLOUDRU_TIMEOUT_MS);
    try {
      const response = await cloudruFetch(`${options.cloudru.baseUrl ?? CLOUDRU_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.cloudru.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: profile.cloudru.model,
          messages: extractor ? withAddendum(body.messages, profile.extractorAddendum) : body.messages,
          stream: false,
          max_tokens: body.max_tokens,
          response_format: body.response_format,
          ...profile.cloudru.extra,
        }),
        signal: controller.signal,
      });
      if (response.ok) {
        let shaped: JsonRecord | null = null;
        try {
          shaped = toOpenRouterShape(await response.json(), profile.cloudru.priceUsdPer1M);
        } catch {
          shaped = null;
        }
        if (shaped) {
          resumeCloudru();
          return new Response(JSON.stringify(shaped), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return await toReserve(url, requestInit, body, extractor, "unavailable");
      }
      console.warn(`[memoryV3:route] Cloud.ru HTTP ${response.status}`);
      const refused = response.status === 401 || response.status === 402 || response.status === 403 ? response.status : undefined;
      if (refused) pauseCloudru(now(), refused);
      return await toReserve(url, requestInit, body, extractor, refused ? "refused" : "unavailable", refused);
    } catch (e) {
      // The adapter's own deadline ended the request: nothing more is asked of anyone.
      if (outer?.aborted) throw e;
      console.warn("[memoryV3:route] Cloud.ru failed:", e instanceof Error ? e.name : "unknown");
      return await toReserve(url, requestInit, body, extractor, "unavailable");
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }) as typeof fetch;
}
