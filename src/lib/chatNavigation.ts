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
  navigateTo: (screen: Screen, options?: import('../context/AppContext').NavigateOptions) => void;
  navigateBack?: () => void;
  setNotesReturnScreen?: (screen: 'chat' | 'profile') => void;
}): void {
  if (opts.navigateBack) {
    opts.navigateBack();
    return;
  }
  if (opts.notesReturnScreen === 'profile') {
    opts.navigateTo('profile', { replace: true });
    return;
  }
  opts.setNotesReturnScreen?.('chat');
  if (opts.currentConversation) {
    opts.navigateTo('chat', { conversation: opts.currentConversation, replace: true });
  } else {
    opts.navigateTo('main', { replace: true });
  }
}

/** @deprecated Use navigateBackFromNotes */
export function navigateBackToChat(opts: {
  currentConversation: Conversation | null;
  navigateTo: (screen: Screen, options?: import('../context/AppContext').NavigateOptions) => void;
  navigateBack?: () => void;
  notesReturnScreen?: 'chat' | 'profile';
  setNotesReturnScreen?: (screen: 'chat' | 'profile') => void;
  setMemoryReturnScreen?: (screen: 'chat' | 'profile') => void;
}): void {
  navigateBackFromNotes({
    notesReturnScreen: opts.notesReturnScreen ?? 'chat',
    currentConversation: opts.currentConversation,
    navigateTo: opts.navigateTo,
    navigateBack: opts.navigateBack,
    setNotesReturnScreen: opts.setNotesReturnScreen,
  });
}
