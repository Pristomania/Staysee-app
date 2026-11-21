/**
 * A short alert to the founder's Telegram when the model host refuses the key or has no money left.
 * No user data in it. Fail-open: an alert that cannot be sent never breaks a reply. At most one alert of a kind in half an hour
 * per running copy of the function (a restart of the copy may repeat it; that is acceptable for a rare event).
 * The bot and the chat are the ones of the Memory V3 alerts (the same secrets).
 */

import type { SwitchReason } from "./searchProviders.ts";

export type ProviderAlertKind = "balance_empty" | "key_rejected" | "search_balance_empty" | "search_key_rejected" | "search_failed" | "search_switched";

const TEXT: Record<ProviderAlertKind, string> = {
  balance_empty:
    "⚠️ StaySee: на Cloud.ru закончились деньги (ответ 402). Ответы идут на запасную модель; если и она недоступна, люди видят «Сейчас не могу ответить». Нужно пополнить баланс.",
  key_rejected: "⚠️ StaySee: Cloud.ru не принимает ключ (ответ 401 или 403). Сначала проверь баланс в кабинете Cloud.ru: при пустом балансе (21.11.2026) пришёл именно 403 «Project not found». Потом проверь секрет CLOUDRU_API_KEY.",
  // The small model and the reranker of the search in the past (the chat itself is not touched: it goes on, only the remembering gets worse).
  search_balance_empty:
    "⚠️ StaySee: на Cloud.ru закончились деньги (ответ 402) для поиска по прошлым сообщениям. Ответы идут, но Стейси хуже вспоминает прежнее. Нужно пополнить баланс.",
  search_key_rejected:
    "⚠️ StaySee: Cloud.ru не принимает ключ (ответ 401 или 403) для поиска по прошлым сообщениям. Ответы идут, но Стейси хуже вспоминает прежнее. Сначала проверь баланс в кабинете Cloud.ru: при пустом балансе (21.11.2026) пришёл именно 403 «Project not found». Потом проверь секрет CLOUDRU_API_KEY: ключ создан 17.11.2026 на 90 дней, до 15.02.2027.",
  // The search by meaning in the conversation failed (the database refused or the vector of the question could not be made): the answer goes on,
  // but the person's past is found by literal words only. It was silent on 21.11.2026 (a statement timeout under the person's own rights).
  // Cloud.ru refused (an empty balance answers 403 «Project not found») but the search goes on through the reserve on OpenRouter:
  // a calm message, the money is to be put on Cloud.ru; the app returns to it by itself within minutes of it answering.
  search_switched:
    "⚠️ StaySee: Cloud.ru не принимает запросы поиска по прошлым сообщениям (ответ 402 или 403, чаще всего закончился баланс). Поиск «вспомни» продолжает работать полноценно через запасной баланс на OpenRouter, расход идёт оттуда. Пополни Cloud.ru: приложение само вернётся на него в течение нескольких минут.",
  search_failed:
    "⚠️ StaySee: поиск по смыслу в беседе не отработал (ошибка базы или векторов вопроса). Ответы идут, но Стейси находит прошлое только по буквальным словам. Нужно смотреть журнал функции staysee-chat.",
};

const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID = /^-?[1-9]\d{0,19}$/;
export const PROVIDER_ALERT_WINDOW_MS = 30 * 60_000;

const lastSentAt = new Map<ProviderAlertKind, number>();

export interface ProviderAlertOptions {
  now?: number;
  botToken?: string | null;
  chatId?: string | null;
  fetchImpl?: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean }>;
}

/** Test hook: forget what was sent. */
export function resetProviderAlertsForTests(): void {
  lastSentAt.clear();
}

export async function sendProviderAlertSafely(kind: ProviderAlertKind, options: ProviderAlertOptions = {}): Promise<boolean> {
  try {
    const now = options.now ?? Date.now();
    const previous = lastSentAt.get(kind);
    if (previous !== undefined && now - previous < PROVIDER_ALERT_WINDOW_MS) return false;

    const botToken = options.botToken ?? (typeof Deno !== "undefined" ? Deno.env.get("STAYSEE_MEMORY_V3_ALERT_TELEGRAM_BOT_TOKEN") : undefined);
    const chatId = options.chatId ?? (typeof Deno !== "undefined" ? Deno.env.get("STAYSEE_MEMORY_V3_ALERT_TELEGRAM_CHAT_ID") : undefined);
    if (typeof botToken !== "string" || !BOT_TOKEN.test(botToken) || typeof chatId !== "string" || !CHAT_ID.test(chatId)) return false;

    // Marked before the call: a second failure in the same moment must not send a second alert.
    lastSentAt.set(kind, now);
    const send = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const response = await send(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: TEXT[kind] }),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok === true;
  } catch {
    return false;
  }
}


/**
 * Which alert the search raises after the small model or the reranker was asked.
 * A host answered through the reserve because Cloud.ru refused (or was left alone after a refusal): the calm «search_switched».
 * Nobody answered and Cloud.ru refused: the alert about the balance (402) or the key (401, 403): the remembering is worse.
 * Anything else (a timeout, an unreadable answer): no alert.
 */
export function searchAlertKind(outcome: {
  served: boolean;
  refusedStatus?: 401 | 402 | 403;
  switchedBecause?: SwitchReason;
}): ProviderAlertKind | null {
  if (outcome.served) return outcome.switchedBecause === "refused" || outcome.switchedBecause === "paused" ? "search_switched" : null;
  if (outcome.refusedStatus) return outcome.refusedStatus === 402 ? "search_balance_empty" : "search_key_rejected";
  return null;
}
