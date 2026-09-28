/** Sends a Telegram alert for a conversation whose memory pipeline has gone
 * silent -- distinct from telegramAlert.ts, which only fires on an explicit
 * error diagnostic. Dedup for this alert type lives in the database
 * (flag_memory_v3_stale_conversations / memory_v3_stale_alerts), keyed by
 * (user_id, conversation_id, scope), which the existing
 * reserve_memory_v3_alert_window cannot express -- its alert_key is a closed
 * enum of global diagnostic codes, not a per-conversation key. This sender
 * is therefore a separate, minimal function rather than an extension of
 * that one. */

export interface MemoryV3StaleConversationRow {
  userId: string;
  conversationId: string;
  scope: "dialogue" | "lifecycle";
  newMessageCount: number;
}

export interface MemoryV3StaleAlertOptions {
  botToken: string | null | undefined;
  chatId: string | null | undefined;
  row: MemoryV3StaleConversationRow;
  fetchImpl: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
    },
  ) => Promise<unknown>;
}

const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID = /^-?[1-9]\d{0,19}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidRow(row: unknown): row is MemoryV3StaleConversationRow {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" && UUID.test(candidate.userId) &&
    typeof candidate.conversationId === "string" && UUID.test(candidate.conversationId) &&
    (candidate.scope === "dialogue" || candidate.scope === "lifecycle") &&
    Number.isSafeInteger(candidate.newMessageCount) && (candidate.newMessageCount as number) >= 0
  );
}

export async function sendMemoryV3StaleAlertSafely(
  options: MemoryV3StaleAlertOptions,
): Promise<void> {
  if (typeof options.botToken !== "string" || !BOT_TOKEN.test(options.botToken)) return;
  if (typeof options.chatId !== "string" || !CHAT_ID.test(options.chatId)) return;
  if (!isValidRow(options.row)) return;
  if (typeof options.fetchImpl !== "function") return;

  const { scope, newMessageCount } = options.row;
  try {
    // Privacy-safe by design, matching telegramAlert.ts: never names which
    // account or conversation -- that detail lives only in the
    // memory_v3_stale_alerts table for authorized follow-up.
    const text = [
      "🔇 StaySEE Memory V3 — тишина",
      `Память: ${scope === "dialogue" ? "по диалогу" : "сквозная"}`,
      `Новых сообщений без запуска: ${newMessageCount}`,
      "Подробности: таблица memory_v3_stale_alerts",
      `Время: ${new Date().toISOString()}`,
    ].join("\n");
    await options.fetchImpl(
      `https://api.telegram.org/bot${options.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: options.chatId, text }),
      },
    );
  } catch {
    // Operator alerting is best-effort and must never affect the reply path.
  }
}
