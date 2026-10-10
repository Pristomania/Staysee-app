import { supabase } from './supabase';
import { resolveSupabasePublicConfig } from './supabaseEnv';

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: 'event' | 'recurrence';
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: 'normal' | 'sensitive';
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

async function callMemoryV3Viewer<T>(body: Record<string, unknown>): Promise<T | { error: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const { url: supabaseUrl, anonKey } = resolveSupabasePublicConfig();
  if (!token || !supabaseUrl || !anonKey) return { error: 'no_session' };

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/memory-v3-viewer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? `http_${res.status}` };
    return data as T;
  } catch {
    return { error: 'network' };
  }
}

/** AI-собранная "умная" память — Memory V3. Только подтверждённые события
 * и повторяющиеся паттерны; догадки (гипотезы) сюда не попадают никогда. */
export async function fetchMemoryV3Items(
  conversationId?: string,
): Promise<{ accountWide: MemoryV3ViewerItem[]; dialogue: MemoryV3ViewerItem[]; error: string | null }> {
  const result = await callMemoryV3Viewer<{ accountWide: MemoryV3ViewerItem[]; dialogue: MemoryV3ViewerItem[] }>({
    action: 'read',
    conversationId,
  });
  if ('error' in result) return { accountWide: [], dialogue: [], error: result.error };
  return { ...result, error: null };
}

export async function deleteMemoryV3Item(input: {
  scope: 'account_wide' | 'dialogue';
  memoryKey: string;
  conversationId?: string;
}): Promise<{ deleted: boolean; error: string | null }> {
  const result = await callMemoryV3Viewer<{ deleted: boolean }>({ action: 'delete', ...input });
  if ('error' in result) return { deleted: false, error: result.error };
  return { ...result, error: null };
}

export async function deleteAllMemoryV3Data(
  scope: 'account_wide' | 'dialogue',
): Promise<{ deleted: boolean; error: string | null }> {
  const result = await callMemoryV3Viewer<{ deleted: boolean }>({ action: 'delete_all', scope });
  if ('error' in result) return { deleted: false, error: result.error };
  return { ...result, error: null };
}

export interface MemoryV3ExportItem {
  memoryKey: string;
  kind: 'event' | 'recurrence' | 'hypothesis';
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: 'normal' | 'sensitive';
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
  alternative: string | null;
  conversationId: string | null;
  replacesMemoryKey: string | null;
  replacedByMemoryKey: string | null;
}

export interface MemoryV3ExportData {
  accountWide: MemoryV3ExportItem[];
  dialogue: MemoryV3ExportItem[];
  /** false when the dialogue-memory rollout flag excludes this account --
   * distinct from a genuinely empty `dialogue` array, since rows can still
   * exist server-side (an earlier canary window, a backfill import) that
   * this export simply isn't allowed to read yet. */
  dialogueAvailable: boolean;
}

/** Выгрузка "всё, что ИИ обо мне помнит" -- и подтверждённые факты, и
 * подтверждённые гипотезы (с их альтернативой), по всем беседам сразу, в
 * отличие от fetchMemoryV3Items, который гипотезы никогда не показывает. */
export async function exportMemoryV3Data(): Promise<
  MemoryV3ExportData & { error: string | null }
> {
  const result = await callMemoryV3Viewer<MemoryV3ExportData>({ action: 'export' });
  if ('error' in result) {
    return { accountWide: [], dialogue: [], dialogueAvailable: false, error: result.error };
  }
  return { ...result, error: null };
}

export function downloadMemoryV3ExportAsJson(data: MemoryV3ExportData): void {
  const payload: MemoryV3ExportData = {
    accountWide: data.accountWide,
    dialogue: data.dialogue,
    dialogueAvailable: data.dialogueAvailable,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `staysee-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
