import type { FeedbackDeps } from './messageFeedback';
import { supabase } from './supabase';

/**
 * The real steps of messageFeedback, against the database (table message_feedback, migration 095). The row rights
 * (own rows only, only on own answers of Stacy, only the mark and the note can change) are enforced by the database;
 * kept apart so the rules can be tested without a client.
 */
export const supabaseFeedbackDeps: FeedbackDeps = {
  insert: async (row) => {
    const { error } = await supabase.from('message_feedback').insert(row);
    return { error: error ? { code: error.code } : null };
  },
  update: async (messageId, patch) => {
    const { error } = await supabase.from('message_feedback').update(patch).eq('message_id', messageId);
    return { error: error ? { code: error.code } : null };
  },
  remove: async (messageId) => {
    const { error } = await supabase.from('message_feedback').delete().eq('message_id', messageId);
    return { error: error ? { code: error.code } : null };
  },
  fetch: async (messageIds) => {
    const { data, error } = await supabase.from('message_feedback').select('message_id, rating, comment').in('message_id', messageIds);
    return { data: (data as Array<{ message_id: string; rating: number; comment: string | null }> | null) ?? null, error: error ? { code: error.code } : null };
  },
};
