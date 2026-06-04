import { supabase } from './supabase';
import { toAppSender } from './messageRole';
import type { Message } from '../types';

type MessageRow = {
  id: string;
  conversation_id: string;
  content?: string | null;
  created_at: string;
  sender?: string | null;
  role?: string | null;
};

/** Map DB row (role/sender) → app Message. */
export function normalizeMessageRow(row: MessageRow): Message {
  const sender = toAppSender(row);
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender,
    content: row.content ?? '',
    created_at: row.created_at,
  };
}

export interface InsertMessageResult {
  message: Message | null;
  error: string | null;
}

/** Persist a chat message (user or ai). */
export async function insertChatMessage(
  conversationId: string,
  sender: 'user' | 'ai',
  content: string,
  userId?: string,
): Promise<InsertMessageResult> {
  const role = sender === 'user' ? 'user' : 'assistant';
  const payload: Record<string, string> = {
    conversation_id: conversationId,
    sender,
    role,
    content,
  };
  if (userId) payload.user_id = userId;

  const { data, error } = await supabase
    .from('messages')
    .insert(payload)
    .select('id, conversation_id, sender, role, content, created_at')
    .maybeSingle();

  if (error) {
    console.error('[chat] insert message failed:', error.message, error.details, error.hint);
    return { message: null, error: error.message };
  }

  if (!data) {
    return { message: null, error: 'insert_returned_no_row' };
  }

  return { message: normalizeMessageRow(data as MessageRow), error: null };
}

/** Remove a message row (e.g. rollback after Stop). RLS must allow delete own messages. */
export async function deleteChatMessage(
  messageId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('messages').delete().eq('id', messageId);
  if (error) {
    console.error('[chat] delete message failed:', error.message);
    return { error: error.message };
  }
  return { error: null };
}
