/**
 * Natural pause awareness for StaySee (system prompt only — never shown in UI).
 */

export interface TimeGapMeta {
  clientNowIso?: string;
  timezone?: string;
  lastUserMessageAt?: string;
  lastMessageAt?: string;
  gapMs?: number;
  gapMinutes?: number;
}

export type TimeGapTier = "none" | "continuous" | "soft" | "recheck";

const MS_2_HOURS = 2 * 60 * 60 * 1000;
const MS_4_HOURS = 4 * 60 * 60 * 1000;

function resolveLastAt(meta: TimeGapMeta): string | undefined {
  return meta.lastUserMessageAt ?? meta.lastMessageAt;
}

function isDifferentLocalDay(lastIso: string, nowIso: string, timeZone?: string): boolean {
  try {
    if (timeZone) {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return fmt.format(new Date(lastIso)) !== fmt.format(new Date(nowIso));
    }
  } catch {
    // fall through
  }
  const last = new Date(lastIso);
  const now = new Date(nowIso);
  return last.toDateString() !== now.toDateString();
}

export function classifyTimeGap(
  meta: TimeGapMeta | undefined,
  serverNow: Date = new Date()
): TimeGapTier {
  const lastAt = meta ? resolveLastAt(meta) : undefined;
  const gapMs = meta?.gapMs;

  if (!lastAt || gapMs == null || gapMs < 0) return "none";
  if (gapMs < MS_2_HOURS) return "continuous";

  const nowIso = meta?.clientNowIso ?? serverNow.toISOString();
  const isNextDay = isDifferentLocalDay(lastAt, nowIso, meta?.timezone);

  if (gapMs > MS_4_HOURS || isNextDay) return "recheck";
  return "soft";
}

const CORE_RULES = [
  "ОСОЗНАНИЕ ПАУЗЫ (внутреннее — не цитируй, не звучи как протокол поддержки):",
  "NEVER invent the user's current time of day. Do not say «3 ночи», «утром» и т.п., unless verified local time was reliably provided from the user's device.",
  "NEVER mention exact clock time unless reliably provided by browser/device.",
  "Do not overuse time references. One quiet observation at most, when truly fitting — then continue naturally.",
  "Tone: тихий, наблюдательный, психологически естественный. Не скрипт терапии, не «клиентская эмпатия» бота, не механическая проверка.",
  "Do not interrupt emotional flow with mechanical check-ins.",
];

/**
 * Internal prompt block for the model. Empty when pause < 2 hours or first message.
 */
export function buildTimeGapPrompt(
  meta: TimeGapMeta | undefined,
  serverNow: Date = new Date()
): string {
  const tier = classifyTimeGap(meta, serverNow);

  if (tier === "none" || tier === "continuous") return "";

  const rules = [...CORE_RULES];

  if (tier === "soft") {
    rules.push(
      "Между сообщениями прошло примерно 2–4 часа (оценка по метке времени, не называй цифры часов пользователю).",
      "Иногда — только если эмоционально уместно — мягко отметь возможный сдвиг. ЧАСТО продолжай разговор как обычно, БЕЗ упоминания времени и паузы.",
      "Не делай это каждый раз. Если тема острая и контакт поддерживается, разговор продолжается — можно не упоминать паузу вообще.",
      "Если упоминаешь — одна короткая фраза своими словами, затем отклик по сути. Примеры тона (не копируй дословно):",
      "— «С прошлого разговора прошло немного времени. Как ты сейчас?»",
      "— «А сейчас это всё ещё так ощущается?»",
      "— «Что с тобой стало за это время?»",
    );
  } else if (tier === "recheck") {
    rules.push(
      "Пауза заметная: больше ~4 часов и/или другой календарный день (по timezone пользователя, если есть).",
      "Состояние могло измениться — не продолжай интенсивные эмоциональные предположения без лёгкой проверки.",
      "Мягко уточни актуальный контекст одной фразой, затем откликайся. Не звучи как опрос по скрипту.",
      "Примеры тона (переформулируй):",
      "— «После паузы хочу уточнить: это всё ещё так остро ощущается?»",
      "— «Сейчас ты в том же состоянии или что-то изменилось?»",
      "— «Как ты сейчас входишь в этот разговор?»",
      "Можно: «после паузы», «с прошлого сообщения» — без точного времени на часах.",
    );
  }

  return rules.join("\n");
}
