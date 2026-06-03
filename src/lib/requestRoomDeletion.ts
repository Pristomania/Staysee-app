import { supabase } from './supabase';

export async function requestRoomDeletion(): Promise<
  { ok: true; purgeAfter: string } | { ok: false; message: string }
> {
  const { data, error } = await supabase.rpc('request_room_deletion');
  if (error) {
    return { ok: false, message: error.message };
  }
  const purgeAfter = typeof data === 'string' ? data : String(data ?? '');
  return { ok: true, purgeAfter };
}
