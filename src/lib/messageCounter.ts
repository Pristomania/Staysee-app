import { monthsPhrase, planFor } from './plans';

/**
 * The counter of messages the person sees in the cabinet and the warning before the end. It repeats the rules the
 * database applies when a message arrives (reserve_ai_request, migrations 085 to 088), so what is shown is what will
 * happen: a paid plan counts a period of its length from the first message; the free plan's messages come back
 * 3 calendar months after the last answered message; an unlimited account has no counter.
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

export interface MessageCounter {
  unlimited: boolean;
  total: number;
  used: number;
  remaining: number;
  /** When the messages are renewed or come back; null when nothing is known to renew (a fresh period). */
  renewsAt: Date | null;
  /** True from WARN_AT_REMAINING messages left until the end. Never for an unlimited account. */
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

export function messageCounter(row: UsageRow | null | undefined, now: Date = new Date()): MessageCounter | null {
  if (!row) return null;
  const plan = planFor(row.tier);
  const total = plan.messages;
  const stored = Math.max(0, Math.floor(Number(row.period_requests_used ?? 0)) || 0);
  const periodStart = parseDate(row.period_started_at);
  const lastRequest = parseDate(row.last_request_at);

  if (row.unlimited_usage === true) {
    return { unlimited: true, total, used: stored, remaining: Math.max(0, total - stored), renewsAt: null, warn: false };
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
  return { unlimited: false, total, used: Math.min(used, total), remaining, renewsAt, warn: remaining <= WARN_AT_REMAINING };
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
  if (counter.remaining === 0) return 'Сообщения закончились';
  return `Осталось ${counter.remaining} из ${counter.total} ${pluralMessages(counter.total)}`;
}

/** The warning above the composer, from ten messages left. */
export function lowMessagesLine(counter: MessageCounter): string {
  if (counter.remaining === 0) return 'Сообщения закончились';
  if (counter.remaining === 1) return 'Остаётся 1 сообщение';
  return `Осталось ${counter.remaining} ${pluralMessages(counter.remaining)}`;
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
