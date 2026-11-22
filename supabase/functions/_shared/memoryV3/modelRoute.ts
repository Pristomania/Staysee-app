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
  cloudru: {
    model: string;
    extra: Record<string, unknown>;
    priceUsdPer1M: { input: number; output: number };
    /** Appended to the system text of the reconciler on Cloud.ru only (the reserve keeps the plain text the adapter sends). */
    reconcilerAddendum?: string;
  };
  openrouter: { model: string; extra: Record<string, unknown> };
  /** Appended to the system text of the extractor (never to the reconciler). */
  extractorAddendum: string;
}

/**
 * The model of the memory, the same for both pipelines: gpt-oss-120b on Cloud.ru, a model of the OWN placement of Cloud.ru ("Внутренняя" in its
 * documentation: it works inside the infrastructure of Cloud.ru, the data are neither logged nor stored there, nothing leaves it).
 * The memory holds what people tell about their health and their families, so it must not go to an "external" model (the documentation says
 * the data of those leave Cloud.ru, and names neither the operator nor the country); the rules of protection of Cloud.ru mask only phones,
 * e-mails, numbers of documents and cards, keys and IPs, not names or health, so they are no help here.
 *
 * Chosen on 22.11.2026 on the real pipeline of the app (its runners, contracts and this route) over the made-up conversation of nine months
 * (23 facts to keep), the memory run after every 10 new messages as in the database, 3 repeats:
 *   - both memories together keep 22, 22 and 21-22 of 23 facts (DeepSeek V4.1 Flash, which is NOT of the own placement of Cloud.ru: 23 of 23);
 *   - 1-2 failed runs of 31 (the same as V4.1 Flash: 2 of 32); the cost of the memory about 0.06 roubles a turn (V4.1 Flash 0.19, V4 Pro about 0.74).
 * Rejected on the same data: GigaChat-3-Pro (more than half of the runs broke the contract, 1 item kept), GigaChat 3.5-432B (half of the
 * runs broke the contract), Qwen3-Coder-Next (it misses the facts a person asks to remember, 6.5 times dearer), Kimi K2.6 and V4 Pro (about 0.7
 * roubles a turn). The reasoning of the model is set to "low" (the lowest the host takes).
 *
 * Two addenda make it keep the contract and the facts. The extractor addendum: the model otherwise writes dates as «2026-07» (the contract
 * wants YYYY-MM-DD or null). The reconciler addendum (Cloud.ru only): without it gpt-oss answers "ignore" to nearly every candidate (0 items in a
 * whole conversation, as in the first measurements); with it the memory is kept, and an event with close people is not dropped as a trifle.
 * The reserve on OpenRouter stays DeepSeek V4.1 Flash (gpt-oss on the private route of OpenRouter gave garbage answers and "ignore" again).
 */
const CLOUDRU_MODEL = "openai/gpt-oss-120b";
const OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash";
/** Roubles with VAT from the catalog of Cloud.ru of 22.11.2026 (15.86 and 61 for 1M tokens) at 90 roubles a dollar. */
const CLOUDRU_PRICE_USD_PER_1M = { input: 0.1762, output: 0.6778 };
const CLOUDRU_RECONCILER_ADDENDUM = "\n\nДополнительные правила сверки:\n- Кандидат, который сообщает новый устойчивый факт о человеке (имя, возраст, город, работа, здоровье, близкие люди, привычки, планы, важные события жизни), а среди существующих записей нет такого же по смыслу, нужно записать: тип create. Тип ignore допустим только для повтора уже записанного, мелочи одного дня или догадки без опоры на слова человека.\n- Событие, которое касается близких людей или переломов в жизни (ссоры, потери, болезни, расставания, важные решения), не мелочь и не повод для ignore: это create, даже если оно рассказано один раз и с сильными эмоциями.\n- Если такая запись уже есть и кандидат повторяет её, это confirm; если кандидат уточняет или меняет её, это revise.\n- Не отвечай ignore на все кандидаты подряд: разбери каждого отдельно.";

const DIALOGUE_ADDENDUM = "\nДополнительные правила записи памяти:\n- Формулировки claim пиши ТОЛЬКО по-русски, сжато, одним предложением, в безличной форме («Имеется непереносимость лактозы», «Брата зовут Иван, он живёт в Омске»). Английские слова и слово «User» недопустимы.\n- Сохраняй только то, что стоит помнить долго: имена и отношения с близкими, возраст, место жительства, работа и профессия, здоровье и режим, привычки и занятия, планы и цели, значимые события и решения, ссоры и примирения с важными людьми, даты. Не сохраняй мелочи одного дня: что съел, погоду, очередь на почте, головную боль, сон, настроение, покупки, случайные бытовые дела, отдельные эмоции без события.\n- Не копируй реплику дословно: перескажи суть. Если фактов нет, верни пустой результат.\n- Поля eventTimeStart и eventTimeEnd заполняй только полной датой ГГГГ-ММ-ДД, когда человек назвал и месяц, и день. Если известен только месяц, сезон или год («в июле», «весной», «в прошлом году»), оставь поле null: неполные даты вроде «2026-07» или «2026» недопустимы.";
const LIFECYCLE_ADDENDUM = "\nДополнительные правила записи памяти:\n- Формулировки claim пиши ТОЛЬКО по-русски, сжато, одним предложением, в безличной форме. Английские слова и слово «User» недопустимы.\n- Сквозная память нужна всем будущим беседам с человеком. Записывай устойчивые факты о нём и его жизни, каждый отдельной записью: имена и роли близких людей и питомцев, возраст, город, профессию и работу, здоровье и ограничения, привычки и постоянные занятия, цели и планы, важные отношения и события, даты. Если человек просит запомнить что-то, запиши это.\n- Примеры: «Собаку зовут Рекс», «Живёт в Самаре», «Не переносит лактозу», «Дочери восемь лет», «Работает врачом в поликлинике», «Собирается в августе в отпуск к родителям».\n- Не записывай мелочи одного дня, настроение и случайные желания.\n- Поля eventTimeStart и eventTimeEnd заполняй только полной датой ГГГГ-ММ-ДД, когда человек назвал и месяц, и день. Если известен только месяц, сезон или год («в июле», «весной», «в прошлом году»), оставь поле null: неполные даты вроде «2026-07» или «2026» недопустимы.";

export const MEMORY_V3_MODEL_PROFILES: Record<MemoryPipeline, MemoryModelProfile> = {
  dialogue: {
    recordedModel: CLOUDRU_MODEL,
    cloudru: { model: CLOUDRU_MODEL, extra: { reasoning_effort: "low" }, priceUsdPer1M: CLOUDRU_PRICE_USD_PER_1M, reconcilerAddendum: CLOUDRU_RECONCILER_ADDENDUM },
    openrouter: { model: OPENROUTER_MODEL, extra: { reasoning: { effort: "none" } } },
    extractorAddendum: DIALOGUE_ADDENDUM,
  },
  lifecycle: {
    recordedModel: CLOUDRU_MODEL,
    cloudru: { model: CLOUDRU_MODEL, extra: { reasoning_effort: "low" }, priceUsdPer1M: CLOUDRU_PRICE_USD_PER_1M, reconcilerAddendum: CLOUDRU_RECONCILER_ADDENDUM },
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
          messages: withAddendum(body.messages, extractor ? profile.extractorAddendum : profile.cloudru.reconcilerAddendum ?? ""),
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
