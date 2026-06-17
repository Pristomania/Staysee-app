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
  client_message_id?: string | null;
};

const MESSAGE_SELECT =
  'id, conversation_id, sender, role, content, created_at, client_message_id';

/** Map DB row (role/sender) → app Message. */
export function normalizeMessageRow(row: MessageRow): Message {
  const sender = toAppSender(row);
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender,
    content: row.content ?? '',
    created_at: row.created_at,
    client_message_id: row.client_message_id ?? undefined,
  };
}

export interface InsertMessageResult {
  message: Message | null;
  error: string | null;
  /** True when UNIQUE(client turn) returned an existing row instead of inserting. */
  wasDuplicate?: boolean;
}

export interface TurnMessagePair {
  user: Message | null;
  ai: Message | null;
}

async function fetchMessageByTurn(
  conversationId: string,
  clientMessageId: string,
  sender: 'user' | 'ai',
): Promise<Message | null> {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .eq('client_message_id', clientMessageId)
    .eq('sender', sender)
    .maybeSingle();

  if (error) {
    console.error('[chat] fetch turn message failed:', error.message);
    return null;
  }
  return data ? normalizeMessageRow(data as MessageRow) : null;
}

/** Load persisted user/ai rows for a client turn id. */
export async function fetchTurnMessages(
  conversationId: string,
  clientMessageId: string,
): Promise<TurnMessagePair> {
  const [user, ai] = await Promise.all([
    fetchMessageByTurn(conversationId, clientMessageId, 'user'),
    fetchMessageByTurn(conversationId, clientMessageId, 'ai'),
  ]);
  return { user, ai };
}

export interface InsertChatMessageOptions {
  userId?: string;
  clientMessageId?: string;
}

/** Persist a chat message (user or ai). Idempotent per (conversation, turn, sender). */
export async function insertChatMessage(
  conversationId: string,
  sender: 'user' | 'ai',
  content: string,
  options?: InsertChatMessageOptions,
): Promise<InsertMessageResult> {
  const role = sender === 'user' ? 'user' : 'assistant';
  const payload: Record<string, string> = {
    conversation_id: conversationId,
    sender,
    role,
    content,
  };
  if (options?.userId) payload.user_id = options.userId;
  if (options?.clientMessageId) payload.client_message_id = options.clientMessageId;

  const { data, error } = await supabase
    .from('messages')
    .insert(payload)
    .select(MESSAGE_SELECT)
    .maybeSingle();

  if (error?.code === '23505' && options?.clientMessageId) {
    const existing = await fetchMessageByTurn(
      conversationId,
      options.clientMessageId,
      sender,
    );
    if (existing) {
      return { message: existing, error: null, wasDuplicate: true };
    }
  }

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
