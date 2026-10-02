export function formatMemoryAge(isoDate: string): string | null {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  if (!Number.isFinite(then) || now < then) return null;
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 1) return 'сегодня';
  if (days < 2) return 'вчера';
  if (days < 7) return `${days} дн. назад`;
  if (days < 30) return `${Math.floor(days / 7)} нед. назад`;
  if (days < 365) return `${Math.floor(days / 30)} мес. назад`;
  return `${Math.floor(days / 365)} г. назад`;
}

export function formatMemoryRecordedOrUpdated(item: {
  firstSeenAt: string;
  updatedAt: string;
}): string | null {
  const wasRevised = new Date(item.firstSeenAt).getTime() !== new Date(item.updatedAt).getTime();
  const age = formatMemoryAge(wasRevised ? item.updatedAt : item.firstSeenAt);
  if (!age) return null;
  return wasRevised ? `Обновлено: ${age}` : `Записано: ${age}`;
}
