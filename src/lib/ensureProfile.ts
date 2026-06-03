import { supabase } from './supabase';

/**
 * Ensures a profiles row exists for the authenticated user.
 * Required for user_memory FK (user_memory.user_id → profiles.id).
 */
export async function ensureUserProfile(
  userId: string,
  email?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { data: existing, error: readErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (readErr) {
    return { ok: false, error: readErr.message };
  }
  if (existing?.id) {
    return { ok: true };
  }

  // Prod schema: id, email, plan, created_at, updated_at (no onboarding_* columns).
  const row: { id: string; email?: string } = { id: userId };
  if (email?.trim()) row.email = email.trim();

  const { error: insertErr } = await supabase.from('profiles').insert(row);

  if (!insertErr) {
    return { ok: true };
  }
  // Race: another request created the profile
  if (insertErr.code === '23505') {
    return { ok: true };
  }

  return { ok: false, error: insertErr.message };
}
