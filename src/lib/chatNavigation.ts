import type { Conversation, Message, Screen } from '../types';

export function messagesForConversation(
  messages: Message[],
  conversationId: string,
): Message[] {
  return messages.filter((m) => m.conversation_id === conversationId);
}

/** Return from notes to chat, context hub, or list. */
export function navigateBackFromNotes(opts: {
  notesReturnScreen: 'chat' | 'profile';
  currentConversation: Conversation | null;
  setCurrentScreen: (screen: Screen) => void;
  setNotesReturnScreen?: (screen: 'chat' | 'profile') => void;
}): void {
  if (opts.notesReturnScreen === 'profile') {
    opts.setCurrentScreen('profile');
    return;
  }
  opts.setNotesReturnScreen?.('chat');
  if (opts.currentConversation) {
    opts.setCurrentScreen('chat');
  } else {
    opts.setCurrentScreen('main');
  }
}

/** @deprecated Use navigateBackFromNotes */
export function navigateBackToChat(opts: {
  currentConversation: Conversation | null;
  setCurrentScreen: (screen: Screen) => void;
  notesReturnScreen?: 'chat' | 'profile';
  setNotesReturnScreen?: (screen: 'chat' | 'profile') => void;
  setMemoryReturnScreen?: (screen: 'chat' | 'profile') => void;
}): void {
  navigateBackFromNotes({
    notesReturnScreen: opts.notesReturnScreen ?? 'chat',
    currentConversation: opts.currentConversation,
    setCurrentScreen: opts.setCurrentScreen,
    setNotesReturnScreen: opts.setNotesReturnScreen,
  });
}
