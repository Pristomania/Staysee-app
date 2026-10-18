/**
 * Scheduled health check for the Memory V3 pipelines (the memory-health-check
 * function calls this once an hour). Unlike the diagnostic alert in
 * telegramAlert.ts -- which only fires from inside a chat request, on one
 * explicit error -- this looks at the recent record in the database, so it
 * still notices when a failure never raised an alert, when the pipeline never
 * ran at all, or when the chat itself is down.
 *
 * Privacy: works from aggregate counts only. An alert never names an account,
 * a conversation or a message.
 */

export const MEMORY_V3_HEALTH_ALERT_KEYS = ["health:failure_rate", "health:silent"] as const;
export type MemoryV3HealthAlertKey = (typeof MEMORY_V3_HEALTH_ALERT_KEYS)[number];

// A pipeline is unhealthy when at least MIN_BAD runs went wrong AND they are
// at least BAD_SHARE of all its runs in the window. The first bound ignores a
// single flaky call; the second ignores a few errors among many successes.
const MIN_BAD = 3;
const BAD_SHARE = 0.3;
// The dialogue pipeline runs for every conversation with new messages, so MANY
// user messages and no dialogue run at all means it is not running.
const SILENT_MIN_USER_MESSAGES = 20;

export interface MemoryV3PipelineHealth {
  succeeded: number;
  failed: number;
  stuck: number;
  failedByCode: Record<string, number>;
}

export interface MemoryV3HealthSnapshot {
  windowMinutes: number;
  userMessages: number;
  dialogue: MemoryV3PipelineHealth;
  lifecycle: MemoryV3PipelineHealth;
}

export interface MemoryV3HealthFinding {
  alertKey: MemoryV3HealthAlertKey;
  line: string;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function invalid(): never {
  throw new Error("invalid health snapshot");
}

function inspectPipeline(value: unknown): MemoryV3PipelineHealth {
  if (typeof value !== "object" || value === null) invalid();
  const row = value as Record<string, unknown>;
  if (!isCount(row.succeeded) || !isCount(row.failed) || !isCount(row.stuck)) invalid();
  const codes = row.failedByCode;
  if (typeof codes !== "object" || codes === null || Array.isArray(codes)) invalid();
  for (const count of Object.values(codes as Record<string, unknown>)) {
    if (!isCount(count)) invalid();
  }
  return {
    succeeded: row.succeeded as number,
    failed: row.failed as number,
    stuck: row.stuck as number,
    failedByCode: codes as Record<string, number>,
  };
}

function inspectSnapshot(value: unknown): MemoryV3HealthSnapshot {
  if (typeof value !== "object" || value === null) invalid();
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.windowMinutes) || (row.windowMinutes as number) <= 0) invalid();
  if (!isCount(row.userMessages)) invalid();
  return {
    windowMinutes: row.windowMinutes as number,
    userMessages: row.userMessages as number,
    dialogue: inspectPipeline(row.dialogue),
    lifecycle: inspectPipeline(row.lifecycle),
  };
}

const windowLabel = (minutes: number): string => (minutes % 60 === 0 ? `${minutes / 60} ч` : `${minutes} мин`);

function topCodes(codes: Record<string, number>): string {
  return Object.entries(codes)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, 3)
    .map(([code, count]) => `${code} (${count})`)
    .join(", ");
}

export function evaluateMemoryV3Health(snapshotValue: unknown): MemoryV3HealthFinding[] {
  const snapshot = inspectSnapshot(snapshotValue);
  const window = windowLabel(snapshot.windowMinutes);
  const findings: MemoryV3HealthFinding[] = [];

  for (const [name, label] of [["dialogue", "диалоговая"], ["lifecycle", "сквозная"]] as const) {
    const health = snapshot[name];
    const bad = health.failed + health.stuck;
    const total = health.succeeded + bad;
    if (bad >= MIN_BAD && bad / total >= BAD_SHARE) {
      const codes = topCodes(health.failedByCode);
      findings.push({
        alertKey: "health:failure_rate",
        line: `• ${label} память: ${bad} из ${total} запусков с ошибкой за ${window}` +
          (codes ? `. Чаще всего: ${codes}` : ""),
      });
    }
  }

  const dialogueRuns = snapshot.dialogue.succeeded + snapshot.dialogue.failed + snapshot.dialogue.stuck;
  if (snapshot.userMessages >= SILENT_MIN_USER_MESSAGES && dialogueRuns === 0) {
    findings.push({
      alertKey: "health:silent",
      line: `• за ${window} в чатах ${snapshot.userMessages} сообщений, а запусков диалоговой памяти нет совсем`,
    });
  }
  return findings;
}

