/**
 * The description of pictures and the short version of a long message go to Cloud.ru first, to a model of ITS OWN placement ("Внутренняя" in its
 * documentation: it works inside the infrastructure of Cloud.ru, the data are neither logged nor stored there, nothing leaves it). A picture of a
 * correspondence or of a rash is as private as the memory, so it must not go to an "external" model (Gemini on OpenRouter was one).
 *
 * The callers (imageDescriber.ts, longMessageSummarizer.ts) build the request exactly as before, for OpenRouter and Gemini, and hand it to this
 * fetch. Here it is turned into a request to Cloud.ru; the answer is turned back into the shape of an OpenRouter answer, with the cost counted from
 * the price of the model (Cloud.ru does not send a cost, and a call without one would go unrecorded). When Cloud.ru refuses (an empty balance
 * answers 403 «Project not found») or does not answer, the ORIGINAL request goes on to OpenRouter and Gemini as it did until 22.11.2026, and the
 * owner is told once in half an hour. The pause after a refusal is the one the search and the memory share (searchProviders.ts).
 *
 * Chosen on 22.11.2026 with the real prompts of the app over its test pictures and long texts of the made-up conversation (see
 * knowledge/ and the note of the measurements): of the models of the own placement that see pictures, Qwen3.6-35B-A3B is the only practical one
 * (Kimi K2.6 counts a picture as 2,900 tokens against 1,270 and pours its reasoning into the answer, about 4-5 times dearer; Qwen3.5-397B is
 * 915 / 1,086 roubles). A picture costs about 0.32 roubles (Gemini about 0.27), a short version of a long message about 0.55 (Gemini 0.21).
 * The reasoning is switched off with `reasoning_effort: "none"` (without it 700-800 tokens are spent on thinking).
 */

import { CLOUDRU_BASE_URL } from "./modelHost.ts";
import { toOpenRouterShape } from "./memoryV3/modelRoute.ts";
import {
  cloudruIsPaused,
  cloudruLastRefusalStatus,
  pauseCloudru,
  resumeCloudru,
  type SwitchReason,
} from "./searchProviders.ts";

export interface CloudruFirstProfile {
  model: string;
  extra: Record<string, unknown>;
  /** Dollars for 1M tokens (roubles with VAT at 90 a dollar). */
  priceUsdPer1M: { input: number; output: number };
  /** Appended to the system text of the request on Cloud.ru only (the reserve gets the text as it was built). */
  systemAddendum?: string;
  /** Shorter than the time the caller gives the whole call, so that the reserve still has time. */
  timeoutMs: number;
}

/** Roubles with VAT from the catalog of Cloud.ru of 22.11.2026 (219.6 and 329.4 for 1M tokens) at 90 roubles a dollar. */
const QWEN_PRICE_USD_PER_1M = { input: 2.44, output: 3.66 };
/** The larger Qwen3.5-397B-A17B: 915 and 1,085.8 roubles with VAT. */
const QWEN_LARGE_PRICE_USD_PER_1M = { input: 10.17, output: 12.06 };

export const AUX_MODEL_PROFILES = {
  // 23.11.2026: on a real screenshot of a Telegram chat with replies (a blue frame with the name of the author of the QUOTED message above the text of
  // the reply) Qwen3.6-35B-A3B gave the answers of the son to the mother and the questions of the mother to the son in 5 of 5 descriptions, and with the
  // rules about frames added to the prompt still in 4 of 5. The larger Qwen3.5-397B-A17B (17B active) with the rules read it right 3 of 3 (and 6 of 6 on
  // a made-up chat of the same kind); without the rules it made the same mistake. It costs about 1.25 roubles a picture (Qwen3.6 0.32, Gemini about 0.2).
  image: {
    model: "Qwen/Qwen3.5-397B-A17B",
    extra: { reasoning_effort: "none" },
    priceUsdPer1M: QWEN_LARGE_PRICE_USD_PER_1M,
    timeoutMs: 15_000,
  },
  summary: {
    model: "Qwen/Qwen3.6-35B-A3B",
    extra: { reasoning_effort: "none" },
    priceUsdPer1M: QWEN_PRICE_USD_PER_1M,
    // Left to itself the model writes 1,600-2,400 characters where 600-1,000 are asked; counted in words it keeps to the size (750-1,070 of 5 of 5).
    systemAddendum: "\nОбъём: не больше 130 слов, примерно 6-8 предложений. Лишнее не пиши, мелочи опускай.",
    timeoutMs: 6_000,
  },
} as const satisfies Record<string, CloudruFirstProfile>;

