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
  deleteCorrections: async () => {
    const { error } = await supabase.rpc('delete_my_memory_corrections');
    return { error };
  },
  deleteAccountContent: async () => {
    const { error } = await supabase.rpc('delete_my_account_data');
    return { error };
  },
};
