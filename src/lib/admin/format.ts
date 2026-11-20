/** How the admin panel shows money, time and the two classes of costs. Moscow time; "—" when there is nothing to show. */

export type CostClass = 'user' | 'technical';

const usdFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `1,94 $`; the database can hand a number over as text, which is accepted. */
export function formatUsd(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(number)) return '—';
  return `${usdFormat.format(number)} $`;
}

const moscowFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `20.11.2026 04:21` in Moscow time. */
export function formatMoscow(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = Object.fromEntries(moscowFormat.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

export function costClassTitle(costClass: CostClass): string {
  return costClass === 'technical' ? 'Технические' : 'Пользовательские';
}
