import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { isAiRequestAborted, isAiSendSuccess, sendAiMessage } from '../../lib/ai/client';
import { resolveTurnId, type PendingTurn } from '../../lib/chatTurn';
import { buildClientTimeGap } from '../../lib/timeGap';
import { Send, Square, X, Brain, Feather, Activity } from 'lucide-react';
import { REFLECTION_COPY } from '../../lib/reflectionCopy';
import { DYNAMICS_COPY } from '../../lib/dynamicsCopy';
import type { Message } from '../../types';
import { dedupeMessages, mergeFetchedWithPending } from '../../lib/messages';
import { deleteChatMessage, fetchTurnMessages, insertChatMessage, normalizeMessageRow } from '../../lib/chatMessages';
import { contextBodyTextClass, LAYOUT_CONTAINER_CLASS } from '../layout';
import {
  buildRevealSteps,
  prepareAiDisplayText,
  renderAiMessageBody,
  shouldAnimateReveal,
} from '../../lib/aiMessageFormat';
import { appendToConversationMemory } from '../../lib/conversationMemoryCapture';
import {
  CAPTURE_NUDGE_COPY,
  detectAiNotesNudge,
  detectUserCaptureIntent,
  notesDraftFromContext,
  nudgeDedupeKey,
  resolveMemoryPayloadFromChat,
  type NotesCaptureSource,
} from '../../lib/chatCaptureTriggers';
import type { SelfNoteKind } from '../../lib/reflectionCopy';
import { messagesForConversation } from '../../lib/chatNavigation';

export const GREETING = 'О чём сегодня хочется поговорить?';

// ── Guided prompt categories ─────────────────────────────────────────────────

