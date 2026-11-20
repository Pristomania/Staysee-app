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

/** What a call was for, in plain words. A kind nobody has named yet is shown as it is: a cost is never hidden behind a missing name. */
const COST_KIND_TITLES: Record<string, string> = {
  reply: 'Ответы Стейси',
  memory_dialogue_extractor: 'Память: выделение фактов из беседы',
  memory_dialogue_reconciler: 'Память: сверка фактов',
  memory_lifecycle_extractor: 'Память: жизненные события, выделение',
  memory_lifecycle_reconciler: 'Память: жизненные события, сверка',
  memory_v3_topic_backfill: 'Память: разметка тем (разовая)',
  legacy_conversation_summary: 'Пересказ беседы (старая память)',
  long_message_summary: 'Сжатие длинных сообщений',
  image_description: 'Описание картинок',
};

/** Calls made outside the app (checks, comparisons, one-off runs) are written with the kind `offapp:<what it was for>`. */
const OFF_APP_PREFIX = 'offapp:';

export function costKindTitle(kind: string): string {
  if (kind.startsWith(OFF_APP_PREFIX)) return `Вне приложения: ${kind.slice(OFF_APP_PREFIX.length)}`;
  return COST_KIND_TITLES[kind] ?? kind;
}
