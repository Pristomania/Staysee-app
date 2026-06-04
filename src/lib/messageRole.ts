/**
 * Same rules as supabase/functions/_shared/messageRole.ts (browser bundle).
 */

export type NormalizedMessageRole = 'user' | 'assistant';

export interface MessageRoleFields {
  sender?: string | null;
  role?: string | null;
}

export function normalizeMessageRole(row: MessageRoleFields): NormalizedMessageRole {
  const sender = row.sender?.trim().toLowerCase();
  if (sender === 'user') return 'user';
  if (sender === 'ai') return 'assistant';

  const role = row.role?.trim().toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';

  return 'assistant';
}

export function toAppSender(row: MessageRoleFields): 'user' | 'ai' {
  return normalizeMessageRole(row) === 'user' ? 'user' : 'ai';
}
