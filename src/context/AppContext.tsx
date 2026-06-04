import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import type { Conversation, Message } from '../types';
import type { Screen } from '../types';
import type { SelfNoteKind } from '../lib/reflectionCopy';
import {
  APP_HISTORY_TAG,
  canWriteAppHistory,
  isAppHistoryState,
  pushAppHistory,
  replaceAppHistory,
  type AppHistoryState,
} from '../lib/appHistory';

export interface NotesCaptureLaunch {
  draft: string;
  kind: SelfNoteKind;
}

export interface NavigateOptions {
  conversationId?: string | null;
  conversation?: Conversation | null;
  memoryReturnScreen?: 'chat' | 'profile';
  notesReturnScreen?: 'chat' | 'profile';
  legalReturnScreen?: Screen;
  /** Use replaceState (auth redirects, fallback back). */
  replace?: boolean;
  /** Update React state only — no History API write. */
  skipHistory?: boolean;
}

interface AppContextType {
  currentScreen: Screen;
  setCurrentScreen: (screen: Screen) => void;
  navigateTo: (screen: Screen, options?: NavigateOptions) => void;
  navigateBack: () => void;
  /** Auth / guard redirects — replaceState, never push. */
  replaceNavigation: (screen: Screen, options?: Omit<NavigateOptions, 'replace'>) => void;
  applyHistoryState: (state: AppHistoryState) => void;
  popNavigationRef: React.MutableRefObject<boolean>;
  memoryReturnScreen: 'chat' | 'profile';
  setMemoryReturnScreen: (screen: 'chat' | 'profile') => void;
  notesReturnScreen: 'chat' | 'profile';
  setNotesReturnScreen: (screen: 'chat' | 'profile') => void;
  legalReturnScreen: Screen;
  setLegalReturnScreen: (screen: Screen) => void;
  currentConversation: Conversation | null;
  setCurrentConversation: (conv: Conversation | null) => void;
  conversations: Conversation[];
  setConversations: (convs: Conversation[]) => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  notesCaptureLaunch: NotesCaptureLaunch | null;
  setNotesCaptureLaunch: (launch: NotesCaptureLaunch | null) => void;
  /** One-time replaceState for current screen (after auth URL is clean). */
  seedHistory: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const AUTHENTICATED_SCREENS: Screen[] = [
  'main',
  'chat',
  'profile',
  'memory',
  'conversation-notes',
  'onboarding',
  'reset-password',
];

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [currentScreen, setCurrentScreen] = useState<Screen>('welcome');
  const [memoryReturnScreen, setMemoryReturnScreen] = useState<'chat' | 'profile'>('profile');
  const [notesReturnScreen, setNotesReturnScreen] = useState<'chat' | 'profile'>('chat');
  const [legalReturnScreen, setLegalReturnScreen] = useState<Screen>('profile');
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notesCaptureLaunch, setNotesCaptureLaunch] = useState<NotesCaptureLaunch | null>(null);

  const popNavigationRef = useRef(false);
  const conversationsRef = useRef(conversations);
  const memoryReturnRef = useRef(memoryReturnScreen);
  const notesReturnRef = useRef(notesReturnScreen);
  const legalReturnRef = useRef(legalReturnScreen);
  const currentConversationRef = useRef(currentConversation);
  const currentScreenRef = useRef(currentScreen);
  const historyReadyRef = useRef(false);

  conversationsRef.current = conversations;
  memoryReturnRef.current = memoryReturnScreen;
  notesReturnRef.current = notesReturnScreen;
  legalReturnRef.current = legalReturnScreen;
  currentConversationRef.current = currentConversation;
  currentScreenRef.current = currentScreen;

  const resolveConversation = useCallback(
    (opts?: NavigateOptions): Conversation | null => {
      if (opts?.conversation !== undefined) return opts.conversation;
      if (opts?.conversationId) {
        return conversationsRef.current.find((c) => c.id === opts.conversationId) ?? null;
      }
      return currentConversationRef.current;
    },
    [],
  );

  const buildHistorySnapshot = useCallback(
    (
      screen: Screen,
      opts?: NavigateOptions,
      overrides?: Partial<AppHistoryState>,
    ): AppHistoryState => {
      const conv = resolveConversation(opts);
      return {
        app: APP_HISTORY_TAG,
        screen,
        conversationId: conv?.id ?? opts?.conversationId ?? null,
        memoryReturnScreen: opts?.memoryReturnScreen ?? memoryReturnRef.current,
        notesReturnScreen: opts?.notesReturnScreen ?? notesReturnRef.current,
        legalReturnScreen: opts?.legalReturnScreen ?? legalReturnRef.current,
        ...overrides,
      };
    },
    [resolveConversation],
  );

  const applyHistoryState = useCallback((state: AppHistoryState) => {
    setCurrentScreen(state.screen);
    setMemoryReturnScreen(state.memoryReturnScreen);
    setNotesReturnScreen(state.notesReturnScreen);
    setLegalReturnScreen(state.legalReturnScreen);

    if (state.conversationId) {
      const conv =
        conversationsRef.current.find((c) => c.id === state.conversationId) ?? null;
      setCurrentConversation(conv);
    } else if (state.screen !== 'chat') {
      setCurrentConversation(null);
    }
  }, []);

  const applyNavigate = useCallback(
    (screen: Screen, opts?: NavigateOptions) => {
      if (opts?.memoryReturnScreen) setMemoryReturnScreen(opts.memoryReturnScreen);
      if (opts?.notesReturnScreen) setNotesReturnScreen(opts.notesReturnScreen);
      if (opts?.legalReturnScreen) setLegalReturnScreen(opts.legalReturnScreen);

      if (opts?.conversation !== undefined) {
        setCurrentConversation(opts.conversation);
      } else if (opts?.conversationId !== undefined) {
        if (opts.conversationId === null) {
          setCurrentConversation(null);
        } else {
          const conv =
            conversationsRef.current.find((c) => c.id === opts.conversationId) ?? null;
          setCurrentConversation(conv);
        }
      } else if (screen !== 'chat') {
        setCurrentConversation(null);
      }

      setCurrentScreen(screen);
    },
    [],
  );

  const writeHistory = useCallback(
    (screen: Screen, opts?: NavigateOptions & { replace?: boolean }) => {
      if (opts?.skipHistory || popNavigationRef.current || !canWriteAppHistory()) return;
      const snapshot = buildHistorySnapshot(screen, opts);
      if (opts?.replace) replaceAppHistory(snapshot);
      else pushAppHistory(snapshot);
    },
    [buildHistorySnapshot],
  );

  const navigateTo = useCallback(
    (screen: Screen, options?: NavigateOptions) => {
      applyNavigate(screen, options);
      writeHistory(screen, options);
    },
    [applyNavigate, writeHistory],
  );

  const replaceNavigation = useCallback(
    (screen: Screen, options?: Omit<NavigateOptions, 'replace'>) => {
      navigateTo(screen, { ...options, replace: true });
    },
    [navigateTo],
  );

  const fallbackNavigateBack = useCallback(() => {
    const screen = currentScreenRef.current;
    const memReturn = memoryReturnRef.current;
    const notesReturn = notesReturnRef.current;
    const legalReturn = legalReturnRef.current;
    const conv = currentConversationRef.current;

    switch (screen) {
      case 'chat':
        replaceNavigation('main', { conversation: null });
        break;
      case 'profile':
        replaceNavigation('main');
        break;
      case 'memory':
        if (memReturn === 'chat' && conv) {
          navigateTo('chat', {
            conversation: conv,
            memoryReturnScreen: 'profile',
            replace: true,
          });
        } else {
          replaceNavigation('profile', { memoryReturnScreen: 'profile' });
        }
        break;
      case 'conversation-notes':
        if (notesReturn === 'profile') {
          replaceNavigation('profile');
        } else if (conv) {
          navigateTo('chat', { conversation: conv, notesReturnScreen: 'chat', replace: true });
        } else {
          replaceNavigation('main');
        }
        break;
      case 'terms':
      case 'privacy':
      case 'disclaimer':
        replaceNavigation(legalReturn);
        break;
      case 'login':
        replaceNavigation('welcome');
        break;
      case 'register':
        replaceNavigation('login');
        break;
      default:
        if (AUTHENTICATED_SCREENS.includes(screen)) {
          replaceNavigation('main');
        } else {
          replaceNavigation('welcome');
        }
        break;
    }
  }, [navigateTo, replaceNavigation]);

  const navigateBack = useCallback(() => {
    if (typeof window === 'undefined') {
      fallbackNavigateBack();
      return;
    }
    if (isAppHistoryState(window.history.state)) {
      window.history.back();
      return;
    }
    fallbackNavigateBack();
  }, [fallbackNavigateBack]);

  const seedHistory = useCallback(() => {
    if (historyReadyRef.current || !canWriteAppHistory()) return;
    historyReadyRef.current = true;
    const snapshot = buildHistorySnapshot(currentScreenRef.current);
    replaceAppHistory(snapshot);
  }, [buildHistorySnapshot]);

  return (
    <AppContext.Provider
      value={{
        currentScreen,
        setCurrentScreen,
        navigateTo,
        navigateBack,
        replaceNavigation,
        applyHistoryState,
        popNavigationRef,
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
        seedHistory,
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
