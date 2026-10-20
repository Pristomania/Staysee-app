// The text of the long message report (scripts/long-message-stats.mjs). Pure, so it is tested offline.

// The limit is worth discussing once this many different people have hit it in the period.
export const OVER_LIMIT_PEOPLE_SIGNAL = 3;

const grouped = (value) => String(value ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');

function plural(count, one, few, many) {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function verdictFor(stats) {
  if (stats.over_limit_users >= OVER_LIMIT_PEOPLE_SIGNAL) {
    return `Предел жмёт: в него упёрлись ${stats.over_limit_users} разных человек. Стоит обсудить увеличение.`;
  }
  if (stats.over_limit_events > 0 || stats.over_8000 > 0) {
    return 'Единичные случаи у предела. Наблюдаем.';
  }
  return 'Предел пока никому не мешает.';
}

export function formatLongMessageStats(stats) {
  const times = (n) => `${n} ${plural(n, 'раз', 'раза', 'раз')}`;
  const people = (n) => `${n} чел.`;
  return [
    `Длинные сообщения за ${stats.days} дн. (включая тестовые учётные записи)`,
    `  Сообщений человека: ${grouped(stats.user_messages)}`,
    `  Длиннее 1\u00a0000: ${grouped(stats.over_1000)}; длиннее 4\u00a0000: ${grouped(stats.over_4000)}; длиннее 8\u00a0000: ${grouped(stats.over_8000)}; самое длинное: ${grouped(stats.max_length)}`,
    `  Журнал длинных (больше 4\u00a0000): ${times(stats.long_message_events)}, ${people(stats.long_message_users)}`,
    `  Упёрлись в предел 10\u00a0000: ${times(stats.over_limit_events)}, ${people(stats.over_limit_users)}, самая длинная попытка: ${grouped(stats.over_limit_max)}`,
    `  Краткие версии сделаны: ${grouped(stats.summaries_made)}`,
    '',
    `Вывод: ${verdictFor(stats)}`,
  ].join('\n');
}
