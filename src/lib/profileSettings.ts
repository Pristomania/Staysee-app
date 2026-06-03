import { supabase } from './supabase';

export function isCrossMemoryEnabled(
  profile: { cross_memory_enabled?: boolean | null } | null | undefined,
): boolean {
  return profile?.cross_memory_enabled !== false;
}

export async function setCrossMemoryEnabled(
  userId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('profiles')
    .update({ cross_memory_enabled: enabled })
    .eq('id', userId);

  if (error) {
    console.error('[profile] cross_memory_enabled:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
