import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

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
    console.warn("[profilePrefs] cross_memory_enabled:", error.message);
    return true;
  }

  return data?.cross_memory_enabled !== false;
}
