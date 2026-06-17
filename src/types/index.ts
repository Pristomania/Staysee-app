export interface Profile {
  id: string;
  email?: string | null;
  plan?: string | null;
  onboarding_completed?: boolean;
  primary_concern?: string;
  /** When false, user_memory is not used in chat or auto-filled from summaries. */
  cross_memory_enabled?: boolean;
  room_deletion_requested_at?: string | null;
  room_purge_after?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  is_active: boolean;
  created_at: string;
  last_message_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender: 'user' | 'ai';
  content: string;
  created_at: string;
  /** Client turn UUID — shared by user/ai pair for one submit. */
  client_message_id?: string;
}

export interface UserMemory {
  id: string;
  user_id: string;
  memory_type:
    | 'preference'
    | 'insight'
    | 'theme'
    | 'emotion'
    | 'communication'
    | 'life_context';
  content: string;
  created_at: string;
}

export type Screen =
  | 'welcome'
  | 'greeting'
  | 'login'
  | 'reset-password'
  | 'register'
  | 'onboarding'
  | 'main'
  | 'chat'
  | 'profile'
  | 'memory'
  | 'conversation-dynamics'
  | 'conversation-notes'
  | 'privacy'
  | 'disclaimer'
  | 'terms';
