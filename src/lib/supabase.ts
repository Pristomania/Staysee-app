import { createClient, processLock } from '@supabase/supabase-js';
import { resolveSupabasePublicConfig } from './supabaseEnv';

const { url: supabaseUrl, anonKey: supabaseAnonKey } = resolveSupabasePublicConfig();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Avoid Navigator LockManager warnings / quirks in dev tools and some browsers.
    lock: processLock,
  },
});
