import { monthsPhrase, planFor } from './plans';

/**
 * The counter of messages the person sees in the cabinet and the warning before the end. It repeats the rules the
 * database applies when a message arrives (reserve_ai_request, migrations 085 to 088), so what is shown is what will
 * happen: a paid plan counts a period of its length from the first message; the free plan's messages come back
 * 3 calendar months after the last answered message; an unlimited account has no counter.
 *
 * Bought messages (migration 090) are added to what is left: they are spent after the plan's own messages.
 *
 * The hidden spending ceiling is not shown and not counted here: the person sees messages only.
 */

/** The warning starts when this many messages are left (and stays until the end). */
export const WARN_AT_REMAINING = 10;

/** The columns of the person's usage row the counter reads. Every one may be missing: the database may be older. */
export interface UsageRow {
  tier?: string | null;
  period_requests_used?: number | null;
  period_started_at?: string | null;
  last_request_at?: string | null;
  unlimited_usage?: boolean | null;
  /** A number of conversations given by hand instead of the plan's (migration 087). */
  max_conversations_override?: number | null;
}

/** A pack of bought messages as the database stores it; every column may be missing. */
export interface PackRow {
  messages_left?: number | null;
  expires_at?: string | null;
  voided_at?: string | null;
}

export interface MessageCounter {
  unlimited: boolean;
  total: number;
  used: number;
  /** The plan's own messages left. */
  remaining: number;
  /** Bought messages left (packs that are not expired and not voided). */
  packRemaining: number;
  /** Everything the person can still send: the plan's messages and the bought ones. */
  available: number;
  /** When the messages are renewed or come back; null when nothing is known to renew (a fresh period). */
  renewsAt: Date | null;
  /** True from WARN_AT_REMAINING messages available until the end. Never for an unlimited account. */
  warn: boolean;
}

const DAY_MS = 86_400_000;

/** Same as Postgres `timestamp + interval 'n months'`: a day that does not exist in the month becomes its last day. */
function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The bought messages that can still be spent: not used up, not voided, not expired. Same as reserve_ai_request. */
export function packMessagesLeft(packs: PackRow[] | null | undefined, now: Date = new Date()): number {
  let sum = 0;
  for (const pack of packs ?? []) {
    const left = Math.max(0, Math.floor(Number(pack.messages_left ?? 0)) || 0);
    const expires = parseDate(pack.expires_at);
    if (left > 0 && !pack.voided_at && expires && expires.getTime() > now.getTime()) sum += left;
  }
  return sum;
}

export function messageCounter(
  row: UsageRow | null | undefined,
  now: Date = new Date(),
  packs: PackRow[] | null | undefined = null,
): MessageCounter | null {
  if (!row) return null;
  const plan = planFor(row.tier);
  const total = plan.messages;
  const stored = Math.max(0, Math.floor(Number(row.period_requests_used ?? 0)) || 0);
  const periodStart = parseDate(row.period_started_at);
  const lastRequest = parseDate(row.last_request_at);

  if (row.unlimited_usage === true) {
    const left = Math.max(0, total - stored);
    return { unlimited: true, total, used: stored, remaining: left, packRemaining: 0, available: left, renewsAt: null, warn: false };
  }

  let used = stored;
  let renewsAt: Date | null = null;

  if (plan.renewAfterIdleMonths !== null) {
    // The free plan: counted from the last answered message (from the period start while nobody answered yet).
    const reference = lastRequest ?? periodStart;
    if (reference) {
      const comeBack = addCalendarMonths(reference, plan.renewAfterIdleMonths);
      if (now.getTime() >= comeBack.getTime()) used = 0;
      else renewsAt = comeBack;
    }
  } else if (plan.periodDays !== null && periodStart) {
    // A paid plan: a period of its length; after it a new one starts with the next message.
    const end = new Date(periodStart.getTime() + plan.periodDays * DAY_MS);
    if (now.getTime() - periodStart.getTime() > plan.periodDays * DAY_MS) used = 0;
    else renewsAt = end;
  }

  const remaining = Math.max(0, total - used);
  const packRemaining = packMessagesLeft(packs, now);
  const available = remaining + packRemaining;
  return { unlimited: false, total, used: Math.min(used, total), remaining, packRemaining, available, renewsAt, warn: available <= WARN_AT_REMAINING };
}

/** "сообщение", "сообщения", "сообщений" for the number. */
export function pluralMessages(count: number): string {
  const n = Math.abs(Math.floor(count));
  const last = n % 10;
  if (n % 100 >= 11 && n % 100 <= 14) return 'сообщений';
  if (last === 1) return 'сообщение';
  if (last >= 2 && last <= 4) return 'сообщения';
  return 'сообщений';
}

/** The line of the counter in the cabinet. */
export function counterLine(counter: MessageCounter): string {
  if (counter.unlimited) return 'Без ограничений';
  if (counter.available === 0) return 'Сообщения закончились';
  // The plan's messages are spent first; the bought ones are named on their own.
  if (counter.packRemaining === 0) return `Осталось ${counter.remaining} из ${counter.total} ${pluralMessages(counter.total)}`;
  if (counter.remaining === 0) return `Осталось ${counter.packRemaining} ${pluralMessages(counter.packRemaining)} из докупленных`;
  return `Осталось ${counter.remaining} из ${counter.total} ${pluralMessages(counter.total)} · докупленных ${counter.packRemaining}`;
}

/** The warning above the composer, from ten messages left. */
export function lowMessagesLine(counter: MessageCounter): string {
  if (counter.available === 0) return 'Сообщения закончились';
  if (counter.available === 1) return 'Остаётся 1 сообщение';
  return `Осталось ${counter.available} ${pluralMessages(counter.available)}`;
}

/** When the messages return or renew; an empty line when nothing is known. */
export function renewalLine(counter: MessageCounter, tier: unknown): string {
  if (counter.unlimited) return '';
  const plan = planFor(tier);
  if (plan.renewAfterIdleMonths !== null) {
    return `Новые ${plan.messages} ${pluralMessages(plan.messages)} появятся через ${monthsPhrase(plan.renewAfterIdleMonths)} после последнего сообщения`;
  }
  if (!counter.renewsAt) return '';
  const date = counter.renewsAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `Обновится ${date}`;
}