export type AuxKind = keyof typeof AUX_MODEL_PROFILES;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function withAddendum(messages: unknown, addendum: string | undefined): unknown {
  if (!Array.isArray(messages) || !addendum) return messages;
  return messages.map((message, index) => {
    const m = asRecord(message);
    return index === 0 && m?.role === "system" && typeof m.content === "string" ? { ...m, content: m.content + addendum } : message;
  });
}

export interface CloudruFirstOptions {
  profile: CloudruFirstProfile;
  /** No key: everything goes to the reserve at once. */
  cloudru?: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string };
  /** The reserve: OpenRouter, with the request as the caller built it. */
  reserve?: { fetchImpl?: typeof fetch };
  now?: () => number;
  /** Called when the reserve was used instead of Cloud.ru (the chat raises the alert; it never breaks the reply). */
  onSwitch?: (info: { reason: SwitchReason; refusedStatus?: 401 | 402 | 403 }) => void | Promise<void>;
}

export function createCloudruFirstFetch(options: CloudruFirstOptions): typeof fetch {
  const { profile } = options;
  const now = options.now ?? (() => Date.now());

  const toReserve = async (url: string, init: RequestInit, reason: SwitchReason, refused?: 401 | 402 | 403) => {
    const sendFetch = options.reserve?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    try {
      await options.onSwitch?.({ reason, ...(refused ? { refusedStatus: refused } : {}) });
    } catch (e) {
      console.warn("[cloudruFirst] switch handler failed:", e instanceof Error ? e.message : "unknown");
    }
    return await sendFetch(url, init);
  };

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const requestInit = init ?? {};
    let body: JsonRecord;
    try {
      body = JSON.parse(String(requestInit.body)) as JsonRecord;
    } catch {
      // Not a request of the callers: sent as it is.
      return await (options.reserve?.fetchImpl ?? globalThis.fetch.bind(globalThis))(url, requestInit);
    }

    if (!options.cloudru) return await toReserve(url, requestInit, "unavailable");
    if (cloudruIsPaused(now())) return await toReserve(url, requestInit, "paused", cloudruLastRefusalStatus());

    const cloudruFetch = options.cloudru.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const controller = new AbortController();
    const outer = requestInit.signal;
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
    try {
      const response = await cloudruFetch(`${options.cloudru.baseUrl ?? CLOUDRU_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.cloudru.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: profile.model,
          messages: withAddendum(body.messages, profile.systemAddendum),
          stream: false,
          max_tokens: body.max_tokens,
          ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
          ...profile.extra,
        }),
        signal: controller.signal,
      });
      if (response.ok) {
        let shaped: JsonRecord | null = null;
        try {
          shaped = toOpenRouterShape(await response.json(), profile.priceUsdPer1M);
        } catch {
          shaped = null;
        }
        if (shaped) {
          resumeCloudru();
          return new Response(JSON.stringify(shaped), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return await toReserve(url, requestInit, "unavailable");
      }
      console.warn(`[cloudruFirst] Cloud.ru HTTP ${response.status}`);
      const refused = response.status === 401 || response.status === 402 || response.status === 403 ? response.status : undefined;
      if (refused) pauseCloudru(now(), refused);
      return await toReserve(url, requestInit, refused ? "refused" : "unavailable", refused);
    } catch (e) {
      // The caller's own deadline ended the request: nothing more is asked of anyone.
      if (outer?.aborted) throw e;
      console.warn("[cloudruFirst] Cloud.ru failed:", e instanceof Error ? e.name : "unknown");
      return await toReserve(url, requestInit, "unavailable");
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }) as typeof fetch;
}
