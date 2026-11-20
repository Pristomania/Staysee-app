/**
 * Thumbs up / thumbs down under an answer of Stacy, with an optional short note (migration 095).
 *
 * The rules live here, apart from the screen and from the database client, so they can be tested without either:
 *  - one mark per answer; pressing the same thumb again takes the mark back;
 *  - pressing the other thumb changes the mark and drops the note (a note about a "good" answer does not belong to a "bad" one);
 *  - the note is never required, is trimmed, and an empty note is stored as nothing (the table refuses an empty string);
 *  - an answer that was marked in another tab or window is not an error: the existing row is changed instead.
 * Each step reports an error the way Supabase does ({ error }), so a failed save leaves the screen exactly as it was.
 */

export type FeedbackRating = 1 | -1;

export interface FeedbackState {
  rating: FeedbackRating;
  comment: string | null;
}

export interface FeedbackTarget {
  conversationId: string;
  messageId: string;
}

export interface FeedbackDbError {
  code?: string;
}

export interface FeedbackDeps {
  insert(row: { conversation_id: string; message_id: string; rating: FeedbackRating; comment: string | null }): Promise<{ error: FeedbackDbError | null }>;
  update(messageId: string, patch: { rating?: FeedbackRating; comment?: string | null }): Promise<{ error: FeedbackDbError | null }>;
  remove(messageId: string): Promise<{ error: FeedbackDbError | null }>;
  fetch(messageIds: string[]): Promise<{ data: Array<{ message_id: string; rating: number; comment: string | null }> | null; error: FeedbackDbError | null }>;
}

/** The table allows 1000 characters; the box stops earlier so that nobody writes an essay under an answer. */
export const FEEDBACK_COMMENT_MAX = 600;

const UNIQUE_VIOLATION = '23505';
const FETCH_CHUNK = 100;

export const FEEDBACK_COPY = {
  good: 'Хороший ответ',
  bad: 'Ответ не подошёл',
  askGood: 'Спасибо. Если хочешь, напиши, что понравилось.',
  askBad: 'Спасибо за отзыв. Если хочешь, напиши, что было не так.',
  thanksNote: 'Записано. Спасибо.',
  write: 'Написать',
  send: 'Отправить',
  skip: 'Не нужно',
  placeholderGood: 'Что понравилось (по желанию)',
  placeholderBad: 'Что было не так (по желанию)',
  failed: 'Не получилось сохранить. Попробуй ещё раз.',
} as const;

/** The words of one pair of thumbs: under an answer (FEEDBACK_COPY) or under a weekly dynamics (dynamicsFeedbackDeps.ts). */
export type FeedbackCopy = { readonly [K in keyof typeof FEEDBACK_COPY]: string };

/** The note as it is stored: trimmed, cut to the limit, and null when nothing is left. */
export function normalizeFeedbackComment(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim().slice(0, FEEDBACK_COMMENT_MAX).trim();
  return trimmed === '' ? null : trimmed;
}

export interface FeedbackResult {
  ok: boolean;
  /** The state to show afterwards: the new one when it worked, the old one when it did not. */
  next: FeedbackState | null;
}

/** A thumb was pressed. */
export async function pressThumb(
  deps: FeedbackDeps,
  target: FeedbackTarget,
  current: FeedbackState | null,
  rating: FeedbackRating,
): Promise<FeedbackResult> {
  if (current && current.rating === rating) {
    const { error } = await deps.remove(target.messageId);
    return error ? { ok: false, next: current } : { ok: true, next: null };
  }
  if (current) {
    const { error } = await deps.update(target.messageId, { rating, comment: null });
    return error ? { ok: false, next: current } : { ok: true, next: { rating, comment: null } };
  }
  const { error } = await deps.insert({ conversation_id: target.conversationId, message_id: target.messageId, rating, comment: null });
  if (!error) return { ok: true, next: { rating, comment: null } };
  if (error.code === UNIQUE_VIOLATION) {
    // Marked a moment ago somewhere else: make this mark the one that stands.
    const retry = await deps.update(target.messageId, { rating, comment: null });
    return retry.error ? { ok: false, next: current } : { ok: true, next: { rating, comment: null } };
  }
  return { ok: false, next: current };
}

/** The short note was sent. An empty note changes nothing and is not an error. */
export async function saveComment(
  deps: FeedbackDeps,
  target: FeedbackTarget,
  current: FeedbackState | null,
  text: string,
): Promise<FeedbackResult> {
  if (!current) return { ok: false, next: current };
  const comment = normalizeFeedbackComment(text);
  if (comment === null) return { ok: true, next: current };
  const { error } = await deps.update(target.messageId, { comment });
  return error ? { ok: false, next: current } : { ok: true, next: { ...current, comment } };
}

/** The marks already given to these answers (shown again after a reload). Failure is silent: the thumbs just look unmarked. */
export async function loadFeedback(deps: FeedbackDeps, messageIds: string[]): Promise<Record<string, FeedbackState>> {
  const result: Record<string, FeedbackState> = {};
  for (let start = 0; start < messageIds.length; start += FETCH_CHUNK) {
    const { data, error } = await deps.fetch(messageIds.slice(start, start + FETCH_CHUNK));
    if (error || !data) continue;
    for (const row of data) {
      if (row.rating === 1 || row.rating === -1) result[row.message_id] = { rating: row.rating, comment: row.comment ?? null };
    }
  }
  return result;
}

/** Only an answer that is already saved can be marked: not the one still being written or the one just sent. */
export function canMarkMessage(message: { id: string; sender: string; content: string }): boolean {
  if (message.sender !== 'ai' || !message.content) return false;
  return !message.id.startsWith('stream-') && !message.id.startsWith('temp-');
}
