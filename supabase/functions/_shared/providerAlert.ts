/**
 * A short alert to the founder's Telegram when the model host refuses the key or has no money left.
 * No user data in it. Fail-open: an alert that cannot be sent never breaks a reply. At most one alert of a kind in half an hour
 * per running copy of the function (a restart of the copy may repeat it; that is acceptable for a rare event).
 * The bot and the chat are the ones of the Memory V3 alerts (the same secrets).
 */

export type ProviderAlertKind = "balance_empty" | "key_rejected" | "search_balance_empty" | "search_key_rejected";

const TEXT: Record<ProviderAlertKind, string> = {
  balance_empty:
    "⚠️ StaySee: на Cloud.ru закончились деньги (ответ 402). Ответы идут на запасную модель; если и она недоступна, люди видят «Сейчас не могу ответить». Нужно пополнить баланс.",
  key_rejected: "⚠️ StaySee: Cloud.ru не принимает ключ (ответ 401 или 403). Проверь секрет CLOUDRU_API_KEY.",
  // The small model and the reranker of the search in the past (the chat itself is not touched: it goes on, only the remembering gets worse).
  search_balance_empty:
    "⚠️ StaySee: на Cloud.ru закончились деньги (ответ 402) для поиска по прошлым сообщениям. Ответы идут, но Стейси хуже вспоминает прежнее. Нужно пополнить баланс.",
  search_key_rejected:
    "⚠️ StaySee: Cloud.ru не принимает ключ (ответ 401 или 403) для поиска по прошлым сообщениям. Ответы идут, но Стейси хуже вспоминает прежнее. Проверь секрет CLOUDRU_API_KEY: ключ создан 17.11.2026 на 90 дней, до 15.02.2027.",
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
