import type { AdminPersonRow } from './adminTypes';
import { costClassTitle, formatMoscow, formatUsd } from './format';

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
