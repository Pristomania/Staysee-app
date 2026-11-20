import type { AdminCostKind, AdminCosts, AdminPersonRow } from './adminTypes';
import { costClassTitle, costKindTitle, formatMoscow, formatUsd, type CostClass } from './format';

/** What a row of the people table shows. Everything is ready text: the screen only places it. */
export function toPersonRow(row: AdminPersonRow) {
  return {
    id: row.user_id,
    email: row.email,
    label: row.label_title,
    labelKey: row.label_key,
    tier: row.tier ?? '—',
    lastLogin: formatMoscow(row.last_sign_in_at),
    registered: formatMoscow(row.registered_at),
    userCost: formatUsd(row.cost_user_usd),
    technicalCost: formatUsd(row.cost_technical_usd),
    conversations: row.conversations,
    messages: row.user_messages,
  };
}

/** The two cards of the costs: user first, technical second. */
export function splitCostTotals(totals: { user_usd: number | string; technical_usd: number | string }): Array<{ title: string; value: string }> {
  return [
    { title: costClassTitle('user'), value: formatUsd(totals.user_usd) },
    { title: costClassTitle('technical'), value: formatUsd(totals.technical_usd) },
  ];
}

/** What the calls of one class were for: plain names, only the rows of that class, in the order the server gave (biggest first). */
export function kindsForClass(kinds: AdminCostKind[], costClass: CostClass): Array<{ kind: string; calls: number; usd: string }> {
  return kinds
    .filter((item) => item.cost_class === costClass)
    .map((item) => ({ kind: costKindTitle(item.kind), calls: item.calls, usd: formatUsd(item.usd) }));
}

/** Whose cost a line is: the e-mail of a person, or one line for all the deleted accounts, or one for the calls made outside the app. */
function costOwnerTitle(item: AdminCosts['by_person'][number]): string {
  if (item.who === 'deleted') return 'Удалённые аккаунты';
  if (item.who === 'off_app') return 'Вне приложения (проверки и тесты)';
  return item.email ?? '—';
}

/** One tab of the costs screen: only the rows of the class asked for; days newest first (as DD.MM.YYYY, Moscow days). */
export function costsForClass(
  costs: AdminCosts,
  costClass: CostClass,
): {
  total: string;
  empty: boolean;
  kinds: Array<{ kind: string; calls: number; usd: string }>;
  days: Array<{ day: string; usd: string }>;
  people: Array<{ email: string; usd: string }>;
} {
  const total = costClass === 'technical' ? costs.totals.technical_usd : costs.totals.user_usd;
  const kinds = kindsForClass(costs.by_kind, costClass);
  const days = costs.by_day
    .filter((item) => item.cost_class === costClass)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map((item) => {
      const [year, month, day] = item.day.split('-');
      return { day: `${day}.${month}.${year}`, usd: formatUsd(item.usd) };
    });
  const people = costs.by_person
    .filter((item) => item.cost_class === costClass)
    .map((item) => ({ email: costOwnerTitle(item), usd: formatUsd(item.usd) }));
  return { total: formatUsd(total), empty: kinds.length === 0 && days.length === 0 && people.length === 0, kinds, days, people };
}

/** "51–100 of 120" and which arrows work. An offset beyond the end shows 0–0 and still lets the person go back. */
export function pageInfo(total: number, limit: number, offset: number): { from: number; to: number; hasPrev: boolean; hasNext: boolean } {
  const empty = total === 0 || offset >= total;
  return {
    from: empty ? 0 : offset + 1,
    to: empty ? 0 : Math.min(offset + limit, total),
    hasPrev: offset > 0,
    hasNext: offset + limit < total,
  };
}

/** What the panel says when a call failed. Plain words; nothing technical (no codes, no "403"). */
export function describeAdminError(reason: string): string {
  switch (reason) {
    case 'network':
      return 'Нет связи с сервером.';
    case 'password_stale':
    case 'no_session':
    case 'invalid_token':
      return 'Нужно войти заново.';
    case 'unknown_label':
      return 'Такой метки нет.';
    case 'unknown_user':
      return 'Такого человека нет.';
    case 'bad_request':
      return 'Запрос не принят.';
    default:
      return 'Не получилось. Попробуй ещё раз.';
  }
}

/** The question asked before a label is changed. */
export function labelChangeMessage(personEmail: string, fromTitle: string, toTitle: string): string {
  return `Поменять метку у ${personEmail}: ${fromTitle} → ${toTitle}?`;
}