const GUIDED_CATEGORIES = [
  { label: 'Выговориться', phrase: 'Мне нужно просто выговориться. Я начну как получится.' },
  { label: 'Разобраться', phrase: 'Помоги мне разобраться, что на самом деле происходит.' },
  { label: 'Найти следующий шаг', phrase: 'Я хочу понять, какой маленький шаг могу сделать сейчас.' },
  { label: 'Поделиться хорошим', phrase: 'Хочу поделиться тем, что у меня получилось.' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export function generateTitle(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('грустно') || t.includes('грусть')) return 'Когда грустно';
  if (t.includes('тревожно') || t.includes('тревога') || t.includes('тревог')) return 'Про тревогу';
  if (t.includes('устала') || t.includes('усталость') || t.includes('устал')) return 'Про усталость';
  if (t.includes('отношения') || t.includes('отношениях') || t.includes('отношений')) return 'Про отношения';
  if (t.includes('радость') || t.includes('радостно') || t.includes('счастлива') || t.includes('хорошо')) return 'Про радость';
  if (t.includes('злость') || t.includes('злюсь') || t.includes('злой')) return 'Про злость';
  if (t.includes('одинок') || t.includes('одиноко')) return 'Про одиночество';
  if (t.includes('страх') || t.includes('боюсь') || t.includes('страшно')) return 'Про страх';
  return text.trim().split(/\s+/).slice(0, 5).join(' ');
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 2) return 'только что';
  if (diffMins < 60) return `${diffMins} мин назад`;
  if (diffHours < 2) return 'час назад';
  if (diffHours < 24) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return date.toLocaleDateString('ru-RU', { weekday: 'long' });
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

const SCROLL_BOTTOM_THRESHOLD = 80;

function computeInitialDelay(fullText: string): number {
  const len = fullText.length;
  if (len < 80) return 520 + Math.random() * 120;
  if (len < 220) return 720 + Math.random() * 200;
  return 900 + Math.random() * 280;
}

function computeChunkPause(chunk: string): number {
  const trimmed = chunk.trim();
  if (/[?…]$/.test(trimmed)) return 280 + Math.random() * 100;
  if (/[.!]$/.test(trimmed)) return 200 + Math.random() * 90;
  return 150 + Math.random() * 70;
}

interface StreamState {
  isStreaming: boolean;
  streamingId: string | null;
  revealedText: string;
}

const EMPTY_STREAM: StreamState = {
  isStreaming: false,
  streamingId: null,
  revealedText: '',
};

// ── Main component ────────────────────────────────────────────────────────────

export function ChatScreen() {
  const { user } = useAuth();
  const {
    currentConversation,
    currentScreen,
    messages: appMessages,
    setCurrentScreen,
    navigateTo,
    navigateBack,
    setMemoryReturnScreen,
    setNotesReturnScreen,
    setCurrentConversation,
    setMessages,
    setNotesCaptureLaunch,
  } = useApp();
  const { theme } = useTheme();

  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Per-room message list — source of truth for the active chat. */
  const [roomMessages, setRoomMessages] = useState<Message[]>([]);
  const [isNewRoom, setIsNewRoom] = useState(false);
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [captureNudge, setCaptureNudge] = useState<{
    kind: 'notes';
    snippet: string;
    source: NotesCaptureSource;
  } | { kind: 'memory_saved'; snippet: string } | null>(null);
  /** Space below last message so tail is not hidden under the composer. */
  const [composerPadPx, setComposerPadPx] = useState(128);

  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastCaptureNudgeKeyRef = useRef<string | null>(null);
  const captureNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamActiveRef = useRef(false);
  /** When true, keep the thread tail visible; false if user scrolled up to read history. */
  const scrollFollowRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const chatScrollInitRef = useRef<string | null>(null);
  const sendLockRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationEpochRef = useRef(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const pendingDraftRef = useRef('');
  /** Stable turn id for submit + retry until success or Stop. */
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  /** DB ids for the in-flight turn — rolled back on Stop after persist. */
  const persistedTurnRef = useRef<{ userId?: string; aiId?: string } | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  const roomMessagesRef = useRef<Message[]>([]);
  roomMessagesRef.current = roomMessages;
  streamActiveRef.current = stream.isStreaming;

  const applyMessages = useCallback((next: Message[]) => {
    const deduped = dedupeMessages(next);
    roomMessagesRef.current = deduped;
    setRoomMessages(deduped);
    setMessages(deduped);
  }, [setMessages]);

  const patchMessages = useCallback((fn: (prev: Message[]) => Message[]) => {
    applyMessages(fn(roomMessagesRef.current));
  }, [applyMessages]);

  const syncMessagesToApp = useCallback(() => {
    applyMessages(roomMessagesRef.current);
  }, [applyMessages]);

  const leaveChatFor = useCallback(
    (screen: 'conversation-notes' | 'memory' | 'conversation-dynamics') => {
      syncMessagesToApp();
      navigateTo(screen, {
        notesReturnScreen: 'chat',
        memoryReturnScreen: 'chat',
        dynamicsReturnScreen: 'chat',
        conversation: currentConversation,
      });
    },
    [syncMessagesToApp, navigateTo, currentConversation],
  );

  const isEmptyConversation = isNewRoom && roomMessages.length <= 1 && roomMessages[0]?.id === 'greeting';

  // ── Scroll — messages live in their own pane (not window) ─────────────────────

  const scrollToBottom = useCallback(() => {
    if (!scrollFollowRef.current) return;
    const el = messagesScrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    window.setTimeout(() => { programmaticScrollRef.current = false; }, 48);
  }, []);

  const followTailAfterPaint = useCallback(() => {
    requestAnimationFrame(() => scrollToBottom());
  }, [scrollToBottom]);

  /** Before first paint when opening a room — avoids a visible jump from top to bottom. */
  const snapScrollToBottom = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    window.setTimeout(() => { programmaticScrollRef.current = false; }, 60);
  }, []);

  const isNearBottom = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // ── Effects ───────────────────────────────────────────────────────────────────

  // Instant restore when returning from notes/memory (before DB fetch completes).
  useEffect(() => {
    if (currentScreen !== 'chat' || !currentConversation?.id) return;
    const cached = messagesForConversation(appMessages, currentConversation.id);
    if (cached.length > 0 && roomMessagesRef.current.length === 0) {
      applyMessages(cached);
      setLoading(false);
    }
  }, [currentScreen, currentConversation?.id, appMessages, applyMessages]);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      scrollFollowRef.current = isNearBottom();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isNearBottom, loading, roomMessages.length]);

  useEffect(() => {
    const bar = inputBarRef.current;
    if (!bar) return;
    const measure = () => setComposerPadPx(bar.offsetHeight + 20);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [guidedOpen, captureNudge, inputValue, sending]);

  useEffect(() => {
    if (!user) { setCurrentScreen('welcome'); return; }
    if (currentScreen !== 'chat') return;

    // Never create or auto-select a conversation inside ChatScreen.
    if (!currentConversation) {
      setLoading(false);
      setCurrentScreen('main');
      return;
    }

    const convId = currentConversation.id;
    activeConvIdRef.current = convId;
    setLoading(true);

    let active = true;

    (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('id, conversation_id, sender, content, created_at')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true });

      if (!active || activeConvIdRef.current !== convId) return;

      if (error) {
        console.error('[chat] fetch messages:', error.message);
        setLoading(false);
        return;
      }

      const rows = (data ?? []).map((row) => normalizeMessageRow(row));
      const cached = messagesForConversation(appMessages, convId);
      const prev =
        roomMessagesRef.current.length > 0
          ? roomMessagesRef.current
          : cached;

      let next: Message[];
      if (rows.length === 0) {
        setIsNewRoom(true);
        const pending = prev.filter(
          (m) => m.id.startsWith('temp-') || m.id.startsWith('stream-'),
        );
        if (pending.length) {
          next = dedupeMessages(pending);
        } else if (prev.some((m) => m.id !== 'greeting' && m.content.trim())) {
          next = dedupeMessages(prev);
        } else {
          next = [
            {
              id: 'greeting',
              conversation_id: convId,
              sender: 'ai',
              content: GREETING,
              created_at: new Date().toISOString(),
            },
          ];
        }
      } else {
        setIsNewRoom(false);
        const suppressAiId = streamActiveRef.current
          ? persistedTurnRef.current?.aiId ?? null
          : null;
        next = mergeFetchedWithPending(prev, rows, {
          suppressAiMessageId: suppressAiId,
        });
      }

      applyMessages(next);
      setLoading(false);
    })();

    return () => { active = false; };
  }, [user, currentConversation?.id, currentScreen, applyMessages, setCurrentScreen]);

  useEffect(() => {
    chatScrollInitRef.current = null;
  }, [currentConversation?.id]);

  // Snap to bottom before paint when opening a conversation (no animated jump).
  useLayoutEffect(() => {
    const convId = currentConversation?.id;
    if (loading || !convId || roomMessages.length === 0) return;
    if (chatScrollInitRef.current === convId) return;
    chatScrollInitRef.current = convId;
    snapScrollToBottom();
  }, [loading, currentConversation?.id, roomMessages.length, snapScrollToBottom]);

  useEffect(() => {
    if (inputValue.trim() && guidedOpen) setGuidedOpen(false);
  }, [inputValue]);

  useEffect(() => {
    return () => {
      if (streamTimerRef.current) clearTimeout(streamTimerRef.current);
      if (captureNudgeTimerRef.current) clearTimeout(captureNudgeTimerRef.current);
      syncMessagesToApp();
      // Do not abort in-flight AI — user may open notes/memory mid-reply; send finishes in background.
    };
  }, [syncMessagesToApp]);

  useEffect(() => {
    if (captureNudgeTimerRef.current) clearTimeout(captureNudgeTimerRef.current);
    if (!captureNudge) return;
    const ms = captureNudge.kind === 'memory_saved' ? 3500 : 8000;
    captureNudgeTimerRef.current = setTimeout(() => setCaptureNudge(null), ms);
    return () => {
      if (captureNudgeTimerRef.current) clearTimeout(captureNudgeTimerRef.current);
    };
  }, [captureNudge]);

  /** New message or typing — user stays in dialogue, hide nudge. */
  useEffect(() => {
    if (!captureNudge || !inputValue.trim()) return;
    setCaptureNudge(null);
  }, [inputValue, captureNudge]);

  const dismissCaptureNudge = useCallback(() => {
    setCaptureNudge(null);
  }, []);

  const openNotesFromNudge = useCallback(
    (snippet: string, kind: SelfNoteKind = 'insight') => {
      setNotesCaptureLaunch({ draft: snippet, kind });
      setCaptureNudge(null);
      leaveChatFor('conversation-notes');
    },
    [setNotesCaptureLaunch, leaveChatFor],
  );

  const isPendingTurnMessage = useCallback((id: string) => {
    return id.startsWith('temp-') || id.startsWith('stream-');
  }, []);

  const cancelActiveGeneration = useCallback(() => {
    generationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    setStream(EMPTY_STREAM);
  }, []);

  const restoreDraftToInput = useCallback((draft: string) => {
    setInputValue(draft);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
      const len = draft.length;
      el.setSelectionRange(len, len);
    });
  }, []);

  const rollbackPersistedTurn = useCallback(async () => {
    const ids = persistedTurnRef.current;
    persistedTurnRef.current = null;
    if (!ids) return;
    const toDelete = [ids.userId, ids.aiId].filter(Boolean) as string[];
    await Promise.all(toDelete.map((id) => deleteChatMessage(id)));
  }, []);

  const handleStop = useCallback(() => {
    const draft = pendingDraftRef.current;
    const persisted = persistedTurnRef.current;
    cancelActiveGeneration();
    void rollbackPersistedTurn();
    patchMessages((prev) => {
      const drop = new Set<string>();
      if (persisted?.userId) drop.add(persisted.userId);
      if (persisted?.aiId) drop.add(persisted.aiId);
      return prev.filter(
        (m) => !isPendingTurnMessage(m.id) && !drop.has(m.id),
      );
    });
    if (draft) restoreDraftToInput(draft);
    pendingDraftRef.current = '';
    pendingTurnRef.current = null;
    setSendError(null);
    setSending(false);
    sendLockRef.current = false;
  }, [
    cancelActiveGeneration,
    patchMessages,
    isPendingTurnMessage,
    restoreDraftToInput,
    rollbackPersistedTurn,
  ]);

  // ── Data fetchers ──────────────────────────────────────────────────────────────

  async function fetchOrCreateDefaultRoom() {
    const { data: existing } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', user!.id)
      .eq('is_active', true)
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      setCurrentConversation(existing);
    } else {
      await createFreshRoom();
    }
  }

  async function createFreshRoom() {
    const { data: newRoom } = await supabase
      .from('conversations')
      .insert({ user_id: user!.id, title: '' })
      .select()
      .maybeSingle();
    if (newRoom) {
      setCurrentConversation(newRoom);
      setIsNewRoom(true);
      setMessages([{
        id: 'greeting',
        conversation_id: newRoom.id,
        sender: 'ai',
        content: GREETING,
        created_at: new Date().toISOString(),
      }]);
    }
    setLoading(false);
  }

  function commitAssistantReply(finalMsg: Message, epoch: number) {
    if (epoch !== generationEpochRef.current) return;
    setStream(EMPTY_STREAM);
    streamActiveRef.current = false;
    patchMessages((prev) =>
      dedupeMessages([...prev.filter((m) => m.id !== finalMsg.id), finalMsg]),
    );
    persistedTurnRef.current = null;
    followTailAfterPaint();
  }

  function revealAssistantReply(displayText: string, finalMsg: Message, epoch: number) {
    const steps = buildRevealSteps(displayText);
    const streamId = `stream-${Date.now()}`;

    streamActiveRef.current = true;
    setStream({ isStreaming: true, streamingId: streamId, revealedText: '' });

    const runStep = (index: number) => {
      if (epoch !== generationEpochRef.current) return;

      const isLast = index >= steps.length - 1;
      const revealedText = steps[index] ?? displayText;

      setStream((prev) =>
        prev.streamingId === streamId ? { ...prev, revealedText } : prev,
      );

      if (isLast) {
        followTailAfterPaint();
        streamTimerRef.current = setTimeout(() => {
          commitAssistantReply(finalMsg, epoch);
        }, 100);
        return;
      }

      streamTimerRef.current = setTimeout(
        () => runStep(index + 1),
        computeChunkPause(revealedText),
      );
    };

    const waitMs = steps.length <= 1 ? 400 : computeInitialDelay(displayText);
    streamTimerRef.current = setTimeout(() => runStep(0), waitMs);
  }

  // ── Send handler ───────────────────────────────────────────────────────────────

  async function handleSend() {
    if (!inputValue.trim() || sending || sendLockRef.current || !user || !currentConversation) {
      return;
    }
    const convId = currentConversation.id;
    const content = inputValue.trim();
    const turnId = resolveTurnId(pendingTurnRef.current, content);
    pendingTurnRef.current = { turnId, content };
    const epoch = ++generationEpochRef.current;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    pendingDraftRef.current = content;
    setSendError(null);
    setCaptureNudge(null);
    setInputValue('');
    setSending(true);
    sendLockRef.current = true;
    setGuidedOpen(false);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    const tempId = `temp-${turnId}`;
    const tempMsg: Message = {
      id: tempId,
      conversation_id: convId,
      sender: 'user',
      content,
      created_at: new Date().toISOString(),
      client_message_id: turnId,
    };
    scrollFollowRef.current = true;
    patchMessages((prev) => [...prev.filter((m) => m.id !== 'greeting'), tempMsg]);
    followTailAfterPaint();

    const failSend = (userMessage: string) => {
      if (epoch !== generationEpochRef.current) return;
      setSendError(userMessage);
      patchMessages((prev) => prev.filter((m) => m.id !== tempId));
      restoreDraftToInput(content);
    };

    const userCapture = detectUserCaptureIntent(content);
    let notesNudgeFromUser = false;

    if (userCapture?.action === 'dialog_memory') {
      const memoryContext = roomMessagesRef.current
        .filter(
          (m) =>
            m.id !== 'greeting' &&
            !m.id.startsWith('stream-') &&
            m.content.trim(),
        )
        .map((m) => ({ sender: m.sender, content: m.content }));
      const memoryPayload = resolveMemoryPayloadFromChat(content, memoryContext);

      void appendToConversationMemory(convId, user.id, memoryPayload).then(
        ({ ok }) => {
          if (!ok || epoch !== generationEpochRef.current) return;
          const key = nudgeDedupeKey('memory', memoryPayload);
          if (lastCaptureNudgeKeyRef.current === key) return;
          lastCaptureNudgeKeyRef.current = key;
          setCaptureNudge({ kind: 'memory_saved', snippet: memoryPayload });
        },
      );
    } else if (userCapture?.action === 'notes') {
      const key = nudgeDedupeKey('notes', userCapture.payload);
      if (lastCaptureNudgeKeyRef.current !== key) {
        lastCaptureNudgeKeyRef.current = key;
        notesNudgeFromUser = true;
        setCaptureNudge({
          kind: 'notes',
          snippet: userCapture.payload,
          source: 'user',
        });
      }
    }

    try {
      const persistedTurn = await fetchTurnMessages(convId, turnId);
      if (epoch !== generationEpochRef.current) return;

      let aiText: string;

      if (persistedTurn.ai?.content?.trim()) {
        aiText = prepareAiDisplayText(persistedTurn.ai.content);
      } else {
        const timeGap = buildClientTimeGap(roomMessages);

        const aiResult = await sendAiMessage({
          message: content,
          conversationId: convId,
          userId: user.id,
          requestId: turnId,
          timeGap,
          signal: abortController.signal,
        });

        if (epoch !== generationEpochRef.current) return;

        if (!isAiSendSuccess(aiResult)) {
          failSend(
            aiResult.userMessage ??
              'Сейчас не могу ответить. Попробуй ещё раз.',
          );
          return;
        }

        aiText = prepareAiDisplayText(aiResult.content);
      }

      if (!notesNudgeFromUser && detectAiNotesNudge(aiText)) {
        const draft = notesDraftFromContext(content, aiText);
        const key = nudgeDedupeKey('notes-ai', draft);
        if (lastCaptureNudgeKeyRef.current !== key) {
          lastCaptureNudgeKeyRef.current = key;
          setCaptureNudge({ kind: 'notes', snippet: draft, source: 'ai' });
        }
      }

      if (isNewRoom) {
        const title = generateTitle(content);
        await supabase.from('conversations').update({ title }).eq('id', convId);
        setCurrentConversation({ ...currentConversation, title });
        setIsNewRoom(false);
      }

      const now = new Date().toISOString();
      const turnOpts = { userId: user.id, clientMessageId: turnId };

      const { message: savedUserRow, error: userSaveErr } = await insertChatMessage(
        convId,
        'user',
        content,
        turnOpts,
      );
      if (userSaveErr) {
        console.error('[chat] user message not saved:', userSaveErr);
      }

      const { message: aiSavedRow, error: aiSaveErr } = await insertChatMessage(
        convId,
        'ai',
        aiText,
        turnOpts,
      );
      if (aiSaveErr) {
        console.error('[chat] ai message not saved:', aiSaveErr);
      }

      persistedTurnRef.current = {
        userId: savedUserRow?.id,
        aiId: aiSavedRow?.id,
      };

      if (epoch !== generationEpochRef.current) {
        await rollbackPersistedTurn();
        return;
      }

      await supabase
        .from('conversations')
        .update({ last_message_at: now })
        .eq('id', convId);

      pendingDraftRef.current = '';
      pendingTurnRef.current = null;
      setSendError(null);
      abortControllerRef.current = null;

      const savedUser: Message =
        savedUserRow ??
        persistedTurn.user ?? {
          ...tempMsg,
          id: `user-${Date.now()}`,
        };
      const userTs = new Date(savedUser.created_at).getTime();
      const streamCreatedAt = new Date(Math.max(userTs + 1, Date.now())).toISOString();
      const finalAiMsg: Message =
        aiSavedRow ??
        persistedTurn.ai ?? {
          id: `ai-${Date.now()}`,
          conversation_id: convId,
          sender: 'ai',
          content: aiText,
          created_at: streamCreatedAt,
          client_message_id: turnId,
        };

      scrollFollowRef.current = true;

      patchMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId && m.id !== 'greeting'),
        savedUser,
      ]);
      followTailAfterPaint();

      if (shouldAnimateReveal(aiText)) {
        revealAssistantReply(aiText, finalAiMsg, epoch);
      } else {
        setStream({
          isStreaming: true,
          streamingId: `stream-${Date.now()}`,
          revealedText: '',
        });
        streamTimerRef.current = setTimeout(() => {
          if (epoch !== generationEpochRef.current) return;
          commitAssistantReply(finalAiMsg, epoch);
        }, 420);
      }
    } catch (err) {
      if (isAiRequestAborted(err) || epoch !== generationEpochRef.current) {
        return;
      }
      console.error('[chat] send failed:', err);
      failSend('Сейчас не могу ответить. Попробуй ещё раз.');
    } finally {
      if (epoch === generationEpochRef.current) {
        setSending(false);
        sendLockRef.current = false;
        abortControllerRef.current = null;
      }
    }
  }

  function handleKeyPress(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleInputChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setInputValue(e.target.value);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  }

  function insertGuidedPhrase(phrase: string) {
    setInputValue(phrase);
    setGuidedOpen(false);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.style.height = 'auto';
        inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
      }
    });
  }

  const roomTitle = currentConversation?.title || 'Новая беседа';
  const isWaiting = sending && !stream.isStreaming;
  const suppressAiMessageId =
    stream.isStreaming ? persistedTurnRef.current?.aiId ?? null : null;
  const visibleMessages = suppressAiMessageId
    ? roomMessages.filter((m) => m.id !== suppressAiMessageId)
    : roomMessages;

  if (loading && roomMessages.length === 0) {
    return (
      <div className={`h-[100dvh] ${theme.bg} flex items-center justify-center`}>
        <div className={`w-5 h-5 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
      </div>
    );
  }

  return (
    <div className={`h-[100dvh] flex flex-col overflow-hidden ${theme.bg}`}>

      {/* ── Top nav ───────────────────────────────────────────────────────────── */}
      <div
        className="shrink-0 z-20"
        style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        <div
          className="absolute inset-0"
          style={{ background: `linear-gradient(to bottom, ${theme.bgHex}fa, ${theme.bgHex}b8)` }}
        />
        <div className={`relative pt-6 pb-3 flex items-center gap-3 ${LAYOUT_CONTAINER_CLASS}`}>
          <button
            onClick={() => navigateBack()}
            className={`${theme.textSecondary} transition-opacity duration-200 opacity-80 hover:opacity-100 text-xl leading-none w-8 h-8 flex items-center justify-center shrink-0`}
          >
            ←
          </button>
          <span className={`${theme.textSecondary} text-xs font-light tracking-[0.12em] truncate opacity-85 flex-1 min-w-0`}>
            {roomTitle}
          </span>
          <button
            type="button"
            onClick={() => leaveChatFor('memory')}
            className={`shrink-0 p-2 rounded-lg transition-opacity duration-300 opacity-70 hover:opacity-100 ${theme.surfaceHover}`}
            aria-label="Память беседы"
            title="Память беседы"
          >
            <Brain
              className={`w-4 h-4 transition-colors duration-300 ${
                captureNudge?.kind === 'memory_saved' ? 'text-[#c9a96e]/90' : theme.textSecondary
              }`}
              strokeWidth={1.5}
            />
          </button>
          <button
            type="button"
            onClick={() => leaveChatFor('conversation-dynamics')}
            disabled={!currentConversation?.id}
            className={`shrink-0 p-2 rounded-lg transition-opacity duration-300 opacity-70 hover:opacity-100 disabled:opacity-30 ${theme.surfaceHover}`}
            aria-label={DYNAMICS_COPY.title}
            title={DYNAMICS_COPY.title}
          >
            <Activity className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (captureNudge?.kind === 'notes') {
                openNotesFromNudge(captureNudge.snippet);
                return;
              }
              leaveChatFor('conversation-notes');
            }}
            disabled={!currentConversation?.id}
            className={`shrink-0 p-2 rounded-lg transition-all duration-300 disabled:opacity-30 ${
              captureNudge?.kind === 'notes'
                ? 'opacity-100 ring-1 ring-[#c9a96e]/40 bg-[#c9a96e]/10'
                : 'opacity-70 hover:opacity-100'
            } ${theme.surfaceHover}`}
            aria-label={REFLECTION_COPY.openAria}
            title={
              captureNudge?.kind === 'notes'
                ? CAPTURE_NUDGE_COPY.notesTitle
                : REFLECTION_COPY.title
            }
          >
            <Feather
              className={`w-4 h-4 transition-colors duration-300 ${
                captureNudge?.kind === 'notes' ? 'text-[#c9a96e]' : theme.textSecondary
              }`}
              strokeWidth={1.5}
            />
          </button>
        </div>
        <div className={`relative h-px ${LAYOUT_CONTAINER_CLASS}`}>
          <div className={`h-px ${theme.divider} opacity-25`} />
        </div>
      </div>

      {/* ── Messages ──────────────────────────────────────────────────────────── */}
      <div
        ref={messagesScrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-hide"
      >
        <div
          className={`${LAYOUT_CONTAINER_CLASS} py-4 space-y-5`}
          style={{ paddingBottom: composerPadPx }}
        >
          {visibleMessages.map((msg, index) => (
            <MessageRow
              key={msg.id}
              msg={msg}
              theme={theme}
              index={index}
              animateEnter={index >= visibleMessages.length - 2}
            />
          ))}

          {stream.isStreaming && stream.streamingId && (
            <StreamingMessage
              revealedText={stream.revealedText}
              theme={theme}
              isWaiting={!stream.revealedText}
            />
          )}

          {isWaiting && (
            <div className="pt-1">
              <PresenceIndicator theme={theme} />
            </div>
          )}

          <div ref={messagesEndRef} className="h-1" aria-hidden />
        </div>
      </div>

      {/* ── Input bar ─────────────────────────────────────────────────────────── */}
      <div
        ref={inputBarRef}
        className="shrink-0 z-20 relative"
      >
        {captureNudge && (
          <div
            className={`absolute left-0 right-0 bottom-full z-30 pb-2 pointer-events-none ${LAYOUT_CONTAINER_CLASS}`}
          >
            <div className="pointer-events-auto">
              <CaptureNudgePanel
                nudge={captureNudge}
                theme={theme}
                onDismiss={dismissCaptureNudge}
                onOpenNotes={(snippet) => openNotesFromNudge(snippet)}
                onOpenMemory={() => {
                  dismissCaptureNudge();
                  leaveChatFor('memory');
                }}
              />
            </div>
          </div>
        )}

        {/* Gradient fade from transparent to bg — masks messages scrolling under */}
        <div
          className={`absolute bottom-full left-0 right-0 pointer-events-none transition-[height] duration-300 ${
            captureNudge ? 'h-16' : 'h-10'
          }`}
          style={{
            background: `linear-gradient(to top, ${theme.bgHex}, transparent)`,
          }}
        />

        <div
          className={`${theme.bg} border-t ${theme.border} border-opacity-30`}
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          <div className={`${LAYOUT_CONTAINER_CLASS} py-3 pb-safe`}>

            {/* Guided prompt panel */}
            <div
              className={`overflow-hidden transition-all duration-300 ease-in-out ${
                guidedOpen ? 'max-h-64 opacity-100 mb-3' : 'max-h-0 opacity-0'
              }`}
            >
              <div className={`rounded-xl border ${theme.border} ${theme.surface} p-4`}>
                <div className="flex items-center justify-between mb-3">
                  <p className={`${theme.textMuted} text-xs font-light tracking-wide`}>
                    Выберите, с чего начать
                  </p>
                  <button onClick={() => setGuidedOpen(false)} className={`${theme.textMuted}`}>
                    <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {GUIDED_CATEGORIES.map((cat) => (
                    <button
                      key={cat.label}
                      onClick={() => insertGuidedPhrase(cat.phrase)}
                      className={`text-left px-3 py-2.5 rounded-lg border transition-all duration-150 ${theme.border} ${theme.surfaceHover} active:scale-[0.98]`}
                    >
                      <p className={`${theme.textSecondary} text-xs font-light leading-snug`}>
                        {cat.label}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* "Don't know where to start" hint */}
            {isEmptyConversation && !guidedOpen && !inputValue && (
              <div className="flex justify-center mb-2.5">
                <button
                  onClick={() => setGuidedOpen(true)}
                  className={`${theme.textMuted} text-xs font-light opacity-50 hover:opacity-80 transition-opacity duration-200`}
                >
                  Не знаю, с чего начать
                </button>
              </div>
            )}

            {sendError && (
              <p className={`text-xs font-light mb-2 px-1 ${theme.textMuted}`} role="status">
                {sendError}
              </p>
            )}

            {/* Input field */}
            <div className={`flex items-end gap-3 rounded-xl px-4 py-3 border transition-colors duration-200 ${theme.inputBg} ${theme.inputBorder}`}>
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyPress}
                placeholder="Напишите как есть…"
                rows={1}
                className={`chat-compose-input flex-1 bg-transparent outline-none resize-none font-light text-[15px] leading-relaxed ${theme.inputText} ${theme.inputPlaceholder}`}
                style={{ maxHeight: '120px' }}
              />
              {sending ? (
                <button
                  type="button"
                  onClick={handleStop}
                  aria-label="Остановить ответ"
                  className={`shrink-0 p-1.5 rounded-lg transition-all duration-200 border border-[#c9a96e]/25 bg-[#c9a96e]/8 hover:bg-[#c9a96e]/14`}
                >
                  <Square
                    className="w-3.5 h-3.5 text-[#c9a96e]/85"
                    strokeWidth={1.5}
                    fill="currentColor"
                  />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  aria-label="Отправить"
                  className={`shrink-0 p-1.5 rounded-lg transition-all duration-200 disabled:opacity-20 ${theme.surface} ${theme.surfaceHover}`}
                >
                  <Send className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
                </button>
              )}
            </div>

          </div>
        </div>
      </div>

    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MessageRow({
  msg,
  theme,
  index,
  animateEnter = false,
}: {
  msg: Message;
  theme: ReturnType<typeof useTheme>['theme'];
  index: number;
  animateEnter?: boolean;
}) {
  if (!msg.content) return null;
  const isUser = msg.sender === 'user';
  const delay = Math.min(index * 12, 100);
  const enterClass = animateEnter ? 'animate-msg-in' : '';

  if (isUser) {
    return (
      <div
        className={`flex justify-end ${enterClass}`}
        style={animateEnter ? { animationDelay: `${delay}ms` } : undefined}
      >
        <div className={`max-w-[70%] px-5 py-3 rounded-2xl rounded-tr-sm ${theme.msgUserBg}`}>
          <p className={`${theme.msgUserText} font-light text-[15px] leading-[1.8] whitespace-pre-wrap break-words`}>
            {msg.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={enterClass}
      style={animateEnter ? { animationDelay: `${delay}ms` } : undefined}
    >
      <div className="text-[15px] break-words">
        {renderAiMessageBody(msg.content, aiMessageStyle(theme))}
      </div>
    </div>
  );
}

function aiMessageStyle(theme: ReturnType<typeof useTheme>['theme']) {
  return { baseTextClass: contextBodyTextClass(theme) };
}

function StreamingMessage({
  revealedText,
  theme,
  isWaiting,
}: {
  revealedText: string;
  theme: ReturnType<typeof useTheme>['theme'];
  isWaiting: boolean;
}) {
  if (isWaiting) {
    return (
      <div className="pt-1">
        <PresenceIndicator theme={theme} />
      </div>
    );
  }

  return (
    <div className="text-[15px] break-words min-h-[1.5rem]">
      {renderAiMessageBody(revealedText, aiMessageStyle(theme), { prepared: true })}
      <span
        className={`inline-block w-[1px] h-[13px] ml-[1px] -mt-1 align-middle animate-cursor-blink rounded-sm opacity-50 ${theme.textMuted}`}
      />
    </div>
  );
}

/** Floating card above the input bar — visible, one-tap dismiss or action. */
function CaptureNudgePanel({
  nudge,
  theme,
  onDismiss,
  onOpenNotes,
  onOpenMemory,
}: {
  nudge:
    | { kind: 'notes'; snippet: string; source: NotesCaptureSource }
    | { kind: 'memory_saved'; snippet: string };
  theme: ReturnType<typeof useTheme>['theme'];
  onDismiss: () => void;
  onOpenNotes: (snippet: string) => void;
  onOpenMemory: () => void;
}) {
  const isMemory = nudge.kind === 'memory_saved';
  const preview =
    !isMemory && nudge.snippet.trim().length > 0
      ? nudge.snippet.trim().slice(0, 120)
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-capture-chip-in rounded-2xl border border-[#c9a96e]/35 bg-[#c9a96e]/[0.14] px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.28)]"
      style={{
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5 w-8 h-8 rounded-full bg-[#c9a96e]/15 border border-[#c9a96e]/25 flex items-center justify-center">
          {isMemory ? (
            <Brain className="w-4 h-4 text-[#c9a96e]" strokeWidth={1.5} />
          ) : (
            <Feather className="w-4 h-4 text-[#c9a96e]" strokeWidth={1.5} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className={`${theme.textPrimary} text-sm font-light leading-snug`}>
            {isMemory ? CAPTURE_NUDGE_COPY.memorySaved : CAPTURE_NUDGE_COPY.notesTitle}
          </p>
          {!isMemory && (
            <p className={`${theme.textMuted} text-xs font-light mt-0.5`}>
              {CAPTURE_NUDGE_COPY.notesHint}
            </p>
          )}
          {preview && (
            <p className={`${theme.textSecondary} text-xs font-light mt-2 leading-relaxed line-clamp-2`}>
              {preview}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label={CAPTURE_NUDGE_COPY.dismissAria}
          className={`shrink-0 p-2 -mr-1 -mt-0.5 rounded-lg ${theme.textMuted} opacity-60 hover:opacity-100 transition-opacity`}
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex items-center gap-2 mt-3 pl-11">
        {isMemory ? (
          <button
            type="button"
            onClick={onOpenMemory}
            className={`text-xs font-light px-3 py-1.5 rounded-lg border ${theme.border} ${theme.surface} ${theme.textSecondary} hover:opacity-100 opacity-90`}
          >
            {CAPTURE_NUDGE_COPY.memoryOpen}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onOpenNotes(nudge.snippet)}
            className={`text-xs font-light px-4 py-2 rounded-lg border border-[#c9a96e]/40 bg-[#c9a96e]/25 ${theme.btnText} hover:bg-[#c9a96e]/35 transition-colors`}
          >
            {CAPTURE_NUDGE_COPY.notesAction}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className={`text-xs font-light px-2 py-1.5 ${theme.textMuted} opacity-70 hover:opacity-100`}
        >
          Не сейчас
        </button>
      </div>
    </div>
  );
}

// Calm presence indicator — a single soft line, slow breathe
function PresenceIndicator({ theme }: { theme: ReturnType<typeof useTheme>['theme'] }) {
  return (
    <div className="h-5 flex items-center pl-0.5">
      <span className={`block h-px w-7 rounded-full ${theme.divider} animate-presence`} />
    </div>
  );
}
