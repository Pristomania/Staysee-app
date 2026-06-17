import type { Message } from '../types';

export function messageMatchesSearch(content: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return content.toLowerCase().includes(q);
}

export function findMatchingMessageIds(messages: Message[], query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  return messages
    .filter((m) => m.content && messageMatchesSearch(m.content, q))
    .map((m) => m.id);
}
