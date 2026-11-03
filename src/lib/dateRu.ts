/**
 * A day written the way it is read: "21 ноября", and "4 февраля 2027" when it is not this year. Used wherever the person
 * is told the day something comes back (their messages, a new room on the same address).
 */
export function formatDateRu(date: Date, now: Date = new Date()): string {
  const day = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}
