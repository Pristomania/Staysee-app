import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeedbackCopy, FeedbackDeps } from './messageFeedback';

/**
 * Thumbs on the weekly "Динамика" of a conversation (table dynamics_feedback, migration 096). The rules are the ones of
 * messageFeedback.ts (one mark per item, the other thumb changes the mark and drops the note, an empty note is nothing);
 * this file only says WHERE the marks live: the same steps, against another table and another column.
 *
 * The steps keep the names of the answers' feedback (`message_id`), so the same rules and the same component serve both:
 * here `message_id` is the id of the weekly dynamics, and in the table it is the column `entry_id`.
 * Made from a client, so it can be tested without the real one (the real one is in dynamicsFeedbackClient.ts).
 */
export function createDynamicsFeedbackDeps(client: SupabaseClient): FeedbackDeps {
  return {
    insert: async (row) => {
      const { error } = await client.from('dynamics_feedback').insert({
        conversation_id: row.conversation_id,
        entry_id: row.message_id,
        rating: row.rating,
        comment: row.comment,
      });
      return { error: error ? { code: error.code } : null };
    },
    update: async (entryId, patch) => {
      const { error } = await client.from('dynamics_feedback').update(patch).eq('entry_id', entryId);
      return { error: error ? { code: error.code } : null };
    },
    remove: async (entryId) => {
      const { error } = await client.from('dynamics_feedback').delete().eq('entry_id', entryId);
      return { error: error ? { code: error.code } : null };
    },
    fetch: async (entryIds) => {
      const { data, error } = await client.from('dynamics_feedback').select('entry_id, rating, comment').in('entry_id', entryIds);
      const rows = (data as Array<{ entry_id: string; rating: number; comment: string | null }> | null) ?? null;
      return {
        data: rows ? rows.map((row) => ({ message_id: row.entry_id, rating: row.rating, comment: row.comment })) : null,
        error: error ? { code: error.code } : null,
      };
    },
  };
}

/**
 * What the thumbs say under a dynamics. The person's own gender is never guessed: no line addresses them in a gendered form
 * (Stacy speaks of herself in the feminine elsewhere; here nobody speaks about themselves).
 */
export const DYNAMICS_FEEDBACK_COPY: FeedbackCopy = {
  // Under a dynamics the thumbs say what they mean in the owner's words: "понравилось" / "не понравилось" (neuter: no gender).
  good: 'Понравилось',
  bad: 'Не понравилось',
  askGood: 'Спасибо. Если хочешь, напиши, что понравилось.',
  askBad: 'Спасибо за отзыв. Если хочешь, напиши, что не понравилось.',
  thanksNote: 'Записано. Спасибо.',
  write: 'Написать',
  send: 'Отправить',
  skip: 'Не нужно',
  placeholderGood: 'Что понравилось (по желанию)',
  placeholderBad: 'Что не понравилось (по желанию)',
  failed: 'Не получилось сохранить. Попробуй ещё раз.',
};

/** The label read aloud for the pair of thumbs under a dynamics. */
export const DYNAMICS_FEEDBACK_GROUP_LABEL = 'Оценка динамики';
