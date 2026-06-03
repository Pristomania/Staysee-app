import type { Message } from '../types';

/** Stable order when timestamps collide (common right after send). */
export function compareMessages(a: Message, b: Message): number {
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  if (ta !== tb) return ta - tb;

  const rank = (m: Message): number => {
    if (m.sender === 'user') return 0;
    if (m.id.startsWith('stream-')) return 2;
    return 1;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;

  return a.id.localeCompare(b.id);
}

/** Keep one message per id; later entries win. Sorted by created_at. */
export function dedupeMessages(msgs: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const msg of msgs) {
    byId.set(msg.id, msg);
  }
  return [...byId.values()].sort(compareMessages);
}

/** Merge Supabase rows with in-flight optimistic / streaming placeholders. */
export function mergeFetchedWithPending(
  prev: Message[],
  fetched: Message[],
  opts?: { suppressAiMessageId?: string | null },
): Message[] {
  const suppressId = opts?.suppressAiMessageId ?? null;
  const rows = suppressId
    ? fetched.filter((m) => m.id !== suppressId)
    : fetched;

  const pending = prev.filter((m) => {
    if (suppressId && m.id === suppressId) return false;
    if (m.id.startsWith('stream-')) return true;
    if (m.id.startsWith('temp-')) {
      return !rows.some(
        (f) => f.sender === m.sender && f.content === m.content,
      );
    }
    return false;
  });
  return dedupeMessages([...rows, ...pending]);
}
