import { createClient } from '@supabase/supabase-js';
import { resolveSupabasePublicConfig } from './supabaseEnv';

const { url: supabaseUrl, anonKey: supabaseAnonKey } = resolveSupabasePublicConfig();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Default lockless auth (supabase-js 2.107+). Custom processLock caused hangs on iOS Safari.
  },
});
