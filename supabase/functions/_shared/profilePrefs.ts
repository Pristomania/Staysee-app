import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** Legacy memory is an explicit compatibility exception and fails closed. */
export async function fetchLegacyMemoryCompatibilityEnabled(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("legacy_memory_compat_enabled")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[profilePrefs] legacy memory compatibility unavailable");
    return false;
  }

  return data?.legacy_memory_compat_enabled === true;
}

/** Default true when column missing or read fails (legacy behavior). */
export async function fetchCrossMemoryEnabled(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("cross_memory_enabled")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[profilePrefs] profile cross-memory preference unavailable");
    return true;
  }

  return data?.cross_memory_enabled !== false;
}

/** Use the owned conversation value, with a rollout-compatible profile fallback. */
export async function fetchConversationCrossMemoryEnabled(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("conversations")
    .select("cross_memory_enabled")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!error && data) {
    return data.cross_memory_enabled !== false;
  }

  console.warn("[profilePrefs] conversation cross-memory preference unavailable");
  return fetchCrossMemoryEnabled(supabase, userId);
}
