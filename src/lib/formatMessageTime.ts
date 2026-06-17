/** Chat bubble timestamp: today → HH:mm, yesterday → "Вчера, HH:mm", else DD.MM.YYYY, HH:mm */
export function formatMessageTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  if (date >= startOfToday) return time;
  if (date >= startOfYesterday) return `Вчера, ${time}`;

  const day = date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return `${day}, ${time}`;
}
