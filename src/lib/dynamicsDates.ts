import type { ProgressEntry } from './progressDiary';

const MS_PER_DAY = 86_400_000;

/** End of weekly window: entry_date (noon UTC) or created_at. */
export function weeklyWindowEnd(entry: ProgressEntry): Date {
  if (entry.entry_date?.trim()) {
    return new Date(`${entry.entry_date.trim()}T12:00:00`);
  }
  return new Date(entry.created_at);
}

/** Start = end − 7 days (same rule as backend weekly snapshots). */
export function weeklyWindowStart(entry: ProgressEntry): Date {
  const end = weeklyWindowEnd(entry);
  return new Date(end.getTime() - 7 * MS_PER_DAY);
}

function monthGenitive(monthIndex: number): string {
  const months = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];
  return months[monthIndex] ?? '';
}

/**
 * Examples: «7–14 июня 2026», «31 мая — 7 июня 2026».
 */
export function formatWeeklyPeriod(entry: ProgressEntry): string {
  const start = weeklyWindowStart(entry);
  const end = weeklyWindowEnd(entry);

  const sd = start.getDate();
  const ed = end.getDate();
  const sm = start.getMonth();
  const em = end.getMonth();
  const sy = start.getFullYear();
  const ey = end.getFullYear();

  if (sm === em && sy === ey) {
    return `${sd}–${ed} ${monthGenitive(em)} ${ey}`;
  }
  if (sy === ey) {
    return `${sd} ${monthGenitive(sm)} — ${ed} ${monthGenitive(em)} ${ey}`;
  }
  return `${sd} ${monthGenitive(sm)} ${sy} — ${ed} ${monthGenitive(em)} ${ey}`;
}
