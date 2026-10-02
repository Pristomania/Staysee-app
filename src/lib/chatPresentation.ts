export function generateTitle(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes('грустно') || normalized.includes('грусть')) return 'Когда грустно';
  if (normalized.includes('тревожно') || normalized.includes('тревога') || normalized.includes('тревог')) return 'Про тревогу';
  if (normalized.includes('устала') || normalized.includes('усталость') || normalized.includes('устал')) return 'Про усталость';
  if (normalized.includes('отношения') || normalized.includes('отношениях') || normalized.includes('отношений')) return 'Про отношения';
  if (normalized.includes('радость') || normalized.includes('радостно') || normalized.includes('счастлива') || normalized.includes('хорошо')) return 'Про радость';
  if (normalized.includes('злость') || normalized.includes('злюсь') || normalized.includes('злой')) return 'Про злость';
  if (normalized.includes('одинок') || normalized.includes('одиноко')) return 'Про одиночество';
  if (normalized.includes('страх') || normalized.includes('боюсь') || normalized.includes('страшно')) return 'Про страх';
  return text.trim().split(/\s+/).slice(0, 5).join(' ');
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMins < 2) return 'только что';
  if (diffMins < 60) return `${diffMins} мин назад`;
  if (diffHours < 2) return 'час назад';
  if (diffHours < 24) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return date.toLocaleDateString('ru-RU', { weekday: 'long' });
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
