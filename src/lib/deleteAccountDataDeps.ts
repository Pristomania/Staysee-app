import type { AccountDataDeps } from './deleteAccountData';
import { supabase } from './supabase';

/** The real steps of deleteAccountData, against the database. Kept apart so the rules can be tested without a client. */
export const supabaseAccountDataDeps: AccountDataDeps = {
  deleteMemoryContent: async () => {
    const { error } = await supabase.rpc('delete_my_memory');
    return { error };
  },
  deleteAccountContent: async () => {
    const { error } = await supabase.rpc('delete_my_account_data');
    return { error };
  },
};
