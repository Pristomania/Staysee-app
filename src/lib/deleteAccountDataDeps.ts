import { deleteAllMemoryV3Data } from './memoryV3Viewer';
import type { AccountDataDeps } from './deleteAccountData';
import { supabase } from './supabase';

/** The real steps of deleteAccountData, against the database. Kept apart so the rules can be tested without a client. */
export const supabaseAccountDataDeps: AccountDataDeps = {
  deleteMemoryV3: async (scope) => {
    const { error } = await deleteAllMemoryV3Data(scope);
    return { error };
  },
  deleteLegacyMemory: async (userId) => {
    const { error } = await supabase.from('user_memory').delete().eq('user_id', userId);
    return { error };
  },
  deleteProgress: async (userId) => {
    const { error } = await supabase.from('progress_entries').delete().eq('user_id', userId);
    return { error };
  },
  deleteConversations: async (userId) => {
    const { error } = await supabase.from('conversations').delete().eq('user_id', userId);
    return { error };
  },
};