const HEADERS: Record<MemoryV3HealthAlertKey, string> = {
  "health:failure_rate": "⚠️ StaySEE: память V3 часто ошибается",
  "health:silent": "⚠️ StaySEE: память V3 молчит",
};

// The health function runs without a signed-in user (a scheduler calls it), so
// this shared secret in a request header is its only gate. A function with no
// secret configured refuses everyone rather than letting everyone in. The
// comparison does not stop at the first differing byte.
export function authorizeMemoryV3HealthRequest(
  provided: string | null | undefined,
  expected: string | null | undefined,
): "ok" | "unauthorized" | "not_configured" {
  const want = typeof expected === "string" ? expected.trim() : "";
  if (want === "") return "not_configured";
  const got = typeof provided === "string" ? provided.trim() : "";
  const wantBytes = new TextEncoder().encode(want);
  const gotBytes = new TextEncoder().encode(got);
  let difference = wantBytes.length ^ gotBytes.length;
  for (let i = 0; i < wantBytes.length; i += 1) difference |= wantBytes[i] ^ (gotBytes[i] ?? 0);
  return difference === 0 && got !== "" ? "ok" : "unauthorized";
}

export interface MemoryV3HealthDeps {
  loadSnapshot: () => Promise<unknown>;
  // true when this key has not been alerted yet in the current hour.
  reserveAlertKey: (key: string) => Promise<boolean>;
  sendTelegram: (text: string) => Promise<void>;
  now: () => Date;
  // Evaluate and report only: nothing is reserved or sent.
  dryRun?: boolean;
  // Connectivity test: send one labelled message and read nothing. Proves that
  // alerts reach Telegram, which silence alone can never prove.
  test?: boolean;
}

// Every failure (database, Telegram) propagates: the caller turns it into an
// error response, so a broken monitor fails loudly instead of looking healthy.
export async function runMemoryV3HealthCheck(
  deps: MemoryV3HealthDeps,
): Promise<{ findings: string[]; alertsSent: string[] }> {
  if (deps.test === true) {
    await deps.sendTelegram(`✅ StaySEE: проверка связи с оповещениями памяти V3. Если ты видишь это сообщение, сигналы доходят.\nВремя: ${deps.now().toISOString()}`);
    return { findings: [], alertsSent: ["test"] };
  }
  const findings = evaluateMemoryV3Health(await deps.loadSnapshot());
  const keys = [...new Set(findings.map((finding) => finding.alertKey))];
  if (deps.dryRun === true) return { findings: keys, alertsSent: [] };

  const alertsSent: string[] = [];
  for (const key of keys) {
    if (!(await deps.reserveAlertKey(key))) continue;
    const text = [
      HEADERS[key],
      ...findings.filter((finding) => finding.alertKey === key).map((finding) => finding.line),
      `Время: ${deps.now().toISOString()}`,
    ].join("\n");
    await deps.sendTelegram(text);
    alertsSent.push(key);
  }
  return { findings: keys, alertsSent };
}

const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID = /^-?[1-9]\d{0,19}$/;

export async function sendMemoryV3HealthTelegram(options: {
  botToken: string | null | undefined;
  chatId: string | null | undefined;
  text: string;
  fetchImpl: (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status?: number }>;
}): Promise<void> {
  const { botToken, chatId } = options;
  if (typeof botToken !== "string" || !BOT_TOKEN.test(botToken) ||
      typeof chatId !== "string" || !CHAT_ID.test(chatId)) {
    throw new Error("telegram is not configured");
  }
  const response = await options.fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: options.text }),
  });
  // Deliberately not including the URL (it contains the bot token) in the error.
  if (!response || response.ok !== true) throw new Error(`telegram responded ${response?.status ?? "with no status"}`);
}
