/**
 * Known calm error/fallback strings — not real model replies.
 * Mirrors supabase/functions/_shared/cost.ts CALM_ERRORS (exact strings; do not edit here alone).
 */

/** Edge CALM_ERRORS — exact match only. */
export const SERVER_CALM_ERROR_TEXTS: readonly string[] = [
  'Сейчас не могу ответить. Попробуй немного позже.',
  'Ты уже много работаешь со мной сегодня. Дай себе немного пространства — завтра я снова здесь.',
  'Доступ временно ограничен. Если это ошибка, напиши нам.',
  'Похоже, запрос уже отправляется. Подожди секунду.',
];

/** Client-side fetch fallbacks (UI only). */
export const CLIENT_CALM_FALLBACK_TEXTS: readonly string[] = [
  'Сейчас не могу ответить. Попробуй чуть позже.',
  'Что-то пошло не так. Я здесь, но попробуй ещё раз через момент.',
];

const CALM_EXACT = new Set<string>([
  ...SERVER_CALM_ERROR_TEXTS,
  ...CLIENT_CALM_FALLBACK_TEXTS,
]);

/** True when content is a known calm fallback, not a model-generated reply. */
export function isServerCalmFallback(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return CALM_EXACT.has(trimmed);
}

/** Classify HTTP 200 body from staysee-chat before treating as model success. */
export function classifyHttp200Content(content: string): {
  status: 'success' | 'server_fallback';
  content?: string;
  userMessage?: string;
} {
  const trimmed = content.trim();
  if (isServerCalmFallback(trimmed)) {
    return { status: 'server_fallback', userMessage: trimmed };
  }
  return { status: 'success', content: trimmed };
}
