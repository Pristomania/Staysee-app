import { supabase } from "./supabase";
import { resolveSupabasePublicConfig } from "./supabaseEnv";
import { createLivePaymentStatusApi } from "./livePaymentStatus";

/** Not wired to a purchase button yet. Pins requests to the checked user's JWT, no service/provider secrets. */
export function browserLivePaymentStatusApi() {
  const { url, anonKey } = resolveSupabasePublicConfig();
  return createLivePaymentStatusApi({
    baseUrl: url,
    anonKey,
    session: async () => {
      const { data, error } = await supabase.auth.getSession();
      return error || !data.session
        ? null
        : { userId: data.session.user.id, token: data.session.access_token };
    },
  });
}
