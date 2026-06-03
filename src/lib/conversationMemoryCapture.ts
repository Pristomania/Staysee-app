import { supabase } from './supabase';
import type { MemoryFieldKey } from './memoryUi';
import {
  emptyMemory,
  parseConversationMemory,
  serializeConversationMemory,
  type StructuredMemory,
} from './memoryUi';

function normalizeLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function alreadyStored(mem: StructuredMemory, line: string): boolean {
  const n = normalizeLine(line).toLowerCase();
  if (!n) return true;
  const fields: MemoryFieldKey[] = [
    'people',
    'themes',
    'emotional_state',
    'important_events',
    'preferences',
    'open_loops',
  ];
  return fields.some((f) =>
    mem[f].some((item) => normalizeLine(item).toLowerCase() === n),
  );
}

/**
 * Append an explicit user «запомни» fact to conversation_summary (dialog memory).
 */
export async function appendToConversationMemory(
  conversationId: string,
  userId: string,
  sentence: string,
  field: MemoryFieldKey = 'important_events',
): Promise<{ ok: boolean }> {
  const line = normalizeLine(sentence);
  if (!line || line.length < 3) return { ok: false };

  const { data, error } = await supabase
    .from('conversations')
    .select('conversation_summary')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[memory-capture] fetch:', error.message);
    return { ok: false };
  }

  const base =
    parseConversationMemory(data?.conversation_summary as string | null) ??
    emptyMemory();

  if (alreadyStored(base, line)) return { ok: true };

  const next: StructuredMemory = {
    ...base,
    [field]: [...base[field], line],
    last_updated: new Date().toISOString(),
  };

  const payload = serializeConversationMemory(next);

  const { error: updateError } = await supabase
    .from('conversations')
    .update({ conversation_summary: payload })
    .eq('id', conversationId)
    .eq('user_id', userId);

  if (updateError) {
    console.error('[memory-capture] save:', updateError.message);
    return { ok: false };
  }

  return { ok: true };
}
