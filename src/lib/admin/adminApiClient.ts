import { callAdmin, type AdminApiDeps, type AdminCallResult } from './adminApi';
import { supabase } from '../supabase';
import { resolveSupabasePublicConfig } from '../supabaseEnv';

/** The real steps of the call to admin-api: the session of the signed-in person and the public config of the app. */
const liveDeps: AdminApiDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  getAccessToken: async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  },
  getPublicConfig: () => resolveSupabasePublicConfig(),
};

export function callAdminApi<T>(action: string, params: Record<string, unknown> = {}): Promise<AdminCallResult<T>> {
  return callAdmin<T>(liveDeps, action, params);
}
