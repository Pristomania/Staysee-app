import React, { createContext, useContext, useState } from 'react';
import type { Conversation, Message } from '../types';
import type { Screen } from '../types';
import type { SelfNoteKind } from '../lib/reflectionCopy';

export interface NotesCaptureLaunch {
  draft: string;
  kind: SelfNoteKind;
}

interface AppContextType {
  currentScreen: Screen;
  setCurrentScreen: (screen: Screen) => void;
  /** Where Memory screen returns after back. */
  memoryReturnScreen: 'chat' | 'profile';
  setMemoryReturnScreen: (screen: 'chat' | 'profile') => void;
  notesReturnScreen: 'chat' | 'profile';
  setNotesReturnScreen: (screen: 'chat' | 'profile') => void;
  /** Back navigation from legal screens (terms, etc.). */
  legalReturnScreen: Screen;
  setLegalReturnScreen: (screen: Screen) => void;
  currentConversation: Conversation | null;
  setCurrentConversation: (conv: Conversation | null) => void;
  conversations: Conversation[];
  setConversations: (convs: Conversation[]) => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Open notes sheet with prefilled draft (from chat capture nudge). */
  notesCaptureLaunch: NotesCaptureLaunch | null;
  setNotesCaptureLaunch: (launch: NotesCaptureLaunch | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [currentScreen, setCurrentScreen] = useState<Screen>('welcome');
  const [memoryReturnScreen, setMemoryReturnScreen] = useState<'chat' | 'profile'>('profile');
  const [notesReturnScreen, setNotesReturnScreen] = useState<'chat' | 'profile'>('chat');
  const [legalReturnScreen, setLegalReturnScreen] = useState<Screen>('profile');
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notesCaptureLaunch, setNotesCaptureLaunch] = useState<NotesCaptureLaunch | null>(null);

  return (
    <AppContext.Provider
      value={{
        currentScreen,
        setCurrentScreen,
        memoryReturnScreen,
        setMemoryReturnScreen,
        notesReturnScreen,
        setNotesReturnScreen,
        legalReturnScreen,
        setLegalReturnScreen,
        currentConversation,
        setCurrentConversation,
        conversations,
        setConversations,
        messages,
        setMessages,
        notesCaptureLaunch,
        setNotesCaptureLaunch,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
